# Portage — Enterprise Implementation Plan

## Context

Portage is a zero-fee, owner-direct real-estate marketplace launching in Regina, Saskatchewan. Research and analysis are complete (`analysis/`, 8 research streams). A security-first backend foundation is built and verified: **8 migrations / 32 tables applied to PostgreSQL 16, 91 tests passing, clean typecheck**.

This plan takes it from foundation to launchable product, adding: social login, OTP, an AWS-based notification stack, an admin dashboard, kill switches, hardened error handling, query optimization, and a formal SDLC.

**Constraint that shapes everything:** the business model is free-to-list, free-to-search. Marginal cost per listing must stay near zero, because every Canadian competitor that carried per-listing human cost against cyclical volume died (FairSquare, Properly, Unreserved, Homie). No salaried-agent equivalents anywhere in the architecture.

### Decisions locked (user-confirmed, 2026-08-28)

| Decision | Choice | Consequence |
|---|---|---|
| Auth | **Keep custom, add OAuth** | Session/CSRF/lockout model stays ours; +2 weeks vs Supabase Auth; portable to AWS later |
| WhatsApp | **Design for it, build later** | Channel interface now, adapter when Regina users ask |
| Maps | **Apple MapKit JS + Regina open data** | Apple renders; Apple never produces a stored coordinate |
| Backend language | **TypeScript/Node** | One language with the Next.js frontend, shared schemas |
| Hosting | **Vercel Pro + Supabase ca-central-1** | ~$25/mo incremental; Vercel Cron covers scheduled work |

### The Apple Maps constraint (decisive, drives WS3)

Apple's Developer Program Licence Agreement defines "Map Data" to **include latitude and longitude**; §2.5 forbids storing it beyond "temporary and limited" and §2.2 forbids use "as part of any secondary or derived database." Portage's permanent `properties.lat/lng` is exactly that.

An extracted clause also requires Map Data be displayed **only on an Apple map** — so geocode-with-Apple/render-elsewhere is barred. **The permitted split is the reverse: geocode elsewhere, render on Apple.**

**Architecture that satisfies this:**
- **Render** on Apple MapKit JS ($99/yr total; 200k loads/mo is ~2.7% of the 250k/day allowance)
- **Coordinates** from **City of Regina open data** — ~70k authoritative civic address points, free, permanently storable, better than any global geocoder for one city
- **Autocomplete** from our own gazetteer via `pg_trgm`, not `mapkit.Search` — dodges the licence *and* the quota
- **Polygon search** via PostGIS `ST_Contains` (MapKit has no built-in draw tool; build it, 1–2 days)
- **OG/social images** rendered from non-Apple tiles — link previewers cache permanently, which is third-party storage we cannot control

⚠️ **Two open items, both flagged UNVERIFIED:** `developer.apple.com` was egress-blocked during research, so licence text came via search extraction. **Send two written questions to Apple Developer Support before launch** (see WS3 gate). Also note **MapKit JS 6 (June 2026) introduced static domain-bound tokens** — simpler than the JWT path already built. Keep the JWT issuer (it works and is tested); evaluate static tokens as a simplification.

### Real-estate map licensing, for the record
Mapbox requires a negotiated annual Commercial Application License for real estate — **pay-as-you-go is not permitted**. Google's terms bar use "in a listings or directory service." Both are out on licensing, not price.

---

## Team & SDLC

Roles are hats, not headcount — a founder plus contractors can wear several. Each phase has an explicit **exit gate**; nothing proceeds on a red gate.

| Role | Owns | Key artefacts |
|---|---|---|
| **Architect** | System design, ADRs, security review, schema changes | ADRs in `docs/adr/`, threat model, migration approvals |
| **Business Analyst** | Requirements, acceptance criteria, regulatory traceability | User stories with AC, the compliance matrix in `analysis/05` |
| **Delivery Manager** | Sequencing, gates, risk register, vendor timelines | Sprint plan, risk register, gate sign-off |
| **Backend devs (2)** | Auth, notifications, listings, admin API | Code + tests; no PR merges without tests |
| **Frontend dev (1)** | Next.js app, map UI, admin dashboard | Components, Lighthouse/a11y budgets |
| **QA / SDET** | Test strategy, integration + load tests, security regression | CI suites, k6 load scripts |

