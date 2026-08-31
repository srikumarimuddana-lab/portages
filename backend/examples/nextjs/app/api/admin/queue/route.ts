import { listQueue } from '@/backend/http/routes/admin';
import { adminDeps } from '../_deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return listQueue(req, await adminDeps());
}
