/**
 * Messaging routes — the enquiry inbox.
 *
 * Two things shape the surface. Every route is authenticated, because there is
 * no anonymous enquiry: an owner needs someone accountable at the other end,
 * and an unauthenticated contact form is a spam cannon. And starting a thread
 * carries a per-USER limit as well as the guard's per-IP one, because the
 * abuse here is one account messaging every listing in the city, which no
 * IP bucket sees.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest, tooManyRequests } from '../../lib/errors.js';
import type { Limiter } from '../../lib/ratelimit-db.js';
import type { MessagingService, ThreadStatus } from '../../modules/messaging/service.js';

export interface MessageRouteDeps {
  cfg: GuardConfig;
  messaging: MessagingService;
  hsts: boolean;
  /** Caps new conversations per account, independent of the caller's IP. */
  enquiryLimiter: Limiter;
}

const THREAD_STATUSES: readonly ThreadStatus[] = ['open', 'archived', 'blocked'];

// 4000 rather than the column's 8000: a message that long is a document, and
// the extra headroom in the schema is for a system message, not a person.
const messageBody = v.string({ min: 1, max: 4000 });

const startBody = v.object({
  listingId: v.uuid(),
  body: messageBody,
});

const replyBody = v.object({ body: messageBody });

const archiveBody = v.object({ archived: v.boolean() });

function ctxOf(requestId: string, origin: string | undefined, deps: MessageRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/** GET /api/threads — the inbox, both sides. */
export async function listThreads(req: Request, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;

    const params = new URL(req.url).searchParams;
    const status = params.get('status');
    if (status !== null && !THREAD_STATUSES.includes(status as ThreadStatus)) {
      throw badRequest('Request query is invalid.', [
        `status: must be one of: ${THREAD_STATUSES.join(', ')}`,
      ]);
    }

    const threads = await deps.messaging.listThreads(ctx.principal!.userId, {
      limit: toInt(params.get('limit'), 50),
      offset: toInt(params.get('offset'), 0),
      ...(status ? { status: status as ThreadStatus } : {}),
    });
    return json({ threads }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/threads/unread — the header badge. */
export async function unreadCount(req: Request, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    const unread = await deps.messaging.unreadCount(ctx.principal!.userId);
    return json({ unread }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/threads/:id — one conversation, and marks it read. */
export async function getThread(req: Request, threadId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    const thread = await deps.messaging.getThread(threadId, ctx.principal!.userId);
    return json({ thread }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * POST /api/threads — start an enquiry.
 *
 * The per-account limit is the point of this handler being separate from
 * reply: one person messaging two hundred listings in an evening is the abuse
 * that matters, and it looks like perfectly ordinary traffic to a per-IP
 * bucket if they are on a phone with a rotating address.
 */
export async function startThread(req: Request, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ listingId: string; body: string }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: startBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const verdict = await deps.enquiryLimiter.check(`enquiry:${ctx.principal!.userId}`);
    if (!verdict.allowed) {
      throw tooManyRequests('You have sent a lot of enquiries recently. Try again shortly.');
    }

    const out = await deps.messaging.startThread({
      listingId: body.listingId,
      inquirerId: ctx.principal!.userId,
      body: body.body,
    });
    // 200 even when the message was withheld: the thread exists, and the
    // caller needs the notice rather than an error they cannot act on.
    return json(out, ctxOf(ctx.requestId, ctx.origin, deps), out.ok ? 201 : 200);
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/threads/:id/messages — reply. */
export async function replyToThread(req: Request, threadId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ body: string }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: replyBody,
    });
    id = ctx.requestId; origin = ctx.origin;

    const out = await deps.messaging.reply({
      threadId,
      senderId: ctx.principal!.userId,
      body: body.body,
    });
    return json(out, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/threads/:id/read */
export async function markThreadRead(req: Request, threadId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    id = ctx.requestId; origin = ctx.origin;
    await deps.messaging.markRead(threadId, ctx.principal!.userId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** PUT /api/threads/:id/archive */
export async function archiveThread(req: Request, threadId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ archived: boolean }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: archiveBody,
    });
    id = ctx.requestId; origin = ctx.origin;
    await deps.messaging.archive(threadId, ctx.principal!.userId, body.archived);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** POST /api/threads/:id/block */
export async function blockThread(req: Request, threadId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    id = ctx.requestId; origin = ctx.origin;
    await deps.messaging.block(threadId, ctx.principal!.userId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** DELETE /api/threads/:id/block — only the blocker may lift it. */
export async function unblockThread(req: Request, threadId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    id = ctx.requestId; origin = ctx.origin;
    await deps.messaging.unblock(threadId, ctx.principal!.userId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/listings/:id/threads — enquiries on one listing, owner only. */
export async function listingThreads(req: Request, listingId: string, deps: MessageRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    const threads = await deps.messaging.threadsForListing(listingId, ctx.principal!.userId);
    return json({ threads }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

function toInt(raw: string | null, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}
