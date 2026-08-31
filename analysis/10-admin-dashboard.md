# Admin console — what it actually needs

Written against the backend as it stands, not against a generic idea of an
admin panel. Every claim below was checked against the code.

---

## 1. The finding

Three tables are being written by working code and read by nothing.

| Table | Written by | Read by |
|---|---|---|
| `moderation_queue` | listings (on submit), messaging (on flag/block) | **nothing** |
| `verifications` | OTP email confirmation | **nothing** |
| `audit_log` | — | — |

And four things the plan assumes exist do not:

| Missing | Consequence |
|---|---|
| `feature_flags` table | **Kill switches do not exist at all.** Migration 009 became `ratelimit`, not `flags`. |
| Any writer for `audit_log` | The table has an append-only trigger and no rows. |
| Any producer for `reports` | **A user cannot report anything.** The queue only ever holds what the heuristics caught. |
| Any route using `requireRole` | It is implemented in the guard and called by zero routes. |

### The consequence that matters most

`moderation_queue` has two producers and no reader. Approving a listing is
*possible* — a staff account can `POST /api/listings/:id/transition` — but
there is **no way to find out which listings are waiting.** You would have to
already know the id. The queue is a write-only log.

At the same time, `pending_review → live` is staff-only by design. So in
practice, today, **no listing reaches the public** unless someone hand-carries
an id to a curl command.

That is the one thing the console has to fix before anything else.

### The obligation created by the messaging layer

`modules/messaging` blocks a message before delivery. The recipient never sees
it and is never told it existed — that is deliberate, and it is right for a
real scam. But it means **an honest user whose message trips the heuristic is
silently censored with no recourse.**

Four read paths filter on `delivered_at IS NOT NULL`. Zero paths read the
withheld ones. Until a human can review blocked messages and release a wrong
one, the moderation is a one-way door. **A "review blocked" screen is not a
feature request; it is the other half of a decision already shipped.**

---

## 2. Sizing: how much work is this really?

This decides the whole shape of the console, so it is worth doing honestly.

Regina is ~250,000 people and ~100,000 dwellings. A realistic year one:

| | Estimate |
|---|---|
| Active listings | 200–500 |
| New listings per month | 30–60 |
| Messages per month | 800–2,000 |
| Messages flagged or blocked (at 2–4%) | 20–80 |
| **Queue items per month** | **50–140** |
| **Queue items per day** | **2–5** |

**Two to five decisions a day.** That is fifteen minutes of one person's
morning, not a moderation floor.

Everything follows from that number:

- **No bulk actions.** Selecting forty rows to approve at once is a feature
  for a queue nobody reads carefully. At three a day, each one gets read.
- **No assignment, routing, or SLA tracking.** There is one moderator.
- **No separate mobile admin app.** It is a desktop job done at a desk.
- **Do build a good single-item review screen.** If each decision gets two
  minutes of attention, the screen should put everything needed for those two
  minutes in one place, with no clicking away.

The risk at this volume is not throughput. It is **a queue nobody opens for a
week**, so oldest-item age matters far more than queue depth.

---

## 3. What the console must do

Five jobs, in build order.

### 3.1 Moderate the queue *(unblocks publishing — build first)*

Reads `moderation_queue` ordered by `risk_score DESC, created_at`, which is
exactly what `moderation_queue_open_idx` is built for.

Each row needs: subject type, what triggered it (`reason`), the score, age, and
the `risk_signals` behind the score — a moderator needs to see *why*, not just
a number, and a bad rule is only findable if its name is on the screen.

**Listing review** shows the listing as a buyer would see it, beside the
signals, with three actions: approve · reject with a reason · request changes.
Rejection reason is not optional — it is what the owner gets told, and
`listing_rejected` is already a notification template waiting for a caller.

**Message review** shows the thread in context, both parties, the verdict, the
signals, and — for a blocked message — **release**, which sets `delivered_at`
and lets it through. Without release, see §1.

### 3.2 Ops health *(cheap, and answers "is anything on fire")*

Every number here already exists in a table:

| Metric | Source | Why it matters |
|---|---|---|
| Queue depth **and oldest item age** | `moderation_queue` | Age is the real signal — see §2 |
| Live / pending / draft / expired counts | `listings.status` | Pending climbing means §3.1 is not happening |
| **Listings expiring in 7 days** | `listings.expires_at` | Stale inventory is the loudest complaint about any classifieds site |
| Message block rate, 7-day | `messages.moderation_verdict` | **The key health number** — see below |
| Bounce + complaint rate | `notification_deliveries`, `suppressions` | SES reputation does not recover by apology |
| Gazetteer freshness + row count | `gazetteer_ingests` | A dataset that silently halves is invisible otherwise |
| Pending uploads, rejects | `uploads.status` | A spike means the storage path is broken |
| Signup → email verified → first listing | `users`, `verifications`, `listings` | The cold-start funnel |

**Block rate deserves its own treatment.** If it climbs, either the site is
under attack or the heuristic is over-firing — and those want opposite
responses. The screen should show block rate *beside* release rate: a high
block rate with a high release rate means the rules are wrong, not that the
users are.

### 3.3 Users *(admin only)*

