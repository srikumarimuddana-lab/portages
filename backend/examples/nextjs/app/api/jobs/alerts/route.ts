import { runAlerts } from '@/backend/http/routes/jobs';
import { getApp } from '@/backend/http/app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Vercel Cron calls this with GET and an `Authorization: Bearer $CRON_SECRET`
 * header. `runAlerts` checks the secret and answers 404 to anything else, so
 * this handler adds no gate of its own — one place decides who may run a job.
 *
 * `maxDuration` is set in vercel.json rather than here so the schedule and the
 * time budget it needs live in the same file.
 */
export async function GET(req: Request) {
  return runAlerts(req, await getApp());
}

/** The same job, for a manual run. */
export async function POST(req: Request) {
  return runAlerts(req, await getApp());
}
