import { getApp } from '@/backend/http/app';
import { oauthCallback } from '@/backend/http/routes/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const app = await getApp();
  const { provider } = await params;
  return oauthCallback(req, provider, {
    cfg: app.cfg,
    oauth: app.oauth,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
    appOrigin: app.env.publicOrigin,
  });
}
