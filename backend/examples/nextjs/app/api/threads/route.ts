import { getApp } from '@/backend/http/app';
import { listThreads, startThread } from '@/backend/http/routes/messages';

// Messaging touches Postgres and sends mail; Edge cannot run these routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = async () => {
  const app = await getApp();
  return {
    cfg: app.cfg, messaging: app.messaging, hsts: app.hsts,
    enquiryLimiter: app.enquiryLimiter,
  };
};

export async function GET(req: Request) {
  return listThreads(req, await deps());
}

export async function POST(req: Request) {
  return startThread(req, await deps());
}
