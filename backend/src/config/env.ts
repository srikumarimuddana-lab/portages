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

  if (errors.length) {
    throw new Error(`Invalid environment configuration:\n  - ${errors.join('\n  - ')}`);
  }

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
    ...(mkPresent === 3
      ? { mapkit: { teamId: mkTeam!, keyId: mkKey!, privateKeyPem: mkPem!.replace(/\\n/g, '\n') } }
      : {}),
  });
}
