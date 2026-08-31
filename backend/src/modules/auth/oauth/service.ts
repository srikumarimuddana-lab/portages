/**
 * OAuth sign-in and account linking.
 *
 * The flow, and where each defence sits:
 *
 *   start()     mints state + PKCE verifier + nonce, stores them server-side,
 *               returns the provider's authorize URL
 *   callback()  consumes the state row ATOMICALLY (single-use — this is what
 *               stops an authorization code being replayed), exchanges the
 *               code using the stored verifier, verifies the id_token against
 *               the provider JWKS, then applies the linking rules
 *
 * Nothing here decides account-linking policy: that lives in linking.ts as
 * pure logic so it can be tested exhaustively. This file does IO.
 */
import { verifyIdToken, isEmailVerified, JwksCache, JwtError } from '../../../lib/jwt.js';
import { createAuthRequest, buildAuthorizeUrl, safeRedirectPath } from './pkce.js';
import { providerFor, type ProviderConfig } from './providers.js';
import { decideLink, explainBlock, type LinkContext, type ProviderIdentity } from './linking.js';
import { badRequest, forbidden, AppError } from '../../../lib/errors.js';
import type { Sql } from '../../../db/pool.js';

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthConfig {
  /** Credentials per provider id. A provider absent here is disabled. */
  credentials: Record<string, OAuthClientCredentials>;
  /** Public origin used to build the redirect_uri, e.g. https://portage.ca */
  publicOrigin: string;
  fetchImpl?: typeof fetch;
}

export interface StartResult {
  authorizeUrl: string;
  state: string;
}

export type CallbackOutcome =
  | { kind: 'signed_in'; userId: string; redirectPath: string; isNewUser: boolean }
  | { kind: 'needs_proof'; userId: string; message: string; redirectPath: string };

interface AuthRequestRow {
  state: string;
  provider: string;
  code_verifier: string;
  nonce: string;
  redirect_path: string;
  linking_user_id: string | null;
  expires_at: Date;
}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

export class OAuthService {
  readonly #db: Sql;
  readonly #cfg: OAuthConfig;
  readonly #fetch: typeof fetch;
  readonly #jwks = new Map<string, JwksCache>();

  constructor(db: Sql, cfg: OAuthConfig) {
    this.#db = db;
    this.#cfg = cfg;
    this.#fetch = cfg.fetchImpl ?? fetch;
  }

