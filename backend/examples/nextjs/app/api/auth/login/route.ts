import { getApp } from '@/backend/http/app';
import { login } from '@/backend/http/routes/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const app = await getApp();
  return login(req, {
    cfg: app.cfg,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
  });
}
