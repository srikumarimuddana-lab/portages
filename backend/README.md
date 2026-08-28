# Portage Backend

TypeScript/Node backend for the Portage marketplace. Built security-first: the
properties that matter are enforced by the database and covered by tests, not
left to code review.

## Status

| Layer | State | Verified |
|---|---|---|
| Database schema (8 migrations, 32 tables/views) | Complete | ✅ Applied to PostgreSQL 16; 12 invariants tested |
| Security core (crypto, sessions, CSRF, rate limiting, validation) | Complete | ✅ 56 tests passing |
| Document locker policy | Complete | ✅ Covered by tests |
| Auth service | Complete | Typechecked; needs integration tests against a live DB |
| HTTP layer (guard, responses, auth + document routes) | Complete | ✅ 24 tests passing |
| Document locker service | Complete | Typechecked; needs integration tests |
| Next.js route adapters | Complete | See `examples/nextjs/` |
| Listings, search, messaging, AI modules | Not started | — |

## Quick start

```bash
createdb portage_dev
cp .env.example .env          # then fill in the three secrets
npm install
npm run migrate
npm test
```

Generate each secret separately — never reuse one value across two variables:

```bash
openssl rand -base64 48
```

## Design decisions worth knowing

**One runtime dependency.** Only `pg`. Everything else — password hashing,
session tokens, CSRF, rate limiting, request validation — is Node standard
library. That is a deliberate supply-chain choice for a security boundary.

`src/lib/validate.ts` is shaped like Zod so swapping to it is mechanical if you
prefer. If you do, keep the two behaviours that matter: **unknown object keys
must be rejected** (the mass-assignment guard) and **strings must be bounded by
default**.

**PostGIS is optional, not assumed.** Geo search uses an indexed
bounding-box + haversine filter, which is comfortably fast at single-city
scale. Enable PostGIS and switch `properties.lat/lng` to
`geography(Point,4326)` when a second province makes it worthwhile.

**No payment rails, ever, in this codebase.** Handling rent or deposits would
trigger FINTRAC money-services-business registration and Bank of Canada
registration under the Retail Payment Activities Act. The document locker
stores paperwork the user already has; it does not generate, sign, or process
anything.

## The request guard

Every route passes through `src/http/guard.ts`, which runs its checks in
increasing order of cost so an attacker cannot make the server do expensive
work before being rejected:

1. Method and content type (free)
2. Origin allowlist — blocks cross-site writes immediately
3. Rate limit — keyed by a pseudonymized IP
4. Body size cap, then JSON parse
5. Session lookup (one indexed query)
6. CSRF — constant-time compare against the digest stored on the session
7. Schema validation — only now is the payload's shape examined

Authentication runs before CSRF deliberately: the CSRF token is verified
against material stored on the session, so the session must resolve first.

No route accepts an owner id from the client. The principal always comes from
the session — that is the difference between access control and a suggestion.

## Security properties (all covered by `test/security.test.ts` and `test/http.test.ts`)

| Property | How |
|---|---|
| Passwords are never recoverable | scrypt, per-user salt, N=2^16 (configurable), encoded with parameters so they can be strengthened later |
| A database dump yields no usable sessions | Only SHA-256 digests of session and CSRF tokens are stored |
| No session fixation | A fresh token is minted on every login |
| Bounded session lifetime | 30-minute idle expiry and a hard 14-day ceiling; idle renewal never crosses the ceiling |
| CSRF | Double-submit cookie + header, both compared against the server-side digest — so an attacker who can set cookies still cannot forge a write |
| Cookie theft via XSS | `HttpOnly`, `SameSite=Lax`, `Secure`, and the `__Host-` prefix (which browsers enforce: Secure, Path=/, no Domain) |
| No user enumeration | Login always runs a real scrypt verification, even for unknown accounts, so timing is flat; signup and login return identical shapes |
| Credential stuffing | Account-scoped exponential lockout (1 min → 1 hour), because distributed attacks rotate IPs and defeat IP-only limits |
| SQL injection | The `Sql` interface exposes no method that accepts an interpolated string — parameterized queries only |
| Mass assignment | Unknown fields are an error, not silently dropped |
| Prototype pollution | `__proto__`/`constructor`/`prototype` keys rejected; parsed objects have a null prototype |
| Path traversal on uploads | Storage keys are built from UUIDs only; no caller-controlled path segment exists |
| Stored XSS via uploads | MIME allowlist (no wildcards), declared type must match the file extension, downloads are `attachment` + `nosniff` + sandboxed CSP |
| Leaked download URLs | HMAC-signed, 5-minute expiry, bound to both the object key and the user it was issued to |
| Unbounded requests | 256 KB JSON cap, per-field string caps, array length caps |
| Internal detail leaking to clients | Only `AppError` messages are returned; anything else becomes a generic 500 with a correlation id |