**Cadence:** 2-week sprints. Definition of Done = tests written and passing, typecheck clean, migration reversible, ADR updated if a decision changed, and no new `TODO` without a ticket.

**Standing gates (every sprint):** `npm test` green · `npm run typecheck` clean · migrations apply on a fresh database · no secret in the diff · p95 latency budget met on touched endpoints.

---

## Architecture

```
Next.js (Vercel Pro, ca-central-1 functions)
├── app/(public)      SSR listing pages  ← SEO is the moat vs Realtor.ca
├── app/(app)         Authenticated dashboards
├── app/admin         Staff console (RBAC-gated)
└── app/api/*         Route handlers → backend modules

backend/src/
├── lib/              crypto · session · validate · ratelimit · errors   [BUILT]
├── db/               Sql interface + migrate runner                     [BUILT]
├── http/             guard · respond · headers · routes                 [BUILT]
└── modules/
    ├── auth/         + oauth/ + otp/ + linking/                         [EXTEND]
    ├── documents/    locker                                             [BUILT]
    ├── maps/         mapkit token issuer                                [BUILT]
    ├── notify/       channel interface + SES/SNS/WhatsApp adapters      [NEW]
    ├── flags/        kill switches                                      [NEW]
    ├── listings/     CRUD + state machine                               [NEW]
    ├── search/       filter DSL → SQL (the ONLY query builder)          [NEW]
    ├── geo/          Regina gazetteer, boundaries, scores               [NEW]
    ├── admin/        moderation queue, users, reports                   [NEW]
    └── jobs/         queue drained by Vercel Cron                       [NEW]

Supabase ca-central-1: Postgres + Storage
AWS: SES (email) · SNS/End User Messaging (SMS) · CloudWatch (alarms)
Apple: MapKit JS (render only)
```

---

## Workstreams

### WS0 — Foundations & debt (Sprint 1)

A full inventory of the existing code found gaps that must close before new features land. **Two are correctness bugs on serverless, not cleanup:**

| # | Gap | Why it matters | Fix |
|---|---|---|---|
| 1 | **`RateLimiter` is per-process** | On Vercel each warm instance keeps its own counters, so the real limit is `max × instances`. Login throttling is effectively bypassed under load. | Move to a Postgres-backed limiter (`rate_limit_buckets`, atomic upsert). Keep the in-memory class as an L1 cache. |
| 2 | **`migrate.ts` takes no advisory lock** | Two concurrent deploys race the same migration. | Wrap the run in `pg_advisory_lock`. |
| 3 | **No `src/index.ts`** | `npm run dev` and `npm start` both fail — nothing boots outside Next.js. | Add a `node:http` bootstrap for local dev and worker use. |
| 4 | **No object storage client** | `signStorageUrl` mints tokens but nothing exchanges them for a Supabase Storage / S3 presigned URL, and `verifyStorageUrl` has no caller. **The document locker cannot actually store bytes yet.** | Add `modules/storage/` and the upload-completion callback that writes the real `content_hash`. |
| 5 | **No password reset / change flow** | `revokeAllSessions()` and `LIMITS.passwordReset` exist unused. | Build it in WS1 alongside OTP. |
| 6 | **`collectExpired()` never called** | PIPEDA retention deletion does not happen. | Wire to the WS4 job runner. |
| 7 | **No `email_verified_at` flow** | The column and `verifications` table are unwritten — and OAuth account-linking safety depends on this being real. | Build in WS1 **before** OAuth linking. |
| 8 | **No CI, lint, or `vercel.json`** | Nothing enforces the gates below. | Add in this sprint. |

Also unrouted but built: `revokeShare` (no HTTP handler), `downloadHeaders()` (unused), `LIMITS.signup`/`upload` (defined, not wired).

**Migrations.** `backend/src/db/migrate.ts` already applies files in order, in a transaction, with checksums that refuse silently-edited history. Add:
- `009_flags.sql`, `010_oauth.sql`, `011_notify.sql`, `012_jobs.sql`, `013_gazetteer.sql`, `014_ratelimit.sql`
- **Down-migrations** — each `NNN_x.sql` gains `NNN_x.down.sql`; runner learns `migrate:down --to N`
- **Advisory lock** around the whole run (gap 2)
- **CI check** — apply all migrations to a scratch database on every PR; fail on drift
- **Seed script** — `npm run seed:regina` loads the open-data gazetteer + demo listings

