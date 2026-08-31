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
import { S3Storage } from '../modules/storage/s3.js';
import { UploadService } from '../modules/storage/service.js';
import { MessagingService } from '../modules/messaging/service.js';
import { AuditService } from '../modules/audit/service.js';
import { ModerationService } from '../modules/admin/moderation.js';
import { FlagService } from '../modules/flags/service.js';
import { GatewayProvider } from '../modules/ai/adapters/gateway.js';
import { ChatSearchService } from '../modules/ai/chat-search.js';
import { ListingBuilderService } from '../modules/ai/listing-builder.js';
import { AiModerationService } from '../modules/ai/moderation.js';
import { UNCONFIGURED, type ModelProvider } from '../modules/ai/provider.js';
import { AiLedger, MeteredProvider } from '../modules/ai/ledger.js';
import { ReportService } from '../modules/trust/reports.js';
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
  /** Absent when object storage is not configured; uploads report 503. */
  uploads: UploadService | null;
  messaging: MessagingService;
  audit: AuditService;
  moderation: ModerationService;
  /** Kill switches. Read by the guard, by notify, and by the admin console. */
  flags: FlagService;
  /** The model provider. `UNCONFIGURED` when no Gateway credentials are set. */
  aiProvider: ModelProvider;
  /** Natural-language search. Present even when AI is off; the route checks the flag. */
  chatSearch: ChatSearchService;
  /** Drafts listing copy from the owner's own facts, then fact-checks it. */
  listingBuilder: ListingBuilderService;
  /** Second opinion on ambiguous messages. Can escalate, never de-escalate. */
  aiModeration: AiModerationService;
  /** Spend and failure attribution per call. Read by the ops view. */
  aiLedger: AiLedger;
  /** The provider wrapped so no feature can make an unrecorded call. */
  metered: MeteredProvider;
  /** Per-account daily cap on model calls, on top of the global kill switch. */
  aiLimiter: DurableRateLimiter;
  /** User reports — the human producer for the moderation queue. */
  reports: ReportService;
  /** Caps new enquiries per account, separate from the IP buckets. */
  enquiryLimiter: DurableRateLimiter;
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
  // Built before anything that writes to it: an audit trail added later has
  // no rows for the period before it.
  const audit = new AuditService(env.pepper);
  const moderation = new ModerationService(db);
  // The last missing producer for moderation_queue. Audited, because closing
  // a report is a staff decision like any other.
  const reports = new ReportService({ db, audit });
  // Built before anything that reads a switch, and given the audit
  // recorder so a flip cannot happen without a record of who flipped it.
  const flags = new FlagService(db, { audit });
  const gazetteer = new Gazetteer(db);
  const search = new SearchService(db);
  // Object storage is optional. Without it the site still browses and
  // searches; only storing bytes is unavailable, and it says so.
  const uploads = env.storage
    ? new UploadService({
        db,
        storage: new S3Storage({
          endpoint: env.storage.endpoint,
          bucket: env.storage.bucket,
          region: env.storage.region,
          credentials: {
            accessKeyId: env.storage.accessKeyId,
            secretAccessKey: env.storage.secretAccessKey,
          },
          publicBaseUrl: env.storage.publicBaseUrl,
        }),
        ticketSecret: env.storageSecret,
      })
    : null;
  // The gazetteer is injected as the geocoder, so a new listing gets a
  // coordinate sourced from City of Regina open data rather than from Apple,
  // whose licence forbids storing it. The upload service mints the presigned
  // PUT for each photo.
  const listings = new ListingService(db, env.storageSecret, {
    geocoder: gazetteer,
    uploads,
    audit,
  });
  // AI. Absent credentials give UNCONFIGURED, which reports 503 rather than
  // throwing — so a deployment without a Gateway key browses, searches and
  // messages exactly as it does today, and only the AI paths say they are off.
  //
  // The OIDC token is read through a closure rather than captured, because
  // Vercel rotates it and a warm instance holding a boot-time copy starts
  // failing with 401s some hours in.
  const aiProvider: ModelProvider = env.ai
    ? new GatewayProvider({
        ...(env.ai.apiKey ? { apiKey: env.ai.apiKey } : {}),
        ...(env.ai.baseUrl ? { baseUrl: env.ai.baseUrl } : {}),
        oidcToken: () => process.env['VERCEL_OIDC_TOKEN'],
      })
    : UNCONFIGURED;
  const chatSearch = new ChatSearchService({
    provider: aiProvider,
    model: env.ai?.models.chatSearch ?? 'anthropic/claude-haiku-4-5',
  });
  const listingBuilder = new ListingBuilderService({
    provider: aiProvider,
    model: env.ai?.models.listingBuilder ?? 'anthropic/claude-opus-5',
  });
  // Wrapping means a feature cannot make an unrecorded call: it does not know
  // it is metered and has no way to opt out. Attribution is added per request
  // with `.for()`, which returns a bound copy rather than mutating a shared one.
  const aiLedger = new AiLedger(db);
  const metered = new MeteredProvider(aiProvider, aiLedger);
  const aiModeration = new AiModerationService({
    provider: aiProvider,
    model: env.ai?.models.moderation ?? 'anthropic/claude-haiku-4-5',
  });

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
  // Replaces the ALLOW_ALL default NotifyService has carried since the
  // notify module shipped. No call site in that file changes: the check was
  // always there, it just always said yes.
  const notify = new NotifyService(db, [email, sms, new WhatsAppChannel()], {
    killSwitch: flags,
  });

  const otp = new OtpService(db);
  const otpFlows = new OtpFlows({ db, otp, notify, auth });
  // Six digits is a million possibilities, so the per-IP bucket is not
  // enough: an attacker rotating IPs must still be capped against ONE
  // account. Tighter than the login limiter for the same reason.
  const identifierLimiter = new DurableRateLimiter(db, 'otp-id', { windowMs: 15 * 60_000, max: 5 });

  const messaging = new MessagingService({
    db,
    notify,
    appOrigin: env.publicOrigin || `http://localhost:${env.port}`,
    audit,
    // Metered like every other AI call, and attributed to messages. The send
    // path treats a slow or failing model as "no opinion" — the rules have
    // already produced a defensible verdict.
    aiModeration: aiModeration.withProvider(metered.for({ subjectType: 'message' })),
  });
  // One account messaging every listing in the city is the abuse that matters
  // here, and it looks like ordinary traffic to a per-IP bucket when the
  // sender is on a phone with a rotating address.
  const enquiryLimiter = new DurableRateLimiter(db, 'enquiry', {
    windowMs: 60 * 60_000,
    max: 20,
  });

  // The kill switch is global and the Gateway budget is account-wide; neither
  // stops ONE account running up the bill. Requests rather than tokens,
  // because maxTokens is already fixed per task — so a request cap IS a spend
  // cap, and it reuses the durable limiter instead of inventing a second
  // accounting mechanism. Fails CLOSED: a database blip must not open the
  // budget, which is the opposite of the read limiter's choice and correct for
  // the same reason.
  const aiLimiter = new DurableRateLimiter(db, 'ai', { windowMs: 24 * 60 * 60_000, max: 60 });

  const oauth = new OAuthService(db, {
    credentials: env.oauth,
    publicOrigin: env.publicOrigin,
  });

  const cfg: GuardConfig = {
    allowedOrigins: env.allowedOrigins,
    auth,
    pepper: env.pepper,
    trustProxy: env.trustProxy,
    flags,
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
    gazetteer, search, uploads, messaging, audit, moderation, flags,
    aiProvider, chatSearch, listingBuilder, aiModeration,
    aiLedger, metered, aiLimiter, reports,
    enquiryLimiter, identifierLimiter, cfg,
    hsts: env.nodeEnv === 'production',
    secureCookies: env.secureCookies,
  };
}
