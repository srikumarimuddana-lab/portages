import { getApp } from '@/backend/http/app';
import { getListing, updateListing } from '@/backend/http/routes/listings';

// The listing service reaches Postgres and signs upload tickets with Node
// crypto; Edge cannot run these routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = async () => {
  const app = await getApp();
  return { cfg: app.cfg, listings: app.listings, hsts: app.hsts };
};

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return getListing(req, id, await deps());
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return updateListing(req, id, await deps());
}
