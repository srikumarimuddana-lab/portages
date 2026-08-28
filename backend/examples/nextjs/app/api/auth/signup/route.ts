import { getApp } from '@/backend/http/app';
import { signup } from '@/backend/http/routes/auth';
import { preflight } from '@/backend/http/respond';

// scrypt requires Node APIs; the Edge runtime cannot run this route.
export const runtime = 'nodejs';
// Auth responses set cookies and must never be cached or statically rendered.
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const app = await getApp();
  return signup(req, {
    cfg: app.cfg,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
  });
}

export async function OPTIONS(req: Request) {
  const app = await getApp();
  return preflight({
    requestId: 'preflight',
    origin: req.headers.get('origin') ?? undefined,
    allowedOrigins: app.cfg.allowedOrigins,
    hsts: app.hsts,
  });
}
