import { getApp } from '@/backend/http/app';
import { listDocuments, createUpload } from '@/backend/http/routes/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const app = await getApp();
  return listDocuments(req, { cfg: app.cfg, documents: app.documents, hsts: app.hsts });
}

export async function POST(req: Request) {
  const app = await getApp();
  return createUpload(req, { cfg: app.cfg, documents: app.documents, hsts: app.hsts });
}
