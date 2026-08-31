import { getApp } from '@/backend/http/app';
import { requestEmailVerification } from '@/backend/http/routes/otp';

// scrypt and the OTP digest need Node APIs; Edge cannot run this route.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const app = await getApp();
  return requestEmailVerification(req, {
    cfg: app.cfg,
    flows: app.otpFlows,
    hsts: app.hsts,
    identifierLimiter: app.identifierLimiter,
  });
}
