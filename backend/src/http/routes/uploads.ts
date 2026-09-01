/**
 * Upload completion routes.
 *
 * There is deliberately no route that accepts bytes. The browser PUTs directly
 * to object storage using a presigned URL issued alongside the listing photo
 * or locker document, and these endpoints only decide whether to believe that
 * it worked.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest, serviceUnavailable } from '../../lib/errors.js';
import type { UploadService } from '../../modules/storage/service.js';

export interface UploadRouteDeps {
  cfg: GuardConfig;
  /** Absent when object storage is not configured. */
  uploads: UploadService | null;
  hsts: boolean;
}

const completeBody = v.object({
  completionToken: v.string({ min: 8, max: 800 }),
});

const previewBody = v.object({
  mediaId: v.uuid(),
  // BlurHash is base83; the alphabet is fixed, so the shape can be checked
  // even though the value itself is only cosmetic.
  blurhash: v.optional(v.string({ min: 6, max: 64, pattern: /^[0-9A-Za-z#$%*+,\-.:;=?@[\]^_{|}~]+$/ })),
  width: v.optional(v.integer({ min: 1, max: 20000 })),
  height: v.optional(v.integer({ min: 1, max: 20000 })),
});

function ctxOf(requestId: string, origin: string | undefined, deps: UploadRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/**
 * POST /api/uploads/complete
 *
 * The client calls this once its PUT succeeds. The server then reads the
 * object back, because everything the client has said so far is a claim.
 */
export async function completeUpload(req: Request, deps: UploadRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ completionToken: string }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: completeBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    if (!deps.uploads) throw uploadsUnavailable();

    const out = await deps.uploads.complete({
      token: body.completionToken,
      ownerId: ctx.principal!.userId,
    });
    if (!out.ok) throw badRequest(out.reason);

    return json(
      {
        stored: true,
        bytes: out.bytes,
        mime: out.mime,
        // Reported back deliberately. An owner who uploads a photo straight
        // from their camera roll should be told that its location data was
        // removed, rather than having it happen silently.
        metadataRemoved: out.metadataStripped,
        locationDataRemoved: out.hadGps,
        orientation: out.orientation,
      },
      ctxOf(ctx.requestId, ctx.origin, deps),
    );
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * POST /api/uploads/preview
 *
 * Records the blur placeholder and dimensions the browser computed. Both are
 * cosmetic — a dishonest blurhash only spoils the uploader's own card — which
 * is why they may come from the client at all, unlike anything on the
 * completion path.
 */
export async function recordPreview(req: Request, deps: UploadRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{
      mediaId: string; blurhash?: string; width?: number; height?: number;
    }>(req, deps.cfg, { requireAuth: true, limit: 'write', body: previewBody });
    id = ctx.requestId; origin = ctx.origin;

    if (!deps.uploads) throw uploadsUnavailable();

    await deps.uploads.recordPreview({
      mediaId: body.mediaId,
      ownerId: ctx.principal!.userId,
      blurhash: body.blurhash,
      width: body.width,
      height: body.height,
    });
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * Says the feature is off rather than pretending it broke.
 *
 * 503 with a plain message, because "uploads are not configured" is an
 * operator problem, and dressing it up as a 500 sends someone hunting for a
 * bug that is really a missing environment variable.
 */
function uploadsUnavailable() {
  return serviceUnavailable('File uploads are not configured on this environment.');
}
