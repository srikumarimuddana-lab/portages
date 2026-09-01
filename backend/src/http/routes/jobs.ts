/**
 * Scheduled work, triggered over HTTP.
 *
 * There is no long-running worker: the deployment target is serverless, and
 * the plan is Vercel Cron, which calls a URL on a schedule. So a job is an
 * endpoint, and an endpoint that does real work needs an answer to "who may
 * call this".
 *
 * THE SHAPE IS VERCEL'S, NOT OURS, and getting it wrong is silent. Vercel Cron
 * sends a **GET**, and authenticates by adding `Authorization: Bearer
 * $CRON_SECRET` when that environment variable is set. An endpoint that
 * insists on POST, or on a header of our own choosing, is one the scheduler
 * calls every hour and is refused by every hour, with nothing in the product
 * to show for it. The custom header is kept as a second way in for a manual
 * or ops-triggered run.
 *
 * A GET THAT MUTATES is a smell, and it is accepted here for one reason: the
 * scheduler's contract requires it. What normally makes it dangerous — a
 * crawler, a prefetcher or a link-preview bot firing the job by following a
 * URL — cannot happen, because none of them carry the secret and the endpoint
 * refuses everything without it.
 *
 * The secret is compared in constant time. Not an IP allowlist (the caller's
 * addresses are not stable and are not ours to verify), not obscurity, and not
 * "it is only named in the cron config". A job that mails several thousand
 * people is exactly the URL somebody finds.
 *
 * With no secret configured the endpoint refuses everything. That is the safe
 * direction: a deployment that forgot to set it does not send alerts, rather
 * than sending them for whoever finds the path.
 */
import { timingSafeEqualStrings } from '../../lib/crypto.js';
import { json } from '../respond.js';
import type { App } from '../app.js';

/** What Vercel Cron sends. */
const BEARER = 'authorization';
/** What a person or another scheduler can send instead. */
const HEADER = 'x-portage-cron';

/**
 * Alerts sent per run.
 *
 * Deliberately well inside the 60-second budget in vercel.json rather than at
 * the edge of it: a search and a send each, sequential, on a cold function. A
 * backlog is drained by the next hourly run rather than by one long one.
 */
const ALERTS_PER_RUN = 50;

/**
 * Listings expired per run, and documents purged per run.
 *
 * Both are far larger than the alert batch because both are cheap: expiry is
 * one UPDATE over an indexed range, and a purge is a DELETE against object
 * storage with no search behind it. Both run daily, and a backlog on either
 * drains over successive nights rather than being dropped.
 */
const EXPIRE_PER_RUN = 500;
const PURGE_PER_RUN = 200;

function authorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;

  const auth = req.headers.get(BEARER) ?? '';
  const presented = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice('bearer '.length).trim()
    : (req.headers.get(HEADER) ?? '');

  // Constant time. A byte-by-byte comparison of a secret over a network is a
  // real oracle, and this is a header an attacker can retry without limit.
  return presented.length > 0 && timingSafeEqualStrings(presented, secret);
}

/**
 * The shared shape of a job endpoint.
 *
 * Answers 404 rather than 401 to an unauthorized caller, so probing the path
 * teaches nothing about whether it exists. The same rule the admin routes
 * follow.
 */
async function job(
  req: Request,
  app: App,
  name: string,
  run: () => Promise<Record<string, number>>,
): Promise<Response> {
  if (!authorized(req, app.env.cronSecret)) {
    return new Response('Not found', { status: 404 });
  }
  const started = Date.now();
  const out = await run();
  // Logged as one structured line per run, because the question asked after
  // the fact is always "did it run, and did it do anything" — and a scheduler
  // dashboard only records the status code.
  console.log(JSON.stringify({ level: 'info', job: name, ...out, ms: Date.now() - started }));
  return json(out, {
    requestId: `cron-${name}`,
    allowedOrigins: app.cfg.allowedOrigins,
    hsts: app.hsts,
  });
}

/** GET (and POST) /api/jobs/alerts — send saved-search alerts that are due. */
export async function runAlerts(req: Request, app: App): Promise<Response> {
  return job(req, app, 'alerts', async () => {

    return app.savedSearches.runAlerts({
      notify: app.notify,
      origin: app.env.publicOrigin || new URL(req.url).origin,
      // Tied to `maxDuration` in vercel.json, and the two are one decision.
      // Each alert is a search plus a send, so the batch has to finish inside
      // the function's time budget. Anything left over is picked up by the
      // next hourly run, so a backlog drains rather than being dropped.
      limit: ALERTS_PER_RUN,
    });
  });
}

/**
 * GET (and POST) /api/jobs/expire-listings — retire listings past their TTL.
 *
 * A listing lives 90 days. Without this nothing ever expires one, so the
 * search results fill with flats that were let last spring — which is the
 * failure that makes a classifieds site stop being worth visiting, and the
 * one every competitor in analysis/02 was criticised for.
 *
 * Expiring is not deleting: the row becomes `expired` and the owner can
 * resume it. Nobody loses a listing because they were on holiday.
 */
export async function expireListings(req: Request, app: App): Promise<Response> {
  return job(req, app, 'expire-listings', async () => ({
    expired: await app.listings.expireStale(EXPIRE_PER_RUN),
  }));
}

/**
 * GET (and POST) /api/jobs/purge-documents — destroy documents past retention.
 *
 * PIPEDA principle 4.5.3: personal information must be destroyed once the
 * purpose it was collected for is done. This is the only thing in the system
 * that does that — the locker page promises a deletion date on every row, and
 * until this ran on a schedule that promise was decorative.
 */
export async function purgeDocuments(req: Request, app: App): Promise<Response> {
  return job(req, app, 'purge-documents', () => app.documents.purgeExpired(PURGE_PER_RUN));
}