  isEnabled(providerId: string): boolean {
    return Boolean(this.#cfg.credentials[providerId]);
  }

  redirectUriFor(providerId: string): string {
    return `${this.#cfg.publicOrigin}/api/auth/oauth/${providerId}/callback`;
  }

  /** Begins an authorization request. */
  async start(
    providerId: string,
    opts: { redirectPath?: string | undefined; linkingUserId?: string | undefined } = {},
  ): Promise<StartResult> {
    const provider = this.#requireProvider(providerId);
    const creds = this.#requireCredentials(providerId);
    const m = createAuthRequest();
    const redirectPath = safeRedirectPath(opts.redirectPath);

    await this.#db.query(
      `INSERT INTO oauth_auth_requests
         (state, provider, code_verifier, nonce, redirect_path, linking_user_id, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.state, provider.id, m.codeVerifier, m.nonce, redirectPath, opts.linkingUserId ?? null, m.expiresAt],
    );

    return {
      state: m.state,
      authorizeUrl: buildAuthorizeUrl({
        authorizeUrl: provider.authorizeUrl,
        clientId: creds.clientId,
        redirectUri: this.redirectUriFor(provider.id),
        scope: provider.scope,
        state: m.state,
        codeChallenge: m.codeChallenge,
        nonce: m.nonce,
      }),
    };
  }

  /**
   * Completes an authorization. `stateFromCookie` is the browser-bound copy;
   * requiring it to match the query parameter means an attacker cannot feed
   * their own authorization code into a victim's session.
   */
  async callback(
    providerId: string,
    params: { code: string; state: string; stateFromCookie?: string | undefined },
    ctx: { ip?: string | undefined; userAgent?: string | undefined } = {},
  ): Promise<CallbackOutcome> {
    const provider = this.#requireProvider(providerId);

    if (params.stateFromCookie !== undefined && params.stateFromCookie !== params.state) {
      throw forbidden('Login session did not match. Start again.');
    }

    const request = await this.#consumeAuthRequest(params.state, provider.id);
    const identity = await this.#resolveIdentity(provider, params.code, request);

    return this.#db.transaction(async (tx) => {
      const linkCtx = await this.#buildLinkContext(tx, identity, request.linking_user_id);
      const decision = decideLink(linkCtx);

      switch (decision.action) {
        case 'sign_in': {
          await this.#touchIdentity(tx, provider.id, identity.providerUserId);
          return {
            kind: 'signed_in' as const,
            userId: decision.userId,
            redirectPath: request.redirect_path,
            isNewUser: false,
          };
        }
        case 'link_to_existing': {
          await this.#insertIdentity(tx, decision.userId, identity);
          return {
            kind: 'signed_in' as const,
            userId: decision.userId,
            redirectPath: request.redirect_path,
            isNewUser: false,
          };
        }
        case 'create_account': {
          const userId = await this.#createUser(tx, identity);
          await this.#insertIdentity(tx, userId, identity);
          return {
            kind: 'signed_in' as const,
            userId,
            redirectPath: request.redirect_path,
            isNewUser: true,
          };
        }
        case 'require_proof':
          return {
            kind: 'needs_proof' as const,
            userId: decision.userId,
            message: explainBlock(decision.reason),
            redirectPath: request.redirect_path,
          };
        case 'reject':
          throw new AppError(403, 'oauth_rejected', explainBlock(decision.reason));
      }
    });
  }

  /**
   * Consumes the state row. The UPDATE ... WHERE consumed_at IS NULL makes
   * this single-use even under concurrent callbacks: exactly one caller gets
   * the row back.
   */
  async #consumeAuthRequest(state: string, providerId: string): Promise<AuthRequestRow> {
    const { rows } = await this.#db.query<AuthRequestRow>(
      `UPDATE oauth_auth_requests
          SET consumed_at = now()
        WHERE state = $1 AND provider = $2 AND consumed_at IS NULL
        RETURNING state, provider, code_verifier, nonce, redirect_path,
                  linking_user_id, expires_at`,
      [state, providerId],
    );
    const row = rows[0];
    // Unknown, already-used and wrong-provider states are all reported the
    // same way: an attacker learns nothing from the error.
    if (!row) throw forbidden('This login link is no longer valid. Start again.');
    if (row.expires_at.getTime() < Date.now()) {
      throw forbidden('This login link expired. Start again.');
    }
    return row;
  }

  /** Exchanges the code and turns the provider's response into an identity. */
  async #resolveIdentity(
    provider: ProviderConfig,
    code: string,
    request: AuthRequestRow,
  ): Promise<ProviderIdentity> {
    const tokens = await this.#exchangeCode(provider, code, request.code_verifier);

    if (tokens.id_token) {
      const creds = this.#requireCredentials(provider.id);
      const jwks = await this.#jwksFor(provider).get(kidOf(tokens.id_token));
      let claims;
      try {
        claims = verifyIdToken(tokens.id_token, jwks, {
          issuer: provider.issuer,
          audience: creds.clientId,
          nonce: request.nonce,
        });
      } catch (err) {
        if (err instanceof JwtError) {
          throw forbidden('Could not verify the response from your provider.');
        }
        throw err;
      }
      return {
        provider: provider.id,
        providerUserId: claims.sub,
        email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
        emailVerified: isEmailVerified(claims),
      };
    }

    // Facebook may omit id_token. Fall back to the userinfo endpoint — and
    // treat the email as UNVERIFIED, because that endpoint asserts nothing
    // about verification. linking.ts then refuses to auto-link it.
    if (provider.userInfoUrl && tokens.access_token) {
      const res = await this.#fetch(
        `${provider.userInfoUrl}&access_token=${encodeURIComponent(tokens.access_token)}`,
        { headers: { accept: 'application/json' } },
      );
      if (!res.ok) throw forbidden('Could not read your profile from the provider.');
      const profile = (await res.json()) as { id?: string; email?: string };
      if (!profile.id) throw forbidden('Provider did not identify your account.');
      return {
        provider: provider.id,
        providerUserId: profile.id,
        email: profile.email ? profile.email.toLowerCase() : null,
        emailVerified: false,
      };
    }

    throw forbidden('Provider did not return a usable identity.');
  }

  async #exchangeCode(
    provider: ProviderConfig,
    code: string,
    codeVerifier: string,
  ): Promise<TokenResponse> {
    const creds = this.#requireCredentials(provider.id);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUriFor(provider.id),
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      code_verifier: codeVerifier,
    });

    const res = await this.#fetch(provider.tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    } as never);

    const payload = (await res.json()) as TokenResponse;
    if (!res.ok || payload.error) {
      // The provider's error text can echo our request; never forward it.
      throw forbidden('Your provider rejected the sign-in. Please try again.');
    }
    return payload;
  }

  async #buildLinkContext(
    tx: Sql,
    identity: ProviderIdentity,
    linkingUserId: string | null,
  ): Promise<LinkContext> {
    const linked = await tx.query<{ user_id: string }>(
      'SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      [identity.provider, identity.providerUserId],
    );

    let emailMatch: LinkContext['emailMatch'] = null;
    if (identity.email) {
      const found = await tx.query<{ id: string; status: string; email_verified_at: Date | null }>(
        'SELECT id, status, email_verified_at FROM users WHERE email = $1',
        [identity.email],
      );
      const u = found.rows[0];
      if (u) {
        emailMatch = {
          userId: u.id,
          status: u.status as 'active' | 'suspended' | 'deleted',
          emailVerified: u.email_verified_at !== null,
        };
      }
    }

    return {
      identity,
      existingLink: linked.rows[0] ? { userId: linked.rows[0].user_id } : null,
      emailMatch,
      signedInUserId: linkingUserId ?? undefined,
    };
  }

  async #createUser(tx: Sql, identity: ProviderIdentity): Promise<string> {
    if (!identity.email) {
      // Every account needs a stable local identifier. Providers that supply
      // no email get a synthetic one that cannot collide with a real address.
      throw badRequest('Your provider did not share an email address.');
    }
    const created = await tx.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, $2, now())
       RETURNING id`,
      // No password: this account signs in through the provider. The sentinel
      // is not a valid scrypt encoding, so verifyPassword() can never match it.
      [identity.email, 'oauth-only-no-password'],
    );
    const userId = created.rows[0]!.id;
    await tx.query('INSERT INTO user_profiles(user_id) VALUES ($1)', [userId]);
    return userId;
  }

