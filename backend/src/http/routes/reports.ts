/**
 * Report routes.
 *
 * One public endpoint and two staff ones. The public one is the last missing
 * producer for `moderation_queue`: until it existed, the queue held only what
 * the heuristics caught, which meant nobody could tell us about the listing
 * whose photos are of their own living room.
 *
 *   POST /api/reports                     file one          (any signed-in user)
 *   GET  /api/admin/reports/:type/:id     read them         (staff)
 *   POST /api/admin/reports/:type/:id/decide  close them    (staff)
 *
 * Reports are filed against a subject id the reporter already has — a listing
 * they are looking at, a message they received. There is deliberately no
 * "report by email address" or "report this person" search: a report form
 * that lets you name anyone is a harassment tool.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, errorResponse, type ResponseContext } from '../respond.js';
import { badRequest } from '../../lib/errors.js';
import {
  REPORT_KINDS, REPORT_SUBJECTS,
  type ReportKind, type ReportService, type ReportSubject,
} from '../../modules/trust/reports.js';

export interface ReportRouteDeps {
  cfg: GuardConfig;
  reports: ReportService;
  hsts: boolean;
}

const STAFF = ['staff', 'admin'] as const;

const createBody = v.object({
  subjectType: v.enumOf(REPORT_SUBJECTS),
  subjectId: v.uuid(),
  kind: v.enumOf(REPORT_KINDS),
  detail: v.optional(v.string({ max: 4000 })),
});

const decideBody = v.object({
  outcome: v.enumOf(['resolved', 'dismissed'] as const),
});

function ctxOf(requestId: string, origin: string | undefined, deps: ReportRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

/**
 * POST /api/reports
 *
 * Signed-in only. See ReportService.create for why anonymous reporting is not
 * supported and what it would cost to change that.
 *
 * The `write` limiter applies as usual, which is the throttle that matters
 * here: one account filing forty reports in an evening is the abuse pattern,
 * and `reports_reporter_idx` exists so a moderator can see it afterwards.
 */
export async function createReport(req: Request, deps: ReportRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{
      subjectType: ReportSubject; subjectId: string; kind: ReportKind; detail?: string;
    }>(req, deps.cfg, { requireAuth: true, limit: 'write', body: createBody });
    id = ctx.requestId; origin = ctx.origin;

    const report = await deps.reports.create({
      // From the session, never the body — a report filed in someone else's
      // name is worse than no report at all.
      reporterId: ctx.principal!.userId,
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      kind: body.kind,
      ...(body.detail ? { detail: body.detail } : {}),
    });

    return json(
      {
        id: report.id,
        // Deliberately not the risk score or queue position. Telling a
        // reporter how close their report came to acting on a listing is a
        // scoreboard for anyone testing how many accounts it takes.
        received: true,
      },
      ctxOf(ctx.requestId, ctx.origin, deps),
      201,
    );
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/** GET /api/admin/reports/:subjectType/:subjectId — what people actually said. */
export async function listReports(
  req: Request,
  subjectType: string,
  subjectId: string,
  deps: ReportRouteDeps,
): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, {
      requireAuth: true, limit: 'read', requireRole: STAFF,
    });
    id = ctx.requestId; origin = ctx.origin;

    if (!REPORT_SUBJECTS.includes(subjectType as ReportSubject)) {
      throw badRequest(`subjectType: one of ${REPORT_SUBJECTS.join(', ')}`);
    }
    const reports = await deps.reports.forSubject(subjectType as ReportSubject, subjectId);
    return json({ reports }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

/**
 * POST /api/admin/reports/:subjectType/:subjectId/decide
 *
 * Closes every open report against the subject at once. A moderator looks at
 * the listing once and reaches one conclusion; making them close eight
 * reports individually is how the eighth gets left open, and an open report
 * is what keeps a subject in the queue.
 *
 * This closes the REPORTS. Acting on the listing itself — approving,
 * rejecting, suspending an account — stays a separate, separately audited
 * decision, because "I have read these" and "I have taken it down" are
 * different things and collapsing them loses which one happened.
 */
export async function decideReports(
  req: Request,
  subjectType: string,
  subjectId: string,
  deps: ReportRouteDeps,
): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ outcome: 'resolved' | 'dismissed' }>(
      req, deps.cfg,
      { requireAuth: true, limit: 'write', requireRole: STAFF, body: decideBody },
    );
    id = ctx.requestId; origin = ctx.origin;

    if (!REPORT_SUBJECTS.includes(subjectType as ReportSubject)) {
      throw badRequest(`subjectType: one of ${REPORT_SUBJECTS.join(', ')}`);
    }

    const out = await deps.reports.decide(
      subjectType as ReportSubject,
      subjectId,
      body.outcome,
      { userId: ctx.principal!.userId, role: ctx.principal!.role, ip: ctx.clientIp },
    );
    return json(out, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}
