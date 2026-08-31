import { getApp } from '@/backend/http/app';
import { describeListing } from '@/backend/http/routes/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const app = await getApp();
  return describeListing(req, id, {
    cfg: app.cfg, chatSearch: app.chatSearch, listingBuilder: app.listingBuilder,
    search: app.search, gazetteer: app.gazetteer, listings: app.listings,
    metered: app.metered, aiLimiter: app.aiLimiter, hsts: app.hsts,
  });
}
