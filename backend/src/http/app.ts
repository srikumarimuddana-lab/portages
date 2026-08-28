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
import { RateLimiter, LIMITS } from '../lib/ratelimit.js';
import type { GuardConfig } from './guard.js';

export interface App {
  env: Env;
  db: Sql;
  auth: AuthService;
  documents: DocumentService;
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

  const cfg: GuardConfig = {
    allowedOrigins: env.allowedOrigins,
    auth,
    pepper: env.pepper,
    trustProxy: env.trustProxy,
    limiters: {
      read: new RateLimiter(LIMITS.read),
      write: new RateLimiter(LIMITS.write),
      auth: new RateLimiter(LIMITS.login),
    },
  };

  return {
    env, db, auth, documents, cfg,
    hsts: env.nodeEnv === 'production',
    secureCookies: env.secureCookies,
  };
}
