import { getApp } from '@/backend/http/app';
import { me } from '@/backend/http/routes/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const app = await getApp();
  return me(req, {
    cfg: app.cfg,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
  });
}
