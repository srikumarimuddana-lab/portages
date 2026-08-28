# Next.js wiring

The backend modules are framework-agnostic: they take Web `Request` and return
Web `Response`, which is exactly what Next.js App Router route handlers use.
Each file below is a thin adapter — no logic lives here.

Copy `app/` into your Next.js project and point the import path at the backend
package (or move `src/` into the same repo and import relatively).

Set `export const runtime = 'nodejs'` on every route: the security core uses
`node:crypto` scrypt, which the Edge runtime does not provide.