List, search, and inspect an account: role, status, verification state, listing
and message counts, recent risk signals.

One action that matters: **suspend**. `users.status` already has `'suspended'`,
and `resolveSession` already refuses a non-active account on every request — so
suspension takes effect immediately rather than at session expiry. The
enforcement is built; nothing triggers it. This screen is the trigger.

### 3.4 Kill switches *(needs a new table)*

Nothing exists yet. Per the plan, two tiers:

- **Feature flags** — gradual rollout, percentage-based.
- **Kill switches** — instant global off for: AI chat search, AI listing
  builder, AI moderation, OAuth per provider, SMS, email, new signups, new
  listings, document uploads.

The design decision that matters: **fail-safe defaults.** If the flag store is
unreachable, AI features and outbound messaging default **off**; core browsing
defaults **on**. A flag check that fails open on a spend-incurring feature is
how a database blip becomes a bill.

Every flip writes `audit_log`. Effect within 30 seconds, no deploy.

### 3.5 Reports *(needs a producer first)*

`reports` is a well-shaped table with no writer, so no user can flag anything.
The console side is easy; the missing half is a "Report this listing" control
on the public pages. Until that exists, moderation only ever sees what a
regex noticed — never what a person noticed, which is the better signal.

---

## 4. Audit: build it before the first admin write

`audit_log` exists with `forbid_mutation()` on UPDATE and DELETE, so a
compromised application role cannot erase its tracks. It has never been
written.

**This must land before any admin action ships**, not after. An audit trail
added later has no rows for the period before it, which is exactly the period
where a young platform's judgement calls get questioned. Every approve,
reject, release, suspend and flag flip writes: actor, role, action, subject,
before/after, hashed IP.

---

## 5. RBAC: what separates `staff` from `admin`

Both roles exist in `users.role` and neither is used. The split worth drawing:

| | staff | admin |
|---|---|---|
| Moderation queue, approve/reject | ✅ | ✅ |
| Release a blocked message | ✅ | ✅ |
| Action a report | ✅ | ✅ |
| Ops dashboard (read) | ✅ | ✅ |
| Suspend a user | ✕ | ✅ |
| Change a role | ✕ | ✅ |
| Kill switches | ✕ | ✅ |
| Audit log (read) | ✕ | ✅ |

The principle: **daily queue work is `staff`; destructive and system-wide
actions are `admin`.** That is what lets you hire a part-time moderator
without handing them the ability to turn the site off.

Every admin route answers **404, not 403**, to anyone without the role — the
`requireRole` guard already does this. A 403 tells a stranger the route exists
and is worth attacking.

---

## 6. What the console must NOT become

The business model is free-to-list with near-zero marginal cost per listing.
Every Canadian competitor that carried salaried human cost against cyclical
volume died — FairSquare, Properly, Unreserved, Homie. The admin console is
where that cost creeps back in, one reasonable-sounding screen at a time.

Not building, deliberately:

- **Assignment queues, agent workloads, SLA dashboards.** These are the
  furniture of a support organisation.
- **A live chat console.** Support is asynchronous and email-based.
- **Manual listing entry on an owner's behalf.** The moment staff can post for
  someone, staff are doing the owner's work — and someone will ask them to.
- **Photography or viewing scheduling.**
- **Anything that scales with listing count rather than with problems.**

The test for a proposed admin screen: *does the work it creates grow with the
number of listings, or with the number of things that went wrong?* The second
is fine. The first is the trap.

---

## 7. Build order

| # | Ships | Depends on | Why here | State |
|---|---|---|---|---|
| 1 | `audit_log` writer + `requireRole` on routes | — | §4: retrofitting an audit trail loses the period that matters | **shipped** |
| 2 | Moderation queue + listing review | 1 | Unblocks publishing entirely | **shipped** |
| 3 | Message review + **release** | 2 | §1: the other half of a shipped decision | **shipped** |
| 4 | Ops dashboard | 1 | Every number already exists in a table | |
| 5 | Users + suspend | 1 | Enforcement is built; nothing triggers it | |
| 6 | `feature_flags` + kill switches | 1 | New table — design in [11](11-configuration-and-kill-switches.md) | **shipped** |
| 7 | Report control (public) + report queue | 2 | Human signal beats regex signal | |

Steps 1–3 are the ones without which the product does not function. Everything
after is operability.

### What shipped in steps 1–3

`modules/audit/` (the writer, taking the caller's transaction so a decision
and its record are atomic), `modules/admin/moderation.ts` (the queue reader
that three tables were waiting for), staff review and **release** on
`MessagingService`, and eight `/api/admin/*` routes — the first callers of
`requireRole`, which had been implemented and used by nothing.

Writing the RBAC tests found a leak in the gate itself: `requireRole` ran
*after* the auth check, so an anonymous caller got 401 rather than 404 from
an admin route. A 401 announces that a route exists as loudly as a 403 does.
The gate now runs first.

One of the four gaps in §1 remains open: **there is still no producer for
`reports`** (step 7 — a user cannot report anything, so the queue holds only
what the heuristics caught). `feature_flags` now exists and is wired at every
outbound channel and content-creation route; `verifications` has a reader in
the OTP flow.
