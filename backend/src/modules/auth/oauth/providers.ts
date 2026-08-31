/**
 * Provider configuration.
 *
 * Endpoints are pinned as constants rather than read from a discovery
 * document at runtime: discovery adds a network dependency to the login path
 * and one more thing an attacker could poison. Google's two issuer values are
 * both accepted because Google has historically emitted either.
 */
export interface ProviderConfig {
  readonly id: 'google' | 'facebook';
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly jwksUrl: string;
  readonly issuer: string | string[];
  readonly scope: string;
  readonly usesIdToken: boolean;
  readonly userInfoUrl?: string;
}

export const GOOGLE: ProviderConfig = {
  id: 'google',
  authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  issuer: ['https://accounts.google.com', 'accounts.google.com'],
  scope: 'openid email profile',
  usesIdToken: true,
};

export const FACEBOOK: ProviderConfig = {
  id: 'facebook',
  authorizeUrl: 'https://www.facebook.com/v21.0/dialog/oauth',
  tokenUrl: 'https://graph.facebook.com/v21.0/oauth/access_token',
  jwksUrl: 'https://www.facebook.com/.well-known/oauth/openid/jwks/',
  issuer: 'https://www.facebook.com',
  scope: 'email public_profile',
  usesIdToken: true,
  // Fallback when a token response carries no id_token. Facebook may also
  // return no email at all — linking.ts handles that case explicitly rather
  // than guessing.
  userInfoUrl: 'https://graph.facebook.com/me?fields=id,name,email',
};

export const PROVIDERS: Record<string, ProviderConfig> = {
  google: GOOGLE,
  facebook: FACEBOOK,
};

export function providerFor(id: string): ProviderConfig {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`unknown oauth provider: ${id}`);
  return p;
}
