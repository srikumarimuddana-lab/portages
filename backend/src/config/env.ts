/**
 * Environment configuration. Validated once at startup and then frozen.
 *
 * Two rules enforced here:
 *  1. Secrets have no defaults. A missing secret is a crash, not a silent
 *     fallback to a well-known development value.
 *  2. Production is checked harder than development: TLS-only cookies, a
 *     real database URL, and secrets of sufficient length.
 */
import * as v from '../lib/validate.js';

export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  storageSecret: string;
  pepper: string;
  allowedOrigins: string[];
  secureCookies: boolean;
  trustProxy: boolean;
  /** Apple MapKit JS credentials. Optional: absent means the map is disabled. */
  mapkit?: { teamId: string; keyId: string; privateKeyPem: string };
  /** OAuth client credentials per provider. A missing provider is disabled. */
  oauth: Record<string, { clientId: string; clientSecret: string }>;
  /** Public origin used for OAuth redirect URIs and post-login redirects. */
  publicOrigin: string;
  /** AWS credentials plus per-channel sender config. Absent = channel off. */
  aws?: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    sesFromAddress?: string | undefined;
    sesConfigurationSet?: string | undefined;
    smsOriginationIdentity?: string | undefined;
  };
  /**
   * S3-compatible object storage. Absent means uploads are disabled — which
   * is a coherent state, not a broken one: browsing and search work, and
   * anything that would store bytes reports the feature as unavailable.
   */
  storage?: {
    endpoint: string;
    bucket: string;
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** CDN or public bucket domain used for read URLs. */
    publicBaseUrl?: string | undefined;
  };
  /**
   * Vercel AI Gateway. Absent means every AI feature reports itself
   * unavailable and the site works exactly as it does today — the same
   * "absent is a coherent state" rule the storage and channel blocks follow.
   *
   * Credentials are all-or-nothing in the usual way, with one twist: the
   * Gateway accepts EITHER an explicit key or the OIDC token Vercel
   * provisions for a linked project, so either alone is enough.
   */
  ai?: {
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    /** Per task, so a cheap model can serve moderation and a strong one drafting. */
    models: { chatSearch: string; listingBuilder: string; moderation: string };
  };
}

