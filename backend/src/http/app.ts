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
import { NotifyService } from '../modules/notify/service.js';
import { OtpService } from '../modules/auth/otp/service.js';
import { OtpFlows } from '../modules/auth/otp/flows.js';
import { ListingService } from '../modules/listings/service.js';
import { Gazetteer } from '../modules/geo/gazetteer.js';
import { SearchService } from '../modules/search/service.js';
import { EmailChannel } from '../modules/notify/channels/email.js';
import { SmsChannel } from '../modules/notify/channels/sms.js';
import { WhatsAppChannel } from '../modules/notify/channels/whatsapp.js';
import type { GuardConfig } from './guard.js';

export interface App {
  env: Env;
  db: Sql;
  auth: AuthService;
  documents: DocumentService;
  /** Absent until the Apple MapKit keys are configured. */
  mapkit: MapKitTokenIssuer | null;
  oauth: OAuthService;
  notify: NotifyService;
  otpFlows: OtpFlows;
  listings: ListingService;
  gazetteer: Gazetteer;
  search: SearchService;
  /** Per-identifier limiter for OTP endpoints, separate from the IP buckets. */
  identifierLimiter: DurableRateLimiter;
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
  const gazetteer = new Gazetteer(db);
  const search = new SearchService(db);
  // Shares the storage secret: listing photos and locker documents are both
  // direct-to-storage uploads signed the same way. The gazetteer is injected
  // as the geocoder, so a new listing gets a coordinate sourced from City of
  // Regina open data rather than from Apple, whose licence forbids storing it.
  const listings = new ListingService(db, env.storageSecret, { geocoder: gazetteer });
  const mapkit = env.mapkit ? new MapKitTokenIssuer(env.mapkit) : null;
  // A channel is only live when BOTH the AWS credentials and its own sender
  // identity are configured; otherwise it reports itself unconfigured and the
  // notify service blocks rather than throwing at send time.
  const email = new EmailChannel(
    env.aws?.sesFromAddress
      ? {
          region: env.aws.region,
          credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
          fromAddress: env.aws.sesFromAddress,
          configurationSet: env.aws.sesConfigurationSet,
        }
      : null,
  );
  const sms = new SmsChannel(
    env.aws?.smsOriginationIdentity
      ? {
          region: env.aws.region,
          credentials: { accessKeyId: env.aws.accessKeyId, secretAccessKey: env.aws.secretAccessKey },
          originationIdentity: env.aws.smsOriginationIdentity,
        }
      : null,
  );
  const notify = new NotifyService(db, [email, sms, new WhatsAppChannel()]);

  const otp = new OtpService(db);
  const otpFlows = new OtpFlows({ db, otp, notify, auth });
  // Six digits is a million possibilities, so the per-IP bucket is not
  // enough: an attacker rotating IPs must still be capped against ONE
  // account. Tighter than the login limiter for the same reason.
  const identifierLimiter = new DurableRateLimiter(db, 'otp-id', { windowMs: 15 * 60_000, max: 5 });

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
    env, db, auth, documents, mapkit, oauth, notify, otpFlows, listings,
    gazetteer, search, identifierLimiter, cfg,
    hsts: env.nodeEnv === 'production',
    secureCookies: env.secureCookies,
  };
}
