# 06 — Technology Stack Recommendation

> Sized for a small team (1–3 developers) shipping the MVP in doc 04 within ~4–6 months, on a near-zero marginal cost per listing — which the competitive research says is the **only** way a zero-fee marketplace survives (FairSquare died carrying human costs against cyclical volume).

## Design principles

1. **Near-zero marginal cost per listing.** No salaried agents, no manual ops that scale linearly with listings. AI does moderation triage; humans review exceptions only.
2. **Canadian data residency by default.** PIPEDA governs, ID documents and lease/invoice files are the crown-jewel risk, and a breach is existential for a trust-based brand.
3. **One codebase, one brand.** Trulia's decay under Zillow is the warning against splitting products.
4. **Boring, well-trodden choices.** The novelty budget belongs in the product, not the infrastructure.
5. **No payment rails.** Your scope cut keeps you out of FINTRAC MSB and RPAA registration — the stack should not casually reintroduce them.

## Recommended stack

| Layer | Recommendation | Why |
|---|---|---|
| **Frontend** | **Next.js (React) + TypeScript**, App Router | SSR/ISR gives the SEO you need to compete for "Regina 2 bedroom rent" long-tail queries where Realtor.ca is weak. Your prototype is already HTML/CSS/JS — the visual design ports directly |
| **Styling** | **Tailwind CSS** + a small component library (shadcn/ui) | Your Airbnb-inspired rounded theme maps cleanly to Tailwind tokens |
| **Mobile** | **PWA first**, native later | Renters browse on phones; a PWA avoids app-store overhead pre-traction. Revisit native at ~10k MAU |
| **Backend** | **Node/TypeScript (NestJS or Fastify)** — or Django if the team is Python-first | One language across the stack for a small team |
| **Database** | **PostgreSQL + PostGIS** | PostGIS handles map/radius/polygon search natively — essential for F7-style map browse. Also gives you JSONB for flexible listing attributes |
| **Search** | **Postgres full-text + PostGIS at launch**; Typesense or OpenSearch when facets outgrow it | Don't buy Elasticsearch on day one for a few thousand Regina listings |
| **Hosting** | **AWS ca-central-1 (Montréal)** or **Azure Canada Central** | **Canadian region is non-negotiable** for ID documents and the document locker |
| **Managed platform option** | **Supabase** (Postgres + auth + storage + row-level security) — *verify Canadian region availability before committing* | Fastest path for a 1–3 person team; RLS is a genuinely good fit for "owners see only their own listings and documents" |
| **File/object storage** | S3 (ca-central-1) with **server-side encryption, private buckets, short-lived signed URLs** | Listing photos, and the D1 document locker |
| **Auth** | Auth.js / Supabase Auth / Cognito — email + phone OTP, **passkeys** where possible | Phone verification is also a B1 signal (repeat-number detection) |
| **ID verification** | Third-party KYC vendor with Canadian residency (e.g. Persona, Trulioo, Certn) — **verify-then-delete** | The OPC advises copying government ID "should not be standard practice"; store a pass/fail + audit hash, not the image |
| **AI / LLM** | **Claude API** for chat search, listing builder, description drafting and moderation triage | See the AI architecture note below |
| **Vector/RAG** | **pgvector** in the same Postgres | Avoids a separate vector DB for listing/neighbourhood Q&A (C5) |
| **Maps** | **MapLibre GL + OpenStreetMap / MapTiler**, or Mapbox | Cheaper than Google Maps at scale; open-data-friendly, which suits your neighbourhood-scores story |
| **Email/SMS** | Postmark or SES + Twilio | ⚠️ Build **CASL consent logging into the notification service itself** — express opt-in, sender ID, working unsubscribe on every message |
| **Analytics** | **Plausible or PostHog (EU/self-hosted)** over Google Analytics | Privacy-first is consistent with the brand and reduces PIPEDA surface |
| **Error/APM** | Sentry | Already connected in this workspace |
| **CI/CD** | GitHub Actions → staging → production | Repo is already on GitHub |
| **Payments (services bookings only, later)** | **Stripe Connect** — and route funds **directly** between homeowner and pro | Never hold or route rent/deposits yourself (H2). Even for services, structure so the licensed PSP carries the obligations |

