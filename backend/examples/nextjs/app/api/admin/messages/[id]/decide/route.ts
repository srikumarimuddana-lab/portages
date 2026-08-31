import { decideMessage } from '@/backend/http/routes/admin';
import { adminDeps } from '../../../_deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return decideMessage(req, id, await adminDeps());
}
