# 07 — Backend Architecture

> Answers "what is the backend for this." Sized for 1–3 developers, near-zero marginal cost per listing, and Canadian data residency. Assumes the MVP scope from doc 04 (no payment rails, no lease generation, document locker only).

## 1. Shape of the system

**One deployable monolith + one background worker + Postgres.** Not microservices. At Regina scale (thousands of listings, tens of thousands of messages) a modular monolith is faster to build, cheaper to run, and easier for one person to debug at 2am.

```
                    ┌─────────────────────────────┐
   Browser / PWA ──▶│  Next.js (App Router)       │
                    │  ─ SSR pages (SEO)          │
                    │  ─ Route handlers = API     │
                    │  ─ Server Actions (forms)   │
                    └───────────┬─────────────────┘
                                │
              ┌─────────────────┼──────────────────┐
              ▼                 ▼                  ▼
      ┌───────────────┐  ┌─────────────┐   ┌──────────────┐
      │ PostgreSQL    │  │  S3 bucket  │   │  Worker      │
      │ + PostGIS     │  │  (private)  │   │  (pg-boss)   │
      │ + pgvector    │  │  signed URLs│   │  ─ AI jobs   │
      │ + pg_cron     │  └─────────────┘   │  ─ moderation│
      └───────────────┘                    │  ─ alerts    │
                                           │  ─ AVM recalc│
                                           └──────┬───────┘
                                                  │
                    ┌─────────────────────────────┴────────────┐
                    ▼            ▼           ▼            ▼
              Claude API   ID verify KYC   Email/SMS   Map tiles
```

**Why a single Postgres does almost everything:**

| Need | Postgres feature | Avoids |
|---|---|---|
| Geo search (radius, polygon, bounding box) | **PostGIS** | A separate geo service |
| Listing search + facets | **Full-text search** (`tsvector`, GIN) | Elasticsearch |
| Listing/neighbourhood Q&A (C5) | **pgvector** | Pinecone/Weaviate |
| Background jobs | **pg-boss** (job queue in Postgres) | Redis + BullMQ |
| Scheduled jobs (alerts, AVM refresh) | **pg_cron** | A separate scheduler |
| Realtime chat delivery | **LISTEN/NOTIFY** → SSE | Websocket infra, Pusher |

That's five services you don't run. For a team this size, that is the difference between shipping and not.

## 2. Data model (core tables)

```sql
-- ── identity ────────────────────────────────────────────────
users                 id, email, phone, created_at, status
user_profiles         user_id, full_name, preferred_cities[], notif_prefs jsonb
verifications         user_id, kind(id_document|phone|email), status,
                      verified_at, provider, provider_ref,
                      result_hash,          -- NOT the ID image
                      expires_at
-- Never store the ID image. Store pass/fail + an audit hash. (PIPEDA, doc 05)

-- ── inventory ───────────────────────────────────────────────
properties            id, address_raw, address_norm, unit,
                      geom geography(Point,4326),   -- PostGIS
                      city, province, postal_code,
                      neighbourhood_id, assessment_ref
listings              id, property_id, owner_id, mode(sale|rent),
                      status(draft|pending_review|live|paused|rented|sold|rejected),
                      price_cents, room_type(entire|private|shared),
                      beds, baths, sqft, property_type,
                      amenities text[], description, description_source(human|ai),
                      description_attested_at,      -- owner sign-off, Competition Act
                      published_at, expires_at,
                      search_vector tsvector          -- GIN indexed
listing_media         listing_id, s3_key, kind(photo|tour_3d), position, phash
listing_events        listing_id, kind(view|save|message|share), at, actor_hash

-- ── demand side ─────────────────────────────────────────────
saved_listings        user_id, listing_id, created_at
saved_searches        id, user_id, query jsonb, frequency, alert_enabled,
                      consent_id                       -- CASL link
consents              id, user_id, kind(alerts|marketing), method, evidence jsonb,
                      granted_at, revoked_at           -- the CASL ledger

-- ── conversation ────────────────────────────────────────────
threads               id, listing_id, owner_id, inquirer_id, status, last_at
messages              id, thread_id, sender_id, body, kind(text|voice|system),
                      moderation_verdict, moderation_at
message_attachments   message_id, s3_key, mime, scan_status
viewings              id, listing_id, requested_by, slot_start, slot_end, status

-- ── documents (D1) ──────────────────────────────────────────
documents             id, owner_id, title, kind(agreement|invoice|receipt|
                      inspection|other), s3_key, mime, size_bytes,
                      property_id NULL, thread_id NULL,
                      created_at, retention_until, deleted_at
document_shares       document_id, shared_with_user_id, expires_at, revoked_at

-- ── services marketplace ────────────────────────────────────
pros                  id, business_name, categories[], city, status,
                      licence_verified_at, insurance_expires_at   -- E4 evidence file
pro_credentials       pro_id, kind(trade_licence|insurance|wcb), ref,
                      verified_at, expires_at, evidence_s3_key
quote_requests        id, homeowner_id, category, detail, selected_pro_ids[]  -- E1
bookings              id, quote_request_id, pro_id, status, scheduled_for
reviews               id, subject_type(pro|listing|building), subject_id,
                      author_id, rating, body, verified_basis

-- ── trust & admin ───────────────────────────────────────────
moderation_queue      id, subject_type, subject_id, reason, risk_score,
                      ai_verdict jsonb, human_verdict, decided_by, decided_at
reports               id, reporter_id, subject_type, subject_id, kind,
                      severity, status
risk_signals          subject_type, subject_id, signal, weight, at   -- B1 inputs
audit_log             actor_id, action, subject, before jsonb, after jsonb, at

-- ── derived data ────────────────────────────────────────────
neighbourhoods        id, name, boundary geography(Polygon,4326), city
neighbourhood_scores  neighbourhood_id, kind(transit|schools|quiet), value,
                      method_version, computed_at
avm_estimates         property_id, value_cents, low_cents, high_cents,
                      confidence, model_version, computed_at
comparables           property_id, comp_property_id, similarity, source
```

