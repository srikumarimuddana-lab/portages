import { getApp } from '@/backend/http/app';
import { aiSearch } from '@/backend/http/routes/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = async () => {
  const app = await getApp();
  return {
    cfg: app.cfg, chatSearch: app.chatSearch, listingBuilder: app.listingBuilder,
    search: app.search, gazetteer: app.gazetteer, listings: app.listings,
    metered: app.metered, aiLimiter: app.aiLimiter, hsts: app.hsts,
  };
};

export async function POST(req: Request) {
  return aiSearch(req, await deps());
}