  async #insertIdentity(tx: Sql, userId: string, identity: ProviderIdentity): Promise<void> {
    await tx.query(
      `INSERT INTO oauth_identities
         (user_id, provider, provider_user_id, email, email_verified_at, last_login_at)
       VALUES ($1,$2,$3,$4,$5, now())`,
      [
        userId,
        identity.provider,
        identity.providerUserId,
        identity.email,
        identity.emailVerified ? new Date() : null,
      ],
    );
  }

  async #touchIdentity(tx: Sql, provider: string, providerUserId: string): Promise<void> {
    await tx.query(
      'UPDATE oauth_identities SET last_login_at = now() WHERE provider = $1 AND provider_user_id = $2',
      [provider, providerUserId],
    );
  }

  #jwksFor(provider: ProviderConfig): JwksCache {
    let cache = this.#jwks.get(provider.id);
    if (!cache) {
      cache = new JwksCache(provider.jwksUrl, { fetchImpl: this.#fetch });
      this.#jwks.set(provider.id, cache);
    }
    return cache;
  }

  #requireProvider(providerId: string): ProviderConfig {
    try {
      return providerFor(providerId);
    } catch {
      throw badRequest('Unknown sign-in provider.');
    }
  }

  #requireCredentials(providerId: string): OAuthClientCredentials {
    const creds = this.#cfg.credentials[providerId];
    if (!creds) throw badRequest(`Sign-in with ${providerId} is not enabled.`);
    return creds;
  }
}

/** Reads the `kid` from a JWT header without verifying anything. */
function kidOf(token: string): string | undefined {
  try {
    const header = JSON.parse(
      Buffer.from(token.split('.')[0] ?? '', 'base64url').toString('utf8'),
    ) as { kid?: string };
    return header.kid;
  } catch {
    return undefined;
  }
}

/** Deletes expired authorization requests. Run by the scheduled job runner. */
export async function sweepAuthRequests(db: Sql, limit = 5000): Promise<number> {
  const { rowCount } = await db.query(
    `DELETE FROM oauth_auth_requests
      WHERE state IN (
        SELECT state FROM oauth_auth_requests
         WHERE expires_at < now() - interval '1 hour'
         LIMIT $1
      )`,
    [limit],
  );
  return rowCount;
}