**Environments.** local → preview (per-PR Vercel) → staging → production. Separate Supabase project per tier; **production secrets never in `.env`**, only in Vercel/AWS secret stores.

**Gate:** fresh-database migration passes in CI; rollback tested; seed produces a browsable local app; `npm run dev` boots; gaps 1–4 closed.

---

### WS1 — Identity (Sprints 2–3)

Extends `AuthService` in `backend/src/modules/auth/service.ts`. Reuse `lib/crypto.ts` (scrypt, tokens, timing-safe compare) and `lib/session.ts` (session material, CSRF) — do not re-implement.

**OAuth (Google + Facebook)** — `modules/auth/oauth/`
- **Authorization Code + PKCE**, state parameter bound to a short-lived signed cookie (CSRF on the callback)
- `id_token` verified against the provider JWKS: signature, `iss`, `aud`, `exp`, `nonce` — never trust the userinfo endpoint alone
- New table `oauth_identities(provider, provider_user_id, user_id, email_verified_at, linked_at)`, unique on `(provider, provider_user_id)`
- **Account linking rule (security-critical):** auto-link to an existing account *only* when the provider asserts `email_verified` **and** the local account's email is already verified. Otherwise require password or email-OTP proof. This is the account-takeover vector in every OAuth breach post-mortem.
- On success, mint a session via the existing `createSessionMaterial()` — one session model for all login methods

**OTP** — `modules/auth/otp/`
- 6 digits, **hashed at rest** (same discipline as sessions), 10-minute expiry, single-use, max 5 attempts then invalidate
- Rate limits: per-identifier and per-IP, reusing `lib/ratelimit.ts`
- **SMS OTP requires phone verification consent** and is gated by the notification layer's consent check
- Table `otp_challenges(id, user_id, channel, code_hash, purpose, attempts, expires_at, consumed_at)`

**Gate:** OAuth flows tested against provider sandboxes; linking-attack test suite (unverified-email link attempt must fail); OTP brute-force test.

---

### WS2 — Notifications (Sprints 3–4)

**One interface, three adapters.** `modules/notify/`

```ts
interface NotificationChannel {
  readonly kind: 'email' | 'sms' | 'whatsapp' | 'push';
  send(to: Recipient, template: TemplateId, vars: Vars): Promise<Receipt>;
}
```

- **EmailChannel — AWS SES.** SES pricing is uniform across regions; run it in `ca-central-1`. Configure SPF, DKIM, DMARC; a configuration set with event destinations for bounces/complaints. **Suppress on hard bounce and complaint** — sender reputation is not recoverable by apology.
- **SmsChannel — AWS End User Messaging.** Note SMS charges moved off the SNS bill to **AWS End User Messaging as of 2024-11-01**. Canadian long-code/short-code registration has lead time — start it in Sprint 3, not Sprint 6.
- **WhatsAppChannel — stub only.** Interface implemented, `send()` throws `NotConfiguredError`. Meta charges ~USD $0.025/message and requires Business verification; free only inside a 24-hour user-initiated window. Build when Regina users ask.

**Consent is enforced in code, not policy.** The `consents` table already exists and the schema already blocks `saved_searches.alert_enabled` without a consent row. Extend: `notify.send()` performs a consent lookup for any non-transactional message and **refuses to send** without a live row. CASL penalties reach $10M per violation.

**Templates** versioned in the repo, rendered server-side, with a plain-text alternative. Every outbound message carries sender identification and a working unsubscribe.

**Gate:** bounce/complaint handling verified against the SES mailbox simulator; a consent-less marketing send is provably impossible in test.

---

### WS3 — Listings, Search & Maps (Sprints 4–7)

**Listings** — publish state machine (`draft → pending_review → live → paused/rented/sold`), enforced by the existing status CHECK plus the `listings_publish_guard` trigger that already blocks unattested AI descriptions.

**Search** — `modules/search/` is the **only** place that builds listing SQL. AI chat search emits a validated `FilterSpec`; it never writes SQL and never invents listings.

