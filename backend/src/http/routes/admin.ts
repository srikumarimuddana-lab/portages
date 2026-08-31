/**
 * Admin routes.
 *
 * The first callers of `requireRole`, which has been implemented in the guard
 * and used by nothing since it was written.
 *
 * Every route here answers **404** to a caller without the role, not 403 —
 * that is the guard's behaviour and it is deliberate. A 403 tells a stranger
 * the route exists and is worth attacking; a 404 tells them nothing.
 *
 * The staff/admin split follows analysis/10: daily queue work is `staff`,
 * while destructive and system-wide actions are `admin`. That is what lets a
 * part-time moderator be hired without handing them the ability to turn the
 * site off.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig, type GuardContext } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest } from '../../lib/errors.js';
import type { ModerationService, QueueState, QueueSubject } from '../../modules/admin/moderation.js';
import type { ListingService } from '../../modules/listings/service.js';
import type { MessagingService, StaffViewer } from '../../modules/messaging/service.js';
import type { AuditService, AuditAction } from '../../modules/audit/service.js';
import type { Sql } from '../../db/pool.js';

export interface AdminRouteDeps {
  cfg: GuardConfig;
  db: Sql;
  moderation: ModerationService;
  listings: ListingService;
  messaging: MessagingService;
  audit: AuditService;
  hsts: boolean;
}

const STAFF = ['staff', 'admin'] as const;
const ADMIN_ONLY = ['admin'] as const;

const QUEUE_STATES: readonly QueueState[] = ['open', 'approved', 'rejected', 'changes_requested'];
const SUBJECTS: readonly QueueSubject[] = ['listing', 'user', 'message'];

const decideListingBody = v.object({
  action: v.enumOf(['approve', 'reject'] as const),
  // Required on a rejection: it is what the owner is told, and a rejection
  // with no reason is a listing that gets resubmitted unchanged.
  reason: v.optional(v.string({ min: 4, max: 500 })),
});

const decideMessageBody = v.object({
  action: v.enumOf(['release', 'uphold'] as const),
});

function ctxOf(requestId: string, origin: string | undefined, deps: AdminRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/** The acting staff member, assembled from the session — never from a body. */
function staffOf(ctx: GuardContext): StaffViewer {
  return {
    userId: ctx.principal!.userId,
    role: ctx.principal!.role as 'staff' | 'admin',
    ip: ctx.clientIp,
  };
}

/** GET /api/admin/queue — the list. */
export async function listQueue(req: Request, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'read', requireRole: STAFF,
    });
    id = ctx.requestId; origin = ctx.origin;

    const params = new URL(req.url).searchParams;
    const state = params.get('state');
    const subject = params.get('subjectType');
    if (state !== null && !QUEUE_STATES.includes(state as QueueState)) {
      throw badRequest('Request query is invalid.', [`state: one of ${QUEUE_STATES.join(', ')}`]);
    }
    if (subject !== null && !SUBJECTS.includes(subject as QueueSubject)) {
      throw badRequest('Request query is invalid.', [`subjectType: one of ${SUBJECTS.join(', ')}`]);
    }

    const items = await deps.moderation.list({
      ...(state ? { state: state as QueueState } : {}),
      ...(subject ? { subjectType: subject as QueueSubject } : {}),
      limit: toInt(params.get('limit'), 50),
      offset: toInt(params.get('offset'), 0),
    });
    return json({ items }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/admin/queue/stats — queue health. */
export async function queueStats(req: Request, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'read', requireRole: STAFF,
    });
    id = ctx.requestId; origin = ctx.origin;
    return json(await deps.moderation.stats(), ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/admin/queue/:id — one item. */
export async function getQueueItem(req: Request, itemId: string, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'read', requireRole: STAFF,
    });
    id = ctx.requestId; origin = ctx.origin;
    return json({ item: await deps.moderation.get(itemId) }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/admin/queue/:id/dismiss — looked, nothing to do. */
export async function dismissQueueItem(req: Request, itemId: string, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'write', requireRole: STAFF,
    });
    id = ctx.requestId; origin = ctx.origin;
    await deps.moderation.dismiss(itemId, ctx.principal!.userId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * POST /api/admin/listings/:id/decide
 *
 * Goes through `ListingService.transition`, which owns the state machine and
 * writes the audit entry in the same transaction. This route decides nothing
 * itself — duplicating the transition here is how two code paths end up
 * disagreeing about what "approved" means.
 */
export async function decideListing(req: Request, listingId: string, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ action: 'approve' | 'reject'; reason?: string }>(
      req, deps.cfg,
      { requireAuth: true, limit: 'write', requireRole: STAFF, body: decideListingBody },
    );
    id = ctx.requestId; origin = ctx.origin;

    if (body.action === 'reject' && !body.reason) {
      throw badRequest('Give a reason. The owner is shown it, and a rejection without one gets resubmitted unchanged.');
    }

    const out = await deps.listings.transition(
      listingId,
      { userId: ctx.principal!.userId, role: ctx.principal!.role },
      body.action,
      { ...(body.reason ? { reason: body.reason } : {}), ip: ctx.clientIp },
    );
    return json({ status: out.status }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * GET /api/admin/messages/:id — a withheld message, in thread context.
 *
 * The only read path in the codebase that returns an undelivered message. It
 * exists because blocking is invisible to its recipient: without a staff view
 * there is nobody who can see that the scanner got one wrong.
 */
export async function reviewMessage(req: Request, messageId: string, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'read', requireRole: STAFF,
    });
    id = ctx.requestId; origin = ctx.origin;
    const message = await deps.messaging.reviewMessage(messageId, staffOf(ctx));
    return json({ message }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/admin/messages/:id/decide — release or uphold. */
export async function decideMessage(req: Request, messageId: string, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ action: 'release' | 'uphold' }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', requireRole: STAFF, body: decideMessageBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const staff = staffOf(ctx);
    if (body.action === 'release') {
      const out = await deps.messaging.release(messageId, staff);
      return json(out, ctxOf(ctx.requestId, ctx.origin, deps));
    }
    await deps.messaging.uphold(messageId, staff);
    return json({ delivered: false }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * GET /api/admin/audit — the trail.
 *
 * Admin only, not staff. A moderator does not need to read the record of
 * everyone's decisions, and the trail is most useful when the people it
 * records cannot browse it casually.
 */
export async function listAudit(req: Request, deps: AdminRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'read', requireRole: ADMIN_ONLY,
    });
    id = ctx.requestId; origin = ctx.origin;

    const params = new URL(req.url).searchParams;
    const action = params.get('action');
    const entries = await deps.audit.list(deps.db, {
      limit: toInt(params.get('limit'), 50),
      ...(params.get('beforeId') ? { beforeId: params.get('beforeId')! } : {}),
      ...(action ? { action: action as AuditAction } : {}),
      ...(params.get('subjectId') ? { subjectId: params.get('subjectId')! } : {}),
    });
    return json({ entries }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

function toInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
