import { getQueueItem } from '@/backend/http/routes/admin';
import { adminDeps } from '../../_deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return getQueueItem(req, id, await adminDeps());
}
