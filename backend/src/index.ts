/**
 * Local development server and worker entrypoint.
 *
 * Production serves the API through Next.js route handlers on Vercel (see
 * examples/nextjs/), which call the same module functions this file routes to.
 * This exists so `npm run dev` works without a Next.js app, and so the worker
 * has somewhere to live outside a request-scoped serverless runtime.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { getApp } from './http/app.js';
import { signup, login, logout, me } from './http/routes/auth.js';
import {
  listDocuments,
  createUpload,
  createDownload,
  shareDocument,
  deleteDocument,
} from './http/routes/documents.js';
import { mapkitToken } from './http/routes/maps.js';
import { oauthStart, oauthCallback } from './http/routes/oauth.js';
import {
  requestEmailVerification, confirmEmailVerification,
  requestPasswordReset, confirmPasswordReset,
} from './http/routes/otp.js';
import {
  getListing, listMine, createListing, updateListing, transitionListing,
  attestDescription, addPhoto, removePhoto, reorderPhotos,
} from './http/routes/listings.js';
import {
  searchListings, countListings, autocomplete, neighbourhoods, geoHealth,
} from './http/routes/search.js';
import { completeUpload, recordPreview } from './http/routes/uploads.js';
import {
  listThreads, unreadCount, getThread, startThread, replyToThread,
  markThreadRead, archiveThread, blockThread, unblockThread, listingThreads,
} from './http/routes/messages.js';
import {
  listQueue, queueStats, getQueueItem, dismissQueueItem,
  decideListing, reviewMessage, decideMessage, listAudit,
  listFlags,
  setFlag,
} from './http/routes/admin.js';
import { aiSearch, describeListing } from './http/routes/ai.js';
import { preflight } from './http/respond.js';

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;

/**
 * Routes are matched by method plus a path pattern with `:name` segments.
 * Deliberately tiny: on Vercel the framework does this, and duplicating a
 * router's feature set here would be code that production never exercises.
 */
const ROUTES: Array<{ method: string; pattern: string; handler: Handler }> = [];

function route(method: string, pattern: string, handler: Handler): void {
  ROUTES.push({ method, pattern, handler });
}

function match(pathname: string, pattern: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const got = pathname.split('/').filter(Boolean);
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    const w = want[i]!;
    const g = got[i]!;
    if (w.startsWith(':')) params[w.slice(1)] = decodeURIComponent(g);
    else if (w !== g) return null;
  }
  return params;
}