## AI architecture (the part that decides your cost structure)

Four jobs, three of which are cheap and one of which is your moat:

| Job | Doc 04 ref | Approach | Notes |
|---|---|---|---|
| **NL search → filters** | A5 | Structured tool/function calling: the model emits a filter JSON, your code runs the query | Never let the model invent listings. Show the filters it set as removable chips (your design already does this — keep it) |
| **Listing builder by chat** | A6 | Guided extraction into a typed schema; the draft is data, not prose | Publish only when required fields are complete — your design already gates this correctly |
| **Description drafting** | A9 | Generate → **owner must review and attest** before publish | Competition Act s.74.01: you share authorship of any embellishment. Keep generation logs |
| **Moderation & fraud triage** | B1, B2 | Cheap model classifies every listing and message; escalate only exceptions to the human admin queue | **This is the moat.** NoBroker's ConvoZen audits 100% of conversations vs ~2% human sampling and auto-delists rented properties. It's how you keep marginal cost near zero while being the *trusted* platform |

**Model choice:** use a fast, cheap model (Haiku-class) for high-volume moderation and classification; a stronger model (Sonnet/Opus-class) for the listing-builder conversation and pricing rationale. Cache aggressively — most listing-page Q&A is repetitive.

**AVM (A8):** do **not** start with an ML model. Start with a comparables algorithm over Regina sales + SAMA assessment data, publish confidence bands (C4), and label it "estimate, not an appraisal." Zillow publishes a 7.06% median error on off-market homes — transparency beats false precision, and it defuses the "you'll underprice your home" attack agents will make.

## Data acquisition — the real engineering risk

This is harder than the app itself, and it decides whether the marketplace has anything to show on day one.

| Data | Source | Difficulty |
|---|---|---|
| MLS listings | **Not available to you.** CREA's DDF requires membership/Data Access Agreement; scraping Realtor.ca breaches terms | ❌ Blocked — plan around it |
| Owner-direct listings | Your own supply (the whole point) | The cold-start problem |
| Rental listings | Own supply + landlord/PM onboarding | The Phase-0 focus |
| Sold prices / history | Restricted in Canada | Hard — start with what owners self-report + assessment data |
| Property assessments | **SAMA** (Saskatchewan Assessment Management Agency) + City of Regina open data | Feasible — verify licence terms |
| Transit scores | Regina Transit GTFS feed | Easy, and genuinely computable |
| School data | Provincial/division open data | Moderate |
| Neighbourhood boundaries | City of Regina open data | Easy |

**Practical implication:** your "built from open Canadian data" neighbourhood-scores claim is achievable and defensible — it's the *sold-price* depth that's constrained. Be careful not to over-promise price history in the UI.

## Build order

1. **Foundation** — Next.js + Postgres/PostGIS + auth + listing CRUD + photo upload + map search
2. **Trust layer** — ID verification (verify-then-delete), admin moderation queue, B1/B2 AI triage, report flow
3. **Rentals MVP** — rent mode, room-type filter, alerts (with CASL consent logging), owner chat, viewing bookings
4. **AI layer** — chat search, listing builder, description drafting
5. **Document locker (D1)** — encrypted, user-controlled, retention policy, deletion
6. **Sell side** — listing wizard, AVM v1, mortgage calculator, lawyer directory
7. **Services + directories** — E1/E4, F2/F3

## Cost sanity check (order of magnitude, monthly, pre-traction)

Hosting + database + storage in the low hundreds of dollars; LLM inference the main variable (moderation on a cheap model over thousands of listings/messages is tens of dollars, not thousands); ID verification is per-check (~$1–3) and is your largest per-user cost — meter it (verify owners at listing time, not every browser).

**The point of this stack:** at Regina scale, running Portage should cost less per month than one agent's commission on one house. That asymmetry is the entire business case, and every architecture decision should protect it.
