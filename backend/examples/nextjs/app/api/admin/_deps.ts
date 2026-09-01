/**
 * Shared dependency assembly for the admin routes.
 *
 * Every route below is role-gated inside `guard`, which answers 404 rather
 * than 403 to a caller without the role. That is worth knowing here because
 * it means these files look exactly like the public ones — there is no
 * separate middleware, no path-prefix rule, and nothing to forget to add.
 * The gate is in the handler, so a new admin route cannot ship without it.
 */
import { getApp } from '@/backend/http/app';
import type { AdminRouteDeps } from '@/backend/http/routes/admin';

export async function adminDeps(): Promise<AdminRouteDeps> {
  const app = await getApp();
  return {
    cfg: app.cfg,
    db: app.db,
    moderation: app.moderation,
    listings: app.listings,
    messaging: app.messaging,
    audit: app.audit,
    flags: app.flags,
    hsts: app.hsts,
  };
}
