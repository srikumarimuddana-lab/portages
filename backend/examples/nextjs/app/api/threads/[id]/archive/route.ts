import { getApp } from '@/backend/http/app';
import { archiveThread } from '@/backend/http/routes/messages';

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

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return archiveThread(req, id, await deps());
}
