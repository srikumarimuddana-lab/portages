/**
 * Document locker routes.
 *
 * Note what is absent: no route accepts an ownerId from the client. The owner
 * is always taken from the authenticated session. That is the difference
 * between an access-control system and a suggestion.
 */
import * as v from '../../lib/validate.js';
import { guard, type GuardConfig } from '../guard.js';
import { json, noContent, errorResponse, type ResponseContext } from '../respond.js';
import { DOCUMENT_KINDS } from '../../modules/documents/policy.js';
import type { DocumentService } from '../../modules/documents/service.js';

export interface DocRouteDeps {
  cfg: GuardConfig;
  documents: DocumentService;
  hsts: boolean;
}

const createUploadBody = v.object({
  title: v.string({ min: 1, max: 200 }),
  kind: v.enumOf(DOCUMENT_KINDS),
  mime: v.string({ max: 120 }),
  bytes: v.integer({ min: 1, max: 25 * 1024 * 1024 }),
  filename: v.string({ min: 1, max: 255 }),
  propertyId: v.optional(v.uuid()),
  threadId: v.optional(v.uuid()),
});

const shareBody = v.object({
  userId: v.uuid(),
  expiresInDays: v.integer({ min: 1, max: 90 }),
});

function ctxOf(requestId: string, origin: string | undefined, deps: DocRouteDeps): ResponseContext {
  return { requestId, origin, allowedOrigins: deps.cfg.allowedOrigins, hsts: deps.hsts };
}

export async function listDocuments(req: Request, deps: DocRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const docs = await deps.documents.list(
      ctx.principal!.userId,
      Number.isFinite(limit) ? limit : 50,
      Number.isFinite(offset) ? offset : 0,
    );
    return json({ documents: docs }, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

export async function createUpload(req: Request, deps: DocRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{
      title: string; kind: never; mime: string; bytes: number;
      filename: string; propertyId?: string; threadId?: string;
      // The other ticket-issuing route. A kill switch that stopped listing
      // photos but left the document locker taking bytes would be a switch
      // that does not do what its label says.
    }>(req, deps.cfg, {
      requireAuth: true, limit: 'write', body: createUploadBody,
      requireFlag: 'uploads.new',
    });
    id = ctx.requestId; origin = ctx.origin;

    const ticket = await deps.documents.createUpload({
      ownerId: ctx.principal!.userId,   // never from the request body
      title: body.title,
      kind: body.kind,
      mime: body.mime,
      bytes: body.bytes,
      filename: body.filename,
      propertyId: body.propertyId,
      threadId: body.threadId,
    });
    return json(ticket, ctxOf(ctx.requestId, ctx.origin, deps), 201);
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

export async function createDownload(req: Request, documentId: string, deps: DocRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'read' });
    id = ctx.requestId; origin = ctx.origin;
    const out = await deps.documents.createDownload(documentId, ctx.principal!.userId);
    return json(out, ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

export async function shareDocument(req: Request, documentId: string, deps: DocRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx, body } = await guard<{ userId: string; expiresInDays: number }>(
      req, deps.cfg, { requireAuth: true, limit: 'write', body: shareBody },
    );
    id = ctx.requestId; origin = ctx.origin;
    const expiresAt = new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000);
    await deps.documents.share(documentId, ctx.principal!.userId, body.userId, expiresAt);
    return json({ sharedWith: body.userId, expiresAt }, ctxOf(ctx.requestId, ctx.origin, deps), 201);
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}

export async function deleteDocument(req: Request, documentId: string, deps: DocRouteDeps): Promise<Response> {
  let id = '', origin: string | undefined;
  try {
    const { ctx } = await guard(req, deps.cfg, { requireAuth: true, limit: 'write' });
    id = ctx.requestId; origin = ctx.origin;
    await deps.documents.remove(documentId, ctx.principal!.userId);
    return noContent(ctxOf(ctx.requestId, ctx.origin, deps));
  } catch (err) {
    return errorResponse(err, ctxOf(id || 'unknown', origin, deps));
  }
}