**Indexing that matters:** `GIST` on `properties.geom`, `GIN` on `listings.search_vector` and `listings.amenities`, composite `(status, mode, city, price_cents)` for the main browse query, and `phash` on media for reverse-image duplicate detection (B1).

## 3. Service modules inside the monolith

| Module | Responsibility |
|---|---|
| `listings` | CRUD, publish state machine, search queries |
| `search` | Filter DSL → SQL; the *only* place that builds queries (the AI calls into this, never generates SQL) |
| `trust` | Verification orchestration, risk scoring, moderation queue |
| `ai` | Claude calls: chat search, listing builder, description, moderation triage |
| `messaging` | Threads, delivery, attachment scanning |
| `documents` | Locker: upload, share, retention, deletion |
| `services` | Pros, credentials, quote requests, bookings |
| `notify` | Email/SMS/push **behind the consent ledger** — nothing sends without a consent check |
| `geo` | Neighbourhood scores, GTFS transit computation, boundaries |
| `valuation` | Comparables + AVM |
| `admin` | Review queues, user management, reports |

**Rule:** `notify` and `ai` are the only modules that talk to external paid APIs. That keeps cost control and rate limiting in two files.

## 4. The AI pipeline (this is the cost-structure decision)

Four jobs, three models. From the current Claude pricing table:

| Model | Input $/1M | Output $/1M |
|---|---|---|
| Claude Opus 5 (`claude-opus-5`) | $5.00 | $25.00 |
| Claude Sonnet 5 (`claude-sonnet-5`) | $2.00 | $10.00 |
| Claude Haiku 4.5 (`claude-haiku-4-5`) | $1.00 | $5.00 |

| Job | Model | Why | Volume |
|---|---|---|---|
| **Moderation triage** (B1/B2) — every listing + every message | **Haiku 4.5** | Classification. High volume, low complexity. Runs on the worker, async | Highest |
| **NL search → filters** (A5) | **Sonnet 5** | Needs reliable structured tool-calling, low latency, user-facing | High |
| **Listing builder chat** (A6) + description (A9) | **Opus 5** | Multi-turn extraction where quality shows in the product | Low (once per listing) |
| **Listing Q&A** (C5) | **Sonnet 5** + pgvector retrieval | Retrieval does the work; model summarizes | Medium |

**Three cost controls, built in from day one:**

1. **Prompt caching.** The system prompt, filter schema, and tool definitions are identical on every search call. Put them first and cache them — cache reads are far cheaper than fresh input. Verify with `usage.cache_read_input_tokens`; if it's zero across repeated requests, something volatile (a timestamp, unsorted JSON) is invalidating the prefix.
2. **Batch API for moderation.** Non-latency-sensitive work runs at **50% cost**. Listing re-scans, nightly sweeps, and bulk re-moderation all go through batches.
3. **Structured outputs, not prose parsing.** Search uses tool-calling so the model emits a filter object your code validates — it never invents listings and never writes SQL.

**Worked estimate.** A moderation pass on a listing is roughly 1,500 input + 200 output tokens. At Haiku 4.5 rates that's about **$0.0025 per listing** — call it a quarter of a cent. Ten thousand listings and a hundred thousand messages a year lands in the **low hundreds of dollars annually**, and halves again on batch. A listing-builder conversation on Opus 5 might run 20k input + 4k output ≈ **$0.20 per listing created**. Those are the two numbers that decide whether "free forever" survives contact with reality — and they comfortably do.

**Guardrails on the AI itself:**
- The model **never** writes SQL or invents listings — it emits a validated filter object.
- AI descriptions require **owner attestation** before publish (`description_attested_at`) — Competition Act s.74.01 exposure is shared, and generation logs are kept.
- The AVM is **not** an LLM. It's a comparables algorithm with published confidence bands (C4).

## 5. Search pipeline

```
user text ──▶ Claude (tool-calling) ──▶ FilterSpec {json}
                                            │  validated by Zod
                                            ▼
                                   search module → SQL
                    ┌───────────────────────┴────────────────┐
                    ▼                                        ▼
        PostGIS: ST_DWithin / ST_Within          FTS: search_vector @@ query
                    └───────────────────┬────────────────────┘
                                        ▼
                            ranked results + filter chips
```

