import { getApp } from '@/backend/http/app';
import { deleteDocument } from '@/backend/http/routes/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const app = await getApp();
  const { id } = await params;
  return deleteDocument(req, id, { cfg: app.cfg, documents: app.documents, hsts: app.hsts });
}
