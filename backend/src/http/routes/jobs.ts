/**
 * Scheduled work, triggered over HTTP.
 *
 * There is no long-running worker: the deployment target is serverless, and
 * the plan is Vercel Cron, which calls a URL on a schedule. So a job is an
 * endpoint, and an endpoint that does real work needs an answer to "who may
 * call this".
 *
 * A SHARED SECRET IN A HEADER, compared in constant time. Not an IP allowlist
 * (the caller's addresses are not stable and are not ours to verify), not
 * obscurity, and not "it is only linked from the cron config". A job that
 * mails several thousand people is exactly the URL somebody finds.
 *
 * With no secret configured the endpoint refuses everything. That is the safe
 * direction: a deployment that forgot to set it does not send alerts, rather
 * than sending them for whoever finds the path.
 */
import { timingSafeEqualStrings } from '../../lib/crypto.js';
import { json } from '../respond.js';
import type { App } from '../app.js';

const HEADER = 'x-portage-cron';

function authorized(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const presented = req.headers.get(HEADER) ?? '';
  // Constant time. A byte-by-byte comparison of a secret over a network is a
  // real oracle, and this is a header an attacker can retry without limit.
  return presented.length > 0 && timingSafeEqualStrings(presented, secret);
}

/**
 * POST /api/jobs/alerts — send saved-search alerts that are due.
 *
 * Answers 404 rather than 401 to an unauthorized caller, so probing the path
 * teaches nothing about whether it exists. The same rule the admin routes
 * follow.
 */
export async function runAlerts(req: Request, app: App): Promise<Response> {
  if (!authorized(req, app.env.cronSecret)) {
    return new Response('Not found', { status: 404 });
  }

  const out = await app.savedSearches.runAlerts({
    notify: app.notify,
    origin: app.env.publicOrigin || new URL(req.url).origin,
  });

  return json(out, {
    requestId: 'cron-alerts',
    allowedOrigins: app.cfg.allowedOrigins,
    hsts: app.hsts,
  });
}
