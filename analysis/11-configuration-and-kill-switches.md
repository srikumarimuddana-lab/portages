# Configuration, kill switches, and why there is no superadmin

**The question:** where does the technology configuration live, and who gets
the switch that turns things off — is it all environment variables?

**The short answer:** two layers, and the line between them is not arbitrary.

- **Configuration is environment variables.** Deploy-time only. Never
  readable, never writable from any page in the product. This is what decides
  *whether a capability can exist at all.*
- **Kill switches are database rows.** Runtime, flippable in seconds by an
  admin with no deploy. This is what decides *whether an existing capability
  is on right now.*

And one rule joins them:

> **A kill switch can only subtract.** It can turn a capability off. It can
> never turn one on that configuration has not already enabled.

Everything below follows from that rule.

---

## 1. Why not put configuration in the admin UI

It is tempting. A settings page where an admin pastes an API key and picks a
region feels like the professional thing to build. It is a mistake here, for
four reasons that are specific to this product rather than general principle.

**A settings page is an exfiltration path.** Configuration holds
`AWS_SECRET_ACCESS_KEY`, `MAPKIT_PRIVATE_KEY`, OAuth client secrets, the
storage credentials, `PSEUDONYM_PEPPER`. If those are readable through a session, then
one phished admin cookie is one `GET /admin/settings` away from all of it.
Today they are readable only by the process, from an environment the process
cannot enumerate back to a client. That property is worth more than the
convenience.

**A settings page is a redirect path.** Writable configuration means an
attacker with an admin session can point `PUBLIC_ORIGIN` at their own domain
and harvest OAuth callbacks, or swap `STORAGE_ENDPOINT` and receive every
uploaded document. Neither is recoverable by noticing quickly. A kill switch
misused causes an outage; writable config misused causes a breach.

**Configuration changes deserve review.** Changing the SES region or the
storage bucket is a change to how the system is built. It belongs in a diff,
with a reviewer, and with a rollback that is `vercel rollback` rather than
"what was that value before?" Vercel already versions environment variables
per environment; that is a better audit trail than one we would write.

**The all-or-nothing validation already depends on it.** `config/env.ts`
treats each integration as a group: AWS credentials without
`SES_FROM_ADDRESS` do not produce a half-configured email channel, they
produce no email channel, and `NotifyService` reports
`channel_not_configured` rather than throwing at send time. That check runs
once at boot. A settings page would have to re-run it on every write and
handle a process that was mid-request when the shape changed. The cost is
real and buys nothing we need.

## 2. Why kill switches cannot be environment variables

The mirror argument. Turning something off through configuration means a
deploy, and a deploy is two to five minutes on a good day and unavailable on
a bad one — the moment you most need the switch is the moment the build is
also failing, or the CI provider is degraded, or it is 2am and nobody wants
to push to production half-awake.

The three scenarios this is for:

| At 2am | What you need | Deploy is |
|---|---|---|
| An AI loop is burning the model budget | AI features off, now | too slow, and the fix is not a code change |
| A template bug is emailing 4,000 people | Email channel off, now | too slow; every minute is more sent |
| A scripted signup flood | New signups off, now | too slow, and you want it back on in an hour |

None of these needs a code change. All of them need one boolean to move in
under thirty seconds. That is a database row.

## 3. The one-way rule

The rule that makes the runtime layer safe to expose:

```
capability is live  ⟺  configured in env  AND  switch not thrown
```

A switch is an AND, never an OR. Consequences worth stating plainly:

- An admin **cannot enable** the SMS channel. If `SMS_ORIGINATION_IDENTITY`
  is not in the environment, no amount of clicking makes SMS send.
- An admin **cannot add** an OAuth provider, change a redirect URI, or point
  the app at a different bucket.
- An admin **can** turn off email, SMS, AI features, new signups, new
  listings, uploads, or a specific OAuth provider.

So the worst thing a stolen admin session can do through this layer is cause
an outage. Outages are recoverable in minutes by the same lever. That is a
deliberately asymmetric blast radius: cheap to misuse, cheap to undo.

## 4. There is no in-app superadmin, and that is the design

The instinct is to add a third role above `admin` that can do everything.
Concretely, what would it do that `admin` cannot?

| Power a "superadmin" would want | Where it actually lives |
|---|---|
| Rotate an API key | Vercel environment variables / AWS IAM |
| Change the database connection | Vercel environment variables |
| Restore from backup | Supabase console |
| Grant someone else admin | `users.role`, which admin already writes |
| Read secrets | Nowhere in the app, by design (§1) |
| Take the whole site down | Vercel deployment controls |

