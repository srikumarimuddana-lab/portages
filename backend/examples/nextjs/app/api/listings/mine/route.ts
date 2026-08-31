import { getApp } from '@/backend/http/app';
import { listMine } from '@/backend/http/routes/listings';

// The listing service reaches Postgres and signs upload tickets with Node
// crypto; Edge cannot run these routes.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = async () => {
  const app = await getApp();
  return { cfg: app.cfg, listings: app.listings, hsts: app.hsts };
};

export async function GET(req: Request) {
  return listMine(req, await deps());
}