**Regina gazetteer** — `modules/geo/`
- Ingest City of Regina **Address Points** (~70k) and **community association boundaries** from `open.regina.ca` (ArcGIS REST/JSON)
- `pg_trgm` GIN index on a normalized address column → autocomplete entirely in-database, $0/request, no storage-licence question
- Boundaries as GeoJSON → MapKit `importGeoJSON` overlays
- Transit scores computed from **Regina Transit GTFS**

**Map UI** — MapKit JS: custom DOM price bubbles, built-in clustering, `PolygonOverlay`. Build the polygon-draw tool (1–2 days) and resolve it server-side with PostGIS `ST_Contains`.

**Enable PostGIS** in this workstream — deferred until now deliberately; the gazetteer and polygon search are what justify it.

**Gate (blocking):** written answers received from **Apple Developer Support** on (a) permanence of stored coordinates sourced outside Apple, (b) display-only obligations for our own data on an Apple map. If the answers are unfavourable, swap to MapLibre + Protomaps PMTiles on Cloudflare R2 (~$0–10/mo) — contained because the map sits behind an interface.

---

### WS4 — Admin, Kill Switches & Moderation (Sprints 5–6)

**RBAC.** `users.role` already exists (`user|staff|admin`) but nothing reads it. Add `requireRole()` to `http/guard.ts`; every admin route asserts it; every admin action writes to the append-only `audit_log`.

**Admin dashboard** (`app/admin`, Next.js, server components):
- Moderation queue ordered by `risk_score` (the `moderation_queue` table and index exist)
- Listing review: approve / reject / request changes, with the automated-check results
- User management, abuse reports, document-access audit trail
- Ops view: job queue depth, failure counts, flag states

**Kill switches** — `modules/flags/`
- Table `feature_flags(key, enabled, rollout_pct, updated_by, updated_at)` + `audit_log` entry on every change
- **Two tiers:** *feature flags* (gradual rollout) and **kill switches** (instant global off) for: AI chat search, AI listing builder, AI moderation, OAuth per provider, SMS sending, email sending, new signups, new listings, document uploads
- Cached in-process with a short TTL; a **fail-safe default** — if the flag store is unreachable, AI and outbound-messaging features default **off**, core browsing defaults **on**
- Every AI call site and every outbound channel checks its switch. This is how you stop a runaway LLM bill or a mis-sent alert blast at 2am without a deploy.

**Gate:** flipping a kill switch takes effect in <30s without deploy; every admin action appears in `audit_log`; a non-staff user cannot reach any admin route (tested).

---

### WS5 — Reliability, Errors & Performance (continuous, hardened Sprint 7)

**Error handling.** `lib/errors.ts` already guarantees internal detail never reaches clients. Add:
- Correlation id propagated from `guard.ts` through logs to the response (`X-Request-Id` is already returned)
- **Structured JSON logs** with PII redaction — never log email, phone, address, or document titles
- Sentry for exceptions; CloudWatch alarms on SES bounce rate, job-queue depth, 5xx rate, p95 latency
- Typed retry policy: exponential backoff with jitter for transient AWS/provider failures; **idempotency keys on all sends** so a retry cannot double-send an SMS

**Performance budgets** (enforced in CI on touched endpoints):

| Surface | Budget |
|---|---|
| Listing search API p95 | < 300 ms |
| Listing detail SSR p95 | < 500 ms |
| Map viewport query p95 | < 200 ms |
| Admin queue load p95 | < 800 ms |

**Query optimization discipline:**
- `EXPLAIN (ANALYZE, BUFFERS)` on every query in the search path before merge; no sequential scan on `listings` in the browse path
- Covering indexes for the browse query; `listings_browse_idx` exists — extend as filters land
- **Keyset pagination**, never `OFFSET`, for infinite scroll
- **N+1 elimination**: listing cards fetch media in one `LATERAL` join, not per-row
- `pg_stat_statements` enabled; a weekly top-20-by-total-time review is a standing sprint task
- Connection pooling through the Supabase pooler (serverless opens a connection per invocation)
- Cache neighbourhood scores and AVM output (they change daily at most, not per request)

**Load testing** with k6 at 10× expected Regina peak before launch.

---

## Timeline

