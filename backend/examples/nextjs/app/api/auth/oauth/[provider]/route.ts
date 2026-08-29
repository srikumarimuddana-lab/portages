import { getApp } from '@/backend/http/app';
import { oauthStart } from '@/backend/http/routes/oauth';

// scrypt and the OAuth exchange need Node APIs; Edge cannot run this.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ provider: string }> }) {
  const app = await getApp();
  const { provider } = await params;
  return oauthStart(req, provider, {
    cfg: app.cfg,
    oauth: app.oauth,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
    appOrigin: app.env.publicOrigin,
  });
}