async function buildRoutes(): Promise<void> {
  const app = await getApp();
  const authDeps = {
    cfg: app.cfg,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
  };
  const docDeps = { cfg: app.cfg, documents: app.documents, hsts: app.hsts };

  route('POST', '/api/auth/signup', (req) => signup(req, authDeps));
  route('POST', '/api/auth/login', (req) => login(req, authDeps));
  route('POST', '/api/auth/logout', (req) => logout(req, authDeps));
  route('GET', '/api/auth/me', (req) => me(req, authDeps));

  const oauthDeps = {
    cfg: app.cfg,
    oauth: app.oauth,
    auth: app.auth,
    secureCookies: app.secureCookies,
    hsts: app.hsts,
    appOrigin: app.env.publicOrigin || `http://localhost:${app.env.port}`,
  };
  const otpDeps = {
    cfg: app.cfg,
    flows: app.otpFlows,
    hsts: app.hsts,
    identifierLimiter: app.identifierLimiter,
  };
  route('POST', '/api/auth/verify-email/request', (req) => requestEmailVerification(req, otpDeps));
  route('POST', '/api/auth/verify-email/confirm', (req) => confirmEmailVerification(req, otpDeps));
  route('POST', '/api/auth/password-reset/request', (req) => requestPasswordReset(req, otpDeps));
  route('POST', '/api/auth/password-reset/confirm', (req) => confirmPasswordReset(req, otpDeps));

  route('GET', '/api/auth/oauth/:provider', (req, p) => oauthStart(req, p['provider']!, oauthDeps));
  route('GET', '/api/auth/oauth/:provider/callback',
    (req, p) => oauthCallback(req, p['provider']!, oauthDeps));

  const searchDeps = {
    cfg: app.cfg, search: app.search, gazetteer: app.gazetteer, hsts: app.hsts,
  };
  route('GET', '/api/search/listings', (req) => searchListings(req, searchDeps));
  route('GET', '/api/search/count', (req) => countListings(req, searchDeps));
  route('GET', '/api/geo/autocomplete', (req) => autocomplete(req, searchDeps));
  route('GET', '/api/geo/neighbourhoods', (req) => neighbourhoods(req, searchDeps));
  route('GET', '/api/geo/health', (req) => geoHealth(req, searchDeps));

  const uploadDeps = { cfg: app.cfg, uploads: app.uploads, hsts: app.hsts };
  route('POST', '/api/uploads/complete', (req) => completeUpload(req, uploadDeps));
  route('POST', '/api/uploads/preview', (req) => recordPreview(req, uploadDeps));

  // Admin. Every one of these answers 404 to a caller without the role.
  const aiDeps = {
    cfg: app.cfg, chatSearch: app.chatSearch, listingBuilder: app.listingBuilder,
    search: app.search, gazetteer: app.gazetteer, listings: app.listings,
    metered: app.metered, aiLimiter: app.aiLimiter, hsts: app.hsts,
  };
  route('POST', '/api/search/ai', (req) => aiSearch(req, aiDeps));
  route('POST', '/api/listings/:id/describe',
    (req, p) => describeListing(req, p['id']!, aiDeps));

  const adminDeps = {
    cfg: app.cfg, db: app.db, moderation: app.moderation, listings: app.listings,
    messaging: app.messaging, audit: app.audit, flags: app.flags, hsts: app.hsts,
  };
  route('GET', '/api/admin/queue/stats', (req) => queueStats(req, adminDeps));
  route('GET', '/api/admin/queue', (req) => listQueue(req, adminDeps));
  route('GET', '/api/admin/queue/:id', (req, p) => getQueueItem(req, p['id']!, adminDeps));
  route('POST', '/api/admin/queue/:id/dismiss',
    (req, p) => dismissQueueItem(req, p['id']!, adminDeps));
  route('POST', '/api/admin/listings/:id/decide',
    (req, p) => decideListing(req, p['id']!, adminDeps));
  route('GET', '/api/admin/messages/:id', (req, p) => reviewMessage(req, p['id']!, adminDeps));
  route('POST', '/api/admin/messages/:id/decide',
    (req, p) => decideMessage(req, p['id']!, adminDeps));
  route('GET', '/api/admin/audit', (req) => listAudit(req, adminDeps));
  route('GET', '/api/admin/flags', (req) => listFlags(req, adminDeps));
  route('POST', '/api/admin/flags/:key', (req, p) => setFlag(req, p['key']!, adminDeps));

  const msgDeps = {
    cfg: app.cfg, messaging: app.messaging, hsts: app.hsts,
    enquiryLimiter: app.enquiryLimiter,
  };
  // `/unread` before `/:id`, or the literal is read as a thread id.
  route('GET', '/api/threads/unread', (req) => unreadCount(req, msgDeps));
  route('GET', '/api/threads', (req) => listThreads(req, msgDeps));
  route('POST', '/api/threads', (req) => startThread(req, msgDeps));
  route('GET', '/api/threads/:id', (req, p) => getThread(req, p['id']!, msgDeps));
  route('POST', '/api/threads/:id/messages', (req, p) => replyToThread(req, p['id']!, msgDeps));
  route('POST', '/api/threads/:id/read', (req, p) => markThreadRead(req, p['id']!, msgDeps));
  route('PUT', '/api/threads/:id/archive', (req, p) => archiveThread(req, p['id']!, msgDeps));
  route('POST', '/api/threads/:id/block', (req, p) => blockThread(req, p['id']!, msgDeps));
  route('DELETE', '/api/threads/:id/block', (req, p) => unblockThread(req, p['id']!, msgDeps));

  const listingDeps = { cfg: app.cfg, listings: app.listings, hsts: app.hsts };
  // `/mine` is registered before `/:id`. Matching is first-wins, so the
  // literal must come first or "mine" is read as a listing id.
  route('GET', '/api/listings/mine', (req) => listMine(req, listingDeps));
  route('POST', '/api/listings', (req) => createListing(req, listingDeps));
  route('GET', '/api/listings/:id', (req, p) => getListing(req, p['id']!, listingDeps));
  route('PATCH', '/api/listings/:id', (req, p) => updateListing(req, p['id']!, listingDeps));
  route('POST', '/api/listings/:id/transition',
    (req, p) => transitionListing(req, p['id']!, listingDeps));
  route('POST', '/api/listings/:id/attest',
    (req, p) => attestDescription(req, p['id']!, listingDeps));
  route('POST', '/api/listings/:id/photos', (req, p) => addPhoto(req, p['id']!, listingDeps));
  route('PUT', '/api/listings/:id/photos/order',
    (req, p) => reorderPhotos(req, p['id']!, listingDeps));
  route('DELETE', '/api/listings/:id/photos/:photoId',
    (req, p) => removePhoto(req, p['id']!, p['photoId']!, listingDeps));
  route('GET', '/api/listings/:id/threads', (req, p) => listingThreads(req, p['id']!, msgDeps));

  route('GET', '/api/documents', (req) => listDocuments(req, docDeps));
  route('POST', '/api/documents', (req) => createUpload(req, docDeps));
  route('GET', '/api/documents/:id/download', (req, p) => createDownload(req, p['id']!, docDeps));
  route('POST', '/api/documents/:id/share', (req, p) => shareDocument(req, p['id']!, docDeps));
  route('DELETE', '/api/documents/:id', (req, p) => deleteDocument(req, p['id']!, docDeps));

  if (app.mapkit) {
    const mapDeps = {
      cfg: app.cfg,
      mapkit: app.mapkit,
      tokenOrigin: app.env.allowedOrigins[0],
      hsts: app.hsts,
    };
    route('GET', '/api/maps/token', (req) => mapkitToken(req, mapDeps));
  }
}

