import { getApp } from '@/backend/http/app';
import { mapkitToken } from '@/backend/http/routes/maps';

// createSign/createPrivateKey are Node APIs; Edge cannot run this route.
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const app = await getApp();
  if (!app.mapkit) {
    return new Response(JSON.stringify({ error: { code: 'not_configured' } }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
  return mapkitToken(req, {
    cfg: app.cfg,
    mapkit: app.mapkit,
    tokenOrigin: app.env.allowedOrigins[0],
    hsts: app.hsts,
  });
}
