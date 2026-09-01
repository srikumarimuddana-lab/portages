import { setFlag } from '@/backend/http/routes/admin';
import { adminDeps } from '../../_deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  return setFlag(req, key, await adminDeps());
}
