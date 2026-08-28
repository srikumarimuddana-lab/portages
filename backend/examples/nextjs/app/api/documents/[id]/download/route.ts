import { getApp } from '@/backend/http/app';
import { createDownload } from '@/backend/http/routes/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const app = await getApp();
  const { id } = await params;
  return createDownload(req, id, { cfg: app.cfg, documents: app.documents, hsts: app.hsts });
}
