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
  route('GET', '/api/auth/oauth/:provider', (req, p) => oauthStart(req, p['provider']!, oauthDeps));
  route('GET', '/api/auth/oauth/:provider/callback',
    (req, p) => oauthCallback(req, p['provider']!, oauthDeps));

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