/** Bridges Node's IncomingMessage to the Web Request the handlers expect. */
async function toWebRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const url = new URL(req.url ?? '/', origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  let body: string | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    body = Buffer.concat(chunks).toString('utf8');
  }
  return new Request(url.toString(), { method, headers, ...(body ? { body } : {}) });
}

async function send(res: ServerResponse, web: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  web.headers.forEach((value, key) => {
    // Set-Cookie must stay as separate header lines, never comma-joined.
    if (key.toLowerCase() === 'set-cookie') return;
    headers[key] = value;
  });
  const cookies = web.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(web.status, headers);
  const text = await web.text();
  res.end(text);
}

async function main(): Promise<void> {
  const app = await getApp();
  await buildRoutes();

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const selfOrigin = `http://localhost:${app.env.port}`;
        const webReq = await toWebRequest(req, selfOrigin);
        const { pathname } = new URL(webReq.url);

        if (webReq.method === 'OPTIONS') {
          return send(res, preflight({
            requestId: 'preflight',
            origin: webReq.headers.get('origin') ?? undefined,
            allowedOrigins: app.cfg.allowedOrigins,
            hsts: app.hsts,
          }));
        }

        if (pathname === '/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true }));
        }

        for (const r of ROUTES) {
          if (r.method !== webReq.method) continue;
          const params = match(pathname, r.pattern);
          if (params) return send(res, await r.handler(webReq, params));
        }

        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'not_found', message: 'Not found.' } }));
      } catch (err) {
        console.error(JSON.stringify({ level: 'error', message: String(err) }));
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
        }
        res.end(JSON.stringify({ error: { code: 'internal_error' } }));
      }
    })();
  });

  server.listen(app.env.port, () => {
    console.log(`portage backend listening on http://localhost:${app.env.port}`);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