Every genuine superadmin power already exists, in a console that has its own
MFA, its own IAM, its own audit log, and no relationship to a Portage session
cookie. Building an in-app superadmin would mean **building a second, weaker
door into the same room** — one guarded by our session code rather than by
AWS's, reachable from the public internet, and phishable from a laptop.

The role ladder therefore stops at two staff roles, and the database enforces
that it is a closed set (`test/sql/admin.sql` §7 asserts there is no fourth
role to escalate into):

| Role | Can | Cannot |
|---|---|---|
| `staff` | work the moderation queue, approve/reject listings, release/uphold messages | read the audit log, flip switches, change roles |
| `admin` | all of the above, plus read the audit log, flip kill switches, suspend users, change roles | read or write configuration — there is no route |
| *no one, in-app* | — | rotate keys, change providers, touch infrastructure |

The staff/admin split exists so a part-time moderator can be hired without
handing them the ability to turn the site off. The admin ceiling exists so a
compromised admin account is an incident, not a catastrophe.

## 5. What lives where, concretely

Read against `backend/src/config/env.ts` as it stands today.

### Environment (deploy-time, never in the product)

| Group | Variables | Absent means |
|---|---|---|
| Core | `DATABASE_URL`, `SESSION_SECRET`, `STORAGE_SIGNING_SECRET`, `PSEUDONYM_PEPPER` | boot fails, deliberately |
| Site | `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`, `FORCE_SECURE_COOKIES`, `TRUST_PROXY`, `PORT`, `NODE_ENV` | boot fails or safe default |
| Maps | `MAPKIT_TEAM_ID`, `MAPKIT_KEY_ID`, `MAPKIT_PRIVATE_KEY` | map disabled |
| OAuth | `GOOGLE_CLIENT_ID` / `_SECRET`, `FACEBOOK_CLIENT_ID` / `_SECRET` | that provider disabled |
| AWS | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` | no outbound messaging |
| Email | `SES_FROM_ADDRESS`, `SES_CONFIGURATION_SET` | email channel off |
| SMS | `SMS_ORIGINATION_IDENTITY` | SMS channel off |
| Storage | `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_PUBLIC_BASE_URL` | uploads disabled, browsing unaffected |

Note two names that read like each other and are not: `STORAGE_SIGNING_SECRET`
is ours, the HMAC key that signs upload tickets and document share links;
`STORAGE_SECRET_ACCESS_KEY` is the object store's. Losing the first
invalidates every outstanding ticket; leaking the second hands over the
bucket.

Note the pattern already in the code: **absent is a coherent state, not a
broken one.** Without storage the site still browses and searches, and
anything that would store bytes reports itself unavailable. That is what
makes the switch layer simple — the "off" path for every capability already
exists and is already exercised.

### Database (runtime, admin-flippable)

```sql
CREATE TABLE feature_flags (
  key         text PRIMARY KEY,
  enabled     boolean NOT NULL DEFAULT true,
  rollout_pct smallint NOT NULL DEFAULT 100 CHECK (rollout_pct BETWEEN 0 AND 100),
  note        text,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

Two tiers with different defaults, which is the part that is easy to get
wrong:

| Tier | Examples | Default when the store is unreachable |
|---|---|---|
| **Kill switch** — instant global off | `channel.email`, `channel.sms`, `ai.chat_search`, `ai.listing_builder`, `ai.moderation`, `signups.new`, `listings.new`, `uploads.new`, `oauth.google`, `oauth.facebook` | **off** for anything that spends money or sends mail; **on** for browsing, search, and login |
| **Feature flag** — gradual rollout | new surfaces behind `rollout_pct` | off |

The asymmetry is the point. If the flag store is unreachable we do not know
whether someone just pulled the lever, and the two failure modes are not
equally bad: an hour of no email is an inconvenience, an hour of a runaway
send is a suppression list and a burnt sender reputation that does not come
back. Browsing defaults on for the opposite reason — a database blip must not
take the public site down, and browsing cannot run up a bill.

## 6. What is already in place

Not vapourware — the seams exist and are used:

- **`NotifyService` already checks a kill switch first**, before any database
  work, on every send. The `KillSwitch` interface is defined in
  `modules/notify/service.ts` and currently defaults to `ALLOW_ALL`. Wiring
  the flags module means replacing that default; no call sites change.
- A blocked send is **recorded**, with `status = 'blocked'` and reason
  `channel_disabled`. So "why did nothing go out last night" is answerable
  after the fact, which matters because a thrown switch is invisible to the
  user it silenced.
- **`audit_log` and its writer now exist** (this sprint), and `flag.set` is
  already in `AUDIT_ACTIONS`. Every flip will be recorded with the actor,
  the before and after value, and a hashed IP, in the same transaction as
  the flip.
- **`requireRole` is live** on the admin routes, answering 404 rather than
  403, so the flag routes inherit a gate that is already tested.

## 7. Built (plan step 6)

All of it, except the AI call sites — there are no AI features yet, so the
switches for them are declared and checked and have nothing to guard. That is
deliberate: a switch introduced alongside the feature it guards is a switch
nobody has ever exercised, and these are read by `FlagService` from day one.

| Piece | Where |
|---|---|
| Table | `migrations/015_flags.sql` + `.down.sql` |
| Registry | `modules/flags/registry.ts` — the closed key union and the fail-safe per key |
| Service | `modules/flags/service.ts` — cache, rollout buckets, audited writes |
| Channel wiring | `NotifyService`'s `ALLOW_ALL` replaced in `http/app.ts` |
| Route gating | `requireFlag` in `http/guard.ts`; declared on signup, listing create, both upload-ticket routes, and both OAuth routes |
| Console | `GET /api/admin/flags` (staff) · `POST /api/admin/flags/:key` (**admin only**) |
| Contract | `test/sql/flags.sql` |

### Three states, not two

The obvious cache is fresh-or-unavailable, falling back to the fail-safe on
any read failure. That is wrong in the expensive direction: a two-second
database blip would turn email off site-wide — the safety mechanism causing
the outage it exists to prevent. So:

| State | Age of snapshot | Behaviour |
|---|---|---|
| FRESH | < 10s | use it |
| STALE | 10–60s | use it anyway |
| BLIND | > 60s, or none | fail-safe |

The middle state is the point. A five-second-old snapshot is knowledge, not
ignorance, and the fail-safe is for ignorance. Nor can serving stale mask a
decision somebody just made: writing a flag needs the same database that is
unreachable.

### Where the registry default is not the fail-safe

Two different questions that look like one, and conflating them takes email
down on a fresh install:

- **No row has ever been written** → the registry *default*. A kill switch
  has not been thrown, so it is **on**.
- **The table cannot be read** → the registry *fail-safe*. For
  `channel.email` that is **off**.

### Two design rules enforced by the type system, not by comments

- **`requireRole` and `requireFlag` are mutually exclusive.** A role-gated
  route must answer 404 so a stranger cannot tell it exists; a switched-off
  route answers 503, which says it does. No ordering satisfies both, so the
  combination is a compile error. No admin route is ever flag-gated — the
  console is how a thrown switch gets released, and a switch that can disable
  its own off-switch has no exit but a deploy.
- **A kill switch has no partial rollout.** "Email is 40% off" is not an
  incident response. `set()` refuses it, and the tier field is what will make
  it legal for the first genuine rollout flag.

### What the switches do and do not interrupt

`uploads.new` stops ticket issuance but not `completeUpload`: bytes already in
flight land rather than becoming orphaned objects with no row. `oauth.*` gates
the callback as well as the start, and the difference is deliberate — an
upload completing after the switch is harmless, while a callback completing
after it mints a session using the very credential the switch was thrown over.

**Gate: met.** A flip lands within one 10s TTL, two full cycles inside the 30s
budget. `test/flags.test.ts` drives a real `FlagService` off a real
`feature_flags` row into a real `NotifyService` and proves the provider is
never reached, then releases the switch and proves the same send goes through.

### One thing the unit tests could not have caught

The first version of `set()` passed NULL for whichever field a patch omitted,
relying on `ON CONFLICT` to fill it in. `enabled` and `rollout_pct` are
NOT NULL, so on a flag with no existing row there is no conflict to rescue the
insert — **the very first flip of any switch would have failed**, which is
both the common case and the worst possible moment. The fake `Sql` does not
enforce NOT NULL and reported success; `test/sql/flags.sql` caught it against
real PostgreSQL. The INSERT branch now supplies the registry default and only
the UPDATE branch coalesces against the existing row.

### Still open

`ai.*` has no call sites until AI features exist. `feature_flags` has no
seed — the registry is the source of truth for which flags exist, so an
untouched flag shows its default rather than being invisible, and adding one
needs no migration.

## 8. Break-glass order, for the runbook

When something is actively going wrong, in order of what to reach for:

1. **Kill switch** (seconds, admin, in-product) — stops the bleeding.
2. **Vercel environment variable + redeploy** (minutes, whoever holds the
   Vercel account) — changes how the system is built.
3. **AWS IAM / Supabase console** (minutes, account owner) — revoke a key,
   restore data, cut off a provider at the source.
4. **Vercel deployment rollback or pause** (seconds, account owner) — the
   site off, entirely.

Steps 2–4 are not in the product and are not reachable from a session cookie.
That is the answer to "who has the superadmin access": nobody, in the app —
because the people who need those powers already have them somewhere better
guarded, and giving the app a copy would only lower the bar to reaching them.
