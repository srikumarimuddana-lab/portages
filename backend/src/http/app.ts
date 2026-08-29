/**
 * Composition root. Builds the shared dependencies once per process so
 * connection pools and rate-limit state are not recreated per request.
 *
 * On Vercel this module is imported by each route handler; the module cache
 * keeps a single instance alive per warm function instance.
 */
import { loadEnv, type Env } from '../config/env.js';
import { createPool, type Sql } from '../db/pool.js';
import { AuthService } from '../modules/auth/service.js';
import { DocumentService } from '../modules/documents/service.js';
import { LIMITS } from '../lib/ratelimit.js';
import { DurableRateLimiter } from '../lib/ratelimit-db.js';
import { MapKitTokenIssuer } from '../modules/maps/mapkit.js';
import { OAuthService } from '../modules/auth/oauth/service.js';
import type { GuardConfig } from './guard.js';

export interface App {
  env: Env;
  db: Sql;
  auth: AuthService;
  documents: DocumentService;
  /** Absent until the Apple MapKit keys are configured. */
  mapkit: MapKitTokenIssuer | null;
  oauth: OAuthService;
  cfg: GuardConfig;
  hsts: boolean;
  secureCookies: boolean;
}

let cached: Promise<App> | null = null;

export function getApp(): Promise<App> {
  cached ??= build();
  return cached;
}

async function build(): Promise<App> {
  const env = loadEnv();
  const db = await createPool(env.databaseUrl);
  const auth = new AuthService({ db, pepper: env.pepper });
  const documents = new DocumentService(db, env.storageSecret);
  const mapkit = env.mapkit ? new MapKitTokenIssuer(env.mapkit) : null;
  const oauth = new OAuthService(db, {
    credentials: env.oauth,
    publicOrigin: env.publicOrigin,
  });

  const cfg: GuardConfig = {
    allowedOrigins: env.allowedOrigins,
    auth,
    pepper: env.pepper,
    trustProxy: env.trustProxy,
    limiters: {
      // Shared counters in Postgres: warm serverless instances must not each
      // keep their own budget. Read paths fail open so a database blip does
      // not take browsing down; auth and write paths fail closed, because an
      // outage must not become a way around login throttling.
      read: new DurableRateLimiter(db, 'read', LIMITS.read, { failOpen: true }),
      write: new DurableRateLimiter(db, 'write', LIMITS.write),
      auth: new DurableRateLimiter(db, 'auth', LIMITS.login),
    },
  };

  return {
    env, db, auth, documents, mapkit, oauth, cfg,
    hsts: env.nodeEnv === 'production',
    secureCookies: env.secureCookies,
  };
}