const MIN_SECRET_LEN = 32;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const errors: string[] = [];

  const nodeEnv = (source['NODE_ENV'] ?? 'development') as Env['nodeEnv'];
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    errors.push('NODE_ENV must be development, test or production');
  }
  const isProd = nodeEnv === 'production';

  const port = Number(source['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('PORT must be a valid port');

  const databaseUrl = source['DATABASE_URL'] ?? '';
  if (!databaseUrl) errors.push('DATABASE_URL is required');
  else if (isProd && !/sslmode=require|sslmode=verify/.test(databaseUrl)) {
    errors.push('DATABASE_URL must require TLS in production (sslmode=require)');
  }

  const secret = (name: string): string => {
    const val = source[name] ?? '';
    if (!val) errors.push(`${name} is required`);
    else if (val.length < MIN_SECRET_LEN) {
      errors.push(`${name} must be at least ${MIN_SECRET_LEN} characters`);
    } else if (isProd && /^(dev|test|change|secret|password)/i.test(val)) {
      errors.push(`${name} looks like a placeholder; use a random value in production`);
    }
    return val;
  };

  const sessionSecret = secret('SESSION_SECRET');
  const storageSecret = secret('STORAGE_SIGNING_SECRET');
  const pepper = secret('PSEUDONYM_PEPPER');

  const originsRaw = source['ALLOWED_ORIGINS'] ?? '';
  const allowedOrigins = originsRaw.split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of allowedOrigins) {
    const r = v.string({ max: 253, pattern: /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i }).parse(o, 'ALLOWED_ORIGINS');
    if (!r.ok) errors.push(...r.errors);
    if (isProd && o.startsWith('http://')) {
      errors.push('ALLOWED_ORIGINS must use https in production');
    }
  }
  if (isProd && allowedOrigins.length === 0) {
    errors.push('ALLOWED_ORIGINS is required in production');
  }

  // MapKit is optional, but partially-configured is always a mistake — fail
  // loudly rather than silently serving a broken map.
  const mkTeam = source['MAPKIT_TEAM_ID'];
  const mkKey = source['MAPKIT_KEY_ID'];
  const mkPem = source['MAPKIT_PRIVATE_KEY'];
  const mkPresent = [mkTeam, mkKey, mkPem].filter(Boolean).length;
  if (mkPresent > 0 && mkPresent < 3) {
    errors.push('MAPKIT_TEAM_ID, MAPKIT_KEY_ID and MAPKIT_PRIVATE_KEY must all be set together');
  }
  if (mkPem && !mkPem.includes('BEGIN PRIVATE KEY')) {
    errors.push('MAPKIT_PRIVATE_KEY must be the PKCS#8 PEM contents of the .p8 file');
  }

  // OAuth: each provider is optional, but half-configured is always a
  // mistake — a redirect URI that 500s is worse than a hidden button.
  const oauth: Record<string, { clientId: string; clientSecret: string }> = {};
  for (const provider of ['google', 'facebook'] as const) {
    const idKey = `${provider.toUpperCase()}_CLIENT_ID`;
    const secretKey = `${provider.toUpperCase()}_CLIENT_SECRET`;
    const cid = source[idKey];
    const secret = source[secretKey];
    if (cid && secret) {
      oauth[provider] = { clientId: cid, clientSecret: secret };
    } else if (cid || secret) {
      errors.push(`${idKey} and ${secretKey} must be set together`);
    }
  }

  // The OAuth redirect_uri must be an exact, pre-registered absolute URL.
  const publicOrigin = source['PUBLIC_ORIGIN'] ?? allowedOrigins[0] ?? '';
  if (Object.keys(oauth).length > 0) {
    if (!publicOrigin) {
      errors.push('PUBLIC_ORIGIN is required when any OAuth provider is configured');
    } else if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(publicOrigin)) {
      errors.push('PUBLIC_ORIGIN must be an origin such as https://portage.ca');
    } else if (isProd && !publicOrigin.startsWith('https://')) {
      errors.push('PUBLIC_ORIGIN must use https in production');
    }
  }

  // AWS: credentials are all-or-nothing, and a channel is only enabled when
  // its own sender identity is present too. A configured-looking channel that
  // 500s on every send is worse than one that is visibly off.
  const awsKey = source['AWS_ACCESS_KEY_ID'];
  const awsSecret = source['AWS_SECRET_ACCESS_KEY'];
  const awsRegion = source['AWS_REGION'] ?? 'ca-central-1';
  let aws: Env['aws'];
  if (awsKey && awsSecret) {
    aws = {
      region: awsRegion,
      accessKeyId: awsKey,
      secretAccessKey: awsSecret,
      sesFromAddress: source['SES_FROM_ADDRESS'],
      sesConfigurationSet: source['SES_CONFIGURATION_SET'],
      smsOriginationIdentity: source['SMS_ORIGINATION_IDENTITY'],
    };
  } else if (awsKey || awsSecret) {
    errors.push('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together');
  }
  if (source['SES_FROM_ADDRESS'] && !awsKey) {
    errors.push('SES_FROM_ADDRESS requires AWS credentials');
  }

  // Object storage. All-or-nothing for the same reason as AWS above: a
  // half-configured bucket fails at the moment a user uploads a photo, which
  // is the worst possible time to discover it.
  const stEndpoint = source['STORAGE_ENDPOINT'];
  const stBucket = source['STORAGE_BUCKET'];
  const stKey = source['STORAGE_ACCESS_KEY_ID'];
  const stSecret = source['STORAGE_SECRET_ACCESS_KEY'];
  let storage: Env['storage'];
  const stParts = [stEndpoint, stBucket, stKey, stSecret];
  if (stParts.every(Boolean)) {
    // R2 uses the literal region `auto`; S3 wants the bucket's real region.
    storage = {
      endpoint: stEndpoint!.replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      bucket: stBucket!,
      region: source['STORAGE_REGION'] ?? 'auto',
      accessKeyId: stKey!,
      secretAccessKey: stSecret!,
      publicBaseUrl: source['STORAGE_PUBLIC_BASE_URL'],
    };
  } else if (stParts.some(Boolean)) {
    errors.push(
      'STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and ' +
      'STORAGE_SECRET_ACCESS_KEY must be set together',
    );
  }

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

  // ── AI ────────────────────────────────────────────────────────────────
  //
  // Model IDs are configuration, not code, because the Gateway makes them
  // interchangeable and because switching model at 3am must not need a build.
  // The defaults follow analysis/06: a cheap fast model for the high-volume
  // classification paths, a strong one where the output is read by a person.
  //
  // VERCEL_OIDC_TOKEN is read at REQUEST time, not here — it is short-lived
  // and the platform rotates it, so capturing it at boot produces 401s that a
  // redeploy appears to fix.
  const aiKey = source['AI_GATEWAY_API_KEY'];
  const hasOidc = Boolean(source['VERCEL_OIDC_TOKEN']);
  const ai = (aiKey || hasOidc)
    ? {
        ...(aiKey ? { apiKey: aiKey } : {}),
        ...(source['AI_GATEWAY_BASE_URL'] ? { baseUrl: source['AI_GATEWAY_BASE_URL'] } : {}),
        models: {
          chatSearch: source['AI_MODEL_CHAT_SEARCH'] ?? 'anthropic/claude-haiku-4-5',
          listingBuilder: source['AI_MODEL_LISTING_BUILDER'] ?? 'anthropic/claude-opus-5',
          moderation: source['AI_MODEL_MODERATION'] ?? 'anthropic/claude-haiku-4-5',
        },
      }
    : undefined;

  return Object.freeze({
    nodeEnv,
    port,
    databaseUrl,
    sessionSecret,
    storageSecret,
    pepper,
    allowedOrigins,
    // Cookies are Secure everywhere except plain local development.
    secureCookies: isProd || source['FORCE_SECURE_COOKIES'] === 'true',
    trustProxy: source['TRUST_PROXY'] === 'true',
    oauth,
    publicOrigin,
    ...(aws ? { aws } : {}),
    ...(storage ? { storage } : {}),
    ...(ai ? { ai } : {}),
    ...(mkPresent === 3
      ? { mapkit: { teamId: mkTeam!, keyId: mkKey!, privateKeyPem: mkPem!.replace(/\\n/g, '\n') } }
      : {}),
  });
}
