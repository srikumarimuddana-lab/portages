import { getApp } from '@/backend/http/app';
import { recordPreview } from '@/backend/http/routes/uploads';

// Reads objects back and rewrites image bytes; needs Node APIs.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const deps = async () => {
  const app = await getApp();
  return { cfg: app.cfg, uploads: app.uploads, hsts: app.hsts };
};

export async function POST(req: Request) {
  return recordPreview(req, await deps());
}
