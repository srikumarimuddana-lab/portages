import { getApp } from '@/backend/http/app';
import { blockThread, unblockThread } from '@/backend/http/routes/messages';

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

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return blockThread(req, id, await deps());
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return unblockThread(req, id, await deps());
}