## Database-enforced invariants

These hold even if application code is wrong — verified by running them against
a live database:

- A property can have only one `live` listing at a time.
- An AI-authored description **cannot be published** without owner attestation
  (`listings_publish_guard` trigger) — Competition Act s.74.01 exposure.
- A saved search **cannot enable alerts** without a linked consent row
  (`alert_requires_consent`) — CASL penalties reach $10M per violation.
- `audit_log` and `document_access_log` reject `UPDATE` and `DELETE` for every
  role, including the owner.
- AVM bands must be ordered (`low ≤ value ≤ high`).
- Reviews require a verifiable basis (a completed booking or verified tenancy).
- Emails are case-insensitively unique (`citext`).
- A thread cannot have the same user on both sides.

## What is deliberately absent from the schema

`verifications` has **no column for an ID image or document number**. The OPC
advises that copying government ID "should not be a standard operating
practice" and has found indefinite retention of ID data to violate PIPEDA. The
verification vendor performs the check; we store the verdict, the provider
reference, and a hash for audit correlation. The image never reaches our
storage — so it cannot leak from it.

## Layout

```
migrations/          8 SQL files, applied in order, checksummed
src/
  config/env.ts      Validated at startup; secrets have no defaults
  db/pool.ts         Sql interface (parameterized only) + pg implementation
  db/migrate.ts      Runner; refuses to proceed if an applied file was edited
  lib/crypto.ts      scrypt, tokens, timing-safe compare, signed URLs
  lib/session.ts     Session lifetime, CSRF, hardened cookie serialization
  lib/ratelimit.ts   Sliding window + account lockout
  lib/validate.ts    Strict schema validation (Zod-shaped, zero-dep)
  lib/errors.ts      Error taxonomy; internal detail never reaches clients
  http/headers.ts    CSP, CORS allowlist, download headers
  modules/auth/      Signup, login, session resolution, revocation
  modules/documents/ Locker policy: allowlist, quota, retention, access
test/                56 security tests, no test framework required
typecheck/           Local-only Node type shim — delete after npm install
```

## Deployment notes

The database and object storage must sit in a **Canadian region**
(`ca-central-1`). The document locker and verification records are the
crown-jewel PIPEDA risk; compute location is a lesser concern than data at
rest.

On serverless platforms, connect through a pooler rather than raising `max` in
`pool.ts` — a connection per invocation will exhaust Postgres.

Scheduled work — moderation triage, alert sweeps, AVM recalculation, retention
deletes — has no HTTP request to run inside. The queue lives in Postgres
(`moderation_queue`, and `messages.moderation_verdict = 'pending'`), so any
scheduler that can call an endpoint on a cadence will drain it.

At single-city scale, **Vercel Cron on the Pro plan is sufficient**: 100 cron
jobs per project, per-minute cadence, 300-second max function duration. The
jobs Portage needs finish in seconds — evaluating a few thousand saved
searches, deleting a handful of expired documents, classifying the listings
submitted in the last minute.

A separate always-on worker only becomes necessary when a job cannot finish
within the function timeout and cannot be chunked across runs — a bulk
re-moderation of the entire corpus, or a full AVM rebuild. Design jobs to
process a bounded batch per invocation and that day stays far off.

Note that Vercel Cron schedules are UTC only; convert Regina times (CST, UTC-6)
before writing a schedule.

## Next

1. HTTP transport wiring `http/headers.ts` + auth middleware into routes.
2. Listings and search modules over the `Sql` interface.
3. Integration tests against a live database (auth flows, document access).
4. Worker: moderation triage, retention deletion, alert dispatch.
5. Claude integration for chat search, listing builder, and moderation triage.