The user sees every filter the AI set, as removable chips — which is exactly what your prototype already does. Keep that: it makes a wrong AI inference recoverable instead of mysterious.

Migrate to Typesense/OpenSearch only when faceted counts across >50k listings get slow. Not before.

## 6. Moderation & trust pipeline (B1/B2)

```
listing submitted ──▶ automated checks (sync, <1s)
                       ├ address normalization + duplicate detection
                       ├ perceptual hash vs existing media (stolen photos)
                       ├ price sanity vs AVM band
                       └ owner verification status
                             ▼
                      risk_signals rows
                             ▼
                   Haiku classification (async, worker)
                             ▼
              ┌──────────────┼──────────────┐
        low risk        medium risk      high risk
        auto-publish    human queue      auto-hold + queue
```

**Message stream (B2):** every message is classified for off-platform payment steering ("e-transfer me the deposit first"), scam patterns, and "already rented" signals. Third one auto-triggers a *"Is this still available?"* prompt to the owner and auto-delists on confirmation. That's NoBroker's ConvoZen trick, and it is the cheapest listing-freshness mechanism in existence.

**Risk signals for the broker-detector:** repeat phone/email across listings, listing volume per account, reverse-image matches against other listings, IP/device clustering, and language patterns typical of agents. Score, don't block — send to the human queue.

## 7. Privacy architecture (non-negotiable)

| Control | Implementation |
|---|---|
| **ID verification** | Vendor does the check; you store `status` + `result_hash` + `verified_at`. **The image never lands in your bucket.** |
| **Document locker** | Private bucket, SSE-KMS, short-lived signed URLs only, `retention_until` on every row, hard-delete job, user-initiated deletion always available |
| **Region** | AWS `ca-central-1` (Montréal). Every bucket, database, and backup |
| **Consent ledger** | `consents` table is the single gate for `notify`. No consent row → no send. CASL penalties reach $10M per violation |
| **Row-level security** | If using Supabase, RLS policies; otherwise enforce ownership in the `documents` and `threads` modules and test it |
| **Audit log** | Every admin action, every document access, append-only |
| **Breach plan** | Written before launch, not after |

## 8. Infrastructure

| Concern | Choice | Note |
|---|---|---|
| Region | **AWS ca-central-1** | Non-negotiable for ID/document data |
| App hosting | Next.js on **AWS App Runner** or **Fargate** | Vercel is faster to ship but check where your data actually sits before storing documents there |
| Database | **RDS Postgres** with PostGIS, pgvector | Start small; automated backups + PITR |
| Objects | **S3** private buckets, lifecycle rules | Separate buckets for media vs documents, different retention |
| Worker | Same image, different entrypoint (`pg-boss`) | One codebase, two processes |
| CDN | CloudFront for listing images | Image resizing at the edge |
| Secrets | AWS Secrets Manager | |
| CI/CD | GitHub Actions → staging → prod | Repo already on GitHub |
| Observability | Sentry + structured logs + a `/health` endpoint | |
| Analytics | PostHog or Plausible | Privacy-first, fewer PIPEDA questions |

**The Supabase alternative:** Supabase gives you Postgres + auth + storage + RLS + realtime in one product and would genuinely save a 1–2 person team weeks. **Verify Canadian region availability before committing** — if the data can't sit in Canada, use it for everything *except* documents and verification, or don't use it at all. That check is a to-do, not an assumption.

## 9. Data acquisition — the real constraint

Restating from doc 06 because it shapes the backend more than any framework choice:

| Data | Availability |
|---|---|
| MLS listings | ❌ **Blocked.** CREA's DDF requires membership and a Data Access Agreement; scraping Realtor.ca breaches its terms |
| Sold prices | ❌ Restricted in Canada |
| Owner-direct listings | ✅ Your own supply — the cold-start problem |
| Property assessments | ✅ SAMA + City of Regina open data (verify licence terms) |
| Transit scores | ✅ **Regina Transit GTFS** — genuinely computable, and a real differentiator |
| Neighbourhood boundaries | ✅ City of Regina open data |
| School data | ⚠️ Provincial/division open data, moderate effort |

**Consequence:** the AVM launches on assessments + your own listing data + owner-reported sale prices, with **wide, honest confidence bands**. Don't fake precision you can't source — publishing the error range (C4) is both more defensible and better marketing than a fake-precise number.

## 10. What "near-zero marginal cost" means concretely

The whole architecture exists to protect one number: **the cost of carrying one more listing for one more month.**

- Storage: fractions of a cent
- Moderation AI: ~$0.0025 per listing, halved on batch
- Database/compute: amortized, essentially flat until you're 100× larger
- **Humans: only exception-queue review, not every listing**

That last line is the one that killed FairSquare, Homie, and Redfin's salaried model. Every architectural choice above — AI triage instead of manual review, one Postgres instead of five services, a monolith instead of a platform team — exists to keep humans out of the per-listing cost.