| Sprint | Weeks | Focus | Exit gate |
|---|---|---|---|
| 1 | 1–2 | WS0 foundations, CI, environments | Fresh-DB migrate + rollback in CI |
| 2 | 3–4 | OAuth (Google, Facebook) | Linking-attack suite passes |
| 3 | 5–6 | OTP + SES email; **start SMS registration** | Bounce handling verified |
| 4 | 7–8 | SMS channel; listings CRUD | Consent-less send impossible |
| 5 | 9–10 | Search + Regina gazetteer; admin skeleton | Autocomplete < 100 ms, $0/req |
| 6 | 11–12 | Map UI, polygon search; kill switches | Apple gate answered; switches < 30s |
| 7 | 13–14 | Moderation AI, admin complete, perf hardening | All budgets met under k6 |
| 8 | 15–16 | Security review, penetration test, launch prep | External review clean |

**Parallel, non-blocking:** Saskatchewan legal opinion (start Sprint 1 — it gates launch, not development); AWS SMS registration (Sprint 3); Apple Developer Support questions (Sprint 4).

---

## Files to create or modify

**Migrations (new):** `backend/migrations/009_flags.sql`, `010_oauth.sql`, `011_notify.sql`, `012_jobs.sql`, `013_gazetteer.sql`, plus a `.down.sql` per file.

**Extend (do not rewrite):**
- `backend/src/modules/auth/service.ts` — add OAuth and OTP entry points reusing `#issueSession()`
- `backend/src/http/guard.ts` — add `requireRole()` and flag checks
- `backend/src/db/migrate.ts` — down-migrations
- `backend/src/config/env.ts` — AWS, OAuth, flag config; keep the all-or-nothing validation pattern used for MapKit

**New modules:** `modules/notify/{index,channels/{email,sms,whatsapp},consent}.ts` · `modules/flags/` · `modules/listings/` · `modules/search/` · `modules/geo/` · `modules/admin/` · `modules/jobs/`

**Frontend:** `app/(public)/listings/`, `app/(app)/dashboard/`, `app/admin/`, `components/map/` (MapKit behind an interface).

---

## Verification

**Per sprint:** `npm test` (91 tests today, growing) · `npm run typecheck` · migrations apply and roll back on a scratch DB · `EXPLAIN` reviewed for new queries.

**Test-coverage debt to close alongside features.** All 91 existing tests are pure unit tests — **no test touches a database**. `AuthService`, `DocumentService`, `migrate.ts`, `env.ts` and every route handler are currently untested against real Postgres. WS0 adds an integration harness (ephemeral database per run, migrations applied, truncate between tests); from Sprint 2 onward every new service ships with integration tests, and the existing four get backfilled.

**Security regression suite** (extends `test/security.test.ts`, `test/http.test.ts`):
- OAuth: unverified-email auto-link must fail; state/PKCE mismatch must fail; forged `id_token` must fail
- OTP: brute force locks out; expired and reused codes rejected
- RBAC: non-staff blocked from every admin route
- Kill switch: disabling a channel provably prevents sending
- Consent: marketing send without a live consent row is impossible

**Integration** against a live Postgres: auth flows end-to-end, document access control, moderation queue transitions.

**Load:** k6 at 10× Regina peak — 500 concurrent searchers, 50 concurrent uploads.

**Pre-launch:** external penetration test; `/security-review` on the full diff; Saskatchewan counsel sign-off; Apple Developer Support answers received.

---

## Risks

| Risk | Mitigation |
|---|---|
| **Apple licence forbids the architecture** | Gate in Sprint 6; MapLibre + PMTiles fallback (~$0–10/mo), contained by the map interface |
| **Apple 25k/day service-call quota** — 429s, no overage tier, no paid escape | Our own gazetteer avoids `mapkit.Search` entirely; monitor and alarm |
| **AWS SMS registration delay** | Start Sprint 3; email-first fallback if it slips |
| **SK licensing opinion unfavourable** | Legal opinion started Sprint 1; fallback is the licensed-brokerage model (Bōde's structure) |
| **Runaway AI cost** | Per-feature kill switches + budget alarms + Haiku for high-volume moderation |
| **Cold start — no listings** | Demand-side value ships first (AVM, scores, search over aggregated data); rentals before resale |
