import { purgeDocuments } from '@/backend/http/routes/jobs';
import { getApp } from '@/backend/http/app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Vercel Cron sends GET with `Authorization: Bearer $CRON_SECRET`. */
export async function GET(req: Request) {
  return purgeDocuments(req, await getApp());
}

/** The same job, for a manual run. */
export async function POST(req: Request) {
  return purgeDocuments(req, await getApp());
}
