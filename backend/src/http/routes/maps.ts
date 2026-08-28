/**
 * MapKit JS token endpoint.
 *
 * The browser calls this to obtain a short-lived Apple Maps token. Notes on
 * why it is shaped this way:
 *
 *  - Unauthenticated on purpose: the map renders on public listing pages, so
 *    requiring a session would break browsing. The token is instead bound to
 *    your origin and expires quickly.
 *  - Rate-limited, because every token issued can consume Apple quota.
 *  - Cached at the edge for a fraction of its lifetime so a traffic spike does
 *    not mint one token per pageview.
 */
import { guard, type GuardConfig } from '../guard.js';
import { json, errorResponse, type ResponseContext } from '../respond.js';
import type { MapKitTokenIssuer } from '../../modules/maps/mapkit.js';

export interface MapRouteDeps {
  cfg: GuardConfig;
  mapkit: MapKitTokenIssuer;
  /** Origin the issued token is bound to. */
  tokenOrigin: string | undefined;
  hsts: boolean;
}

export async function mapkitToken(req: Request, deps: MapRouteDeps): Promise<Response> {
  let id = '';
  let origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: false, limit: 'read' });
    id = ctx.requestId;
    origin = ctx.origin;

    const { token, expiresAt } = deps.mapkit.issue({ origin: deps.tokenOrigin });

    const rctx: ResponseContext = {
      requestId: ctx.requestId,
      origin: ctx.origin,
      allowedOrigins: deps.cfg.allowedOrigins,
      hsts: deps.hsts,
    };
    const res = json({ token, expiresAt }, rctx);
    // Shorter than the token's own lifetime so clients always hold a valid one.
    res.headers.set('Cache-Control', 'public, max-age=300');
    return res;
  } catch (err) {
    return errorResponse(err, {
      requestId: id || 'unknown',
      origin,
      allowedOrigins: deps.cfg.allowedOrigins,
      hsts: deps.hsts,
    });
  }
}
