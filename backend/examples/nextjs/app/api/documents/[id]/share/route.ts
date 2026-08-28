import { getApp } from '@/backend/http/app';
import { shareDocument } from '@/backend/http/routes/documents';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const app = await getApp();
  const { id } = await params;
  return shareDocument(req, id, { cfg: app.cfg, documents: app.documents, hsts: app.hsts });
}
