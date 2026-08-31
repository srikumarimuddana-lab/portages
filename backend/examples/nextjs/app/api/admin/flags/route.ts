import { listFlags } from '@/backend/http/routes/admin';
import { adminDeps } from '../_deps';

export const runtime = 'nodejs';
// Never cached, at any layer. A console showing a stale switch state during
// an incident is worse than no console.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  return listFlags(req, await adminDeps());
}
