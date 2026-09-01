# Scheduled jobs on Vercel

Three jobs exist today, all configured in
`backend/examples/nextjs/vercel.json`:

| Path | Schedule (UTC) | What it does |
|---|---|---|
| `/api/jobs/alerts` | `7 * * * *` — hourly | Sends saved-search alerts that are due |
| `/api/jobs/expire-listings` | `20 8 * * *` — daily | Retires listings past their 90-day TTL |
| `/api/jobs/purge-documents` | `40 8 * * *` — daily | Destroys documents past their retention date |

All three share one secret and one shape: `GET` for the scheduler, `POST` for a
manual run, and `404` for anything unauthenticated.

Nothing in this repository can deploy or schedule anything, so this file is the
set-up: what to configure, in what order, and how to tell whether it worked.

---

## 0. The Pro plan is a hard requirement, not a preference

**Checked 2026-09-01 against the connected Vercel account: the team
`srikumarimuddana-labs-projects` is on `hobby`, and no Portage project exists
yet.** Both need to change before any of this works.

On the Hobby plan **cron jobs may only run once per day**, and a more frequent
expression does not degrade — it **fails the deployment** with `Hobby accounts
are limited to daily cron jobs`. `/api/jobs/alerts` is scheduled `7 * * * *`,
so the first production deploy on Hobby fails outright, and the two daily jobs
never get created either.

Two consequences beyond the deploy failing:

- **Hourly alerts are the product promise.** The shortest frequency a saved
  search can be set to is `instant`, which the service treats as "at most once
  an hour". Dropping the cron to daily would not be a degraded schedule, it
  would make a setting the user chose into a false statement.
- **Hobby fires within the *hour*, not the minute.** A daily `0 8 * * *` may
  invoke any time between 08:00:00 and 08:59:59. That is fine for expiry and
  purge in isolation, but it dissolves the twenty-minute separation between
  them described below — on Hobby they can overlap, or run in either order.
  On Pro a cron fires within its *minute*, and the separation holds.

Vercel's own docs pages are unreachable from this environment (egress-blocked),
so the frequency limit and its error message come from search extraction of
Vercel's documentation and changelog rather than from the pages themselves —
the same caveat that applies to the Apple licence research. Treat the *shape*
as verified from two independent sources and confirm the exact wording when the
account is upgraded. One detail worth re-checking then: Vercel's changelog of
2026-01-20 says per-team cron limits were removed and the per-project cap
raised to 100 on every plan, which if accurate means the **count** of three
jobs is not itself a problem on any plan. The **frequency** still is.

---

## 1. Set `CRON_SECRET`

In the Vercel project → **Settings → Environment Variables**, add:

| Name | Value | Environments |
|---|---|---|
| `CRON_SECRET` | a random string, 32+ characters | Production (and Preview, if you want the job callable there) |

Generate one with:

```
openssl rand -base64 32
```

**Why it is required.** Vercel automatically attaches
`Authorization: Bearer $CRON_SECRET` to every cron invocation *when this
variable is set*. The endpoint refuses every request when it is not set —
including the scheduler's. That is deliberate: a deployment that forgot this
sends no alerts, rather than sending them for whoever finds the URL. A job that
emails several thousand people is exactly the path somebody probes.

`src/config/env.ts` rejects a value shorter than the minimum secret length at
boot, so a too-short secret fails at deploy time rather than at 3am.

---

## 2. Confirm the schedules

`backend/examples/nextjs/vercel.json`:

**Alerts: hourly, at seven minutes past.** Hourly because the shortest alert frequency
a user can choose is `instant`, which the service treats as "at most once an
hour" — a slower cron would make that setting a lie. Seven minutes past rather
than on the hour because everything in the world is scheduled at `0 * * * *`,
and there is no reason to join the queue.

Daily and weekly alerts are not separate jobs. Each saved search carries its
own frequency and the query only returns the ones actually due, so one hourly
job serves all three.

**Schedules are UTC**, with no per-cron timezone. Since the job only decides
*which* searches are due, the hour it runs in does not matter — but it will
matter for any future job that should fire at a local time, and 07:00 in Regina
is 13:00 UTC in summer and 13:00 UTC in winter (Saskatchewan does not observe
DST, which for once makes this easy).

**Expiry and purge: daily, at 08:20 and 08:40 UTC** — roughly 2:20am and
2:40am in Regina, which does not observe DST, so those times do not drift.
Neither job needs to be prompt to the minute; both need to happen every day.
They are twenty minutes apart rather than together so that a slow purge cannot
delay the expiry, and so the two are separable in a log.

On the Pro plan a cron fires **within** its minute, not at an exact second.
Nothing here depends on that precision — but the twenty-minute separation does
depend on the *minute* being honoured, which is a Pro guarantee. See §0.

### Why expiry and purge are separate jobs

They fail differently. Expiry is one indexed `UPDATE` and either works or does
not. The purge talks to object storage per document, tolerates individual
failures, and reports them. Running them together would mean one bucket
timeout delaying every listing expiry by a day, and one status code covering
two unrelated outcomes.

### `maxDuration` and the batch size are one decision

The job sends at most `ALERTS_PER_RUN` (50, in `src/http/routes/jobs.ts`)
alerts per invocation, and each one is a search plus a send. 50 sits well
inside the 60-second budget rather than at the edge of it.

Anything left over is picked up by the next hourly run — a backlog drains
rather than being dropped. **If you raise one of these, raise the other**, and
check the function's actual duration in Vercel's logs before doing so.

---

## 3. Check the project's Root Directory

`vercel.json` lives at `backend/examples/nextjs/` because that is where the
Next.js app is. Vercel reads it from the project's **Root Directory**, so:

- Root Directory **must** be set to `backend/examples/nextjs`, or
- the file must move to whatever directory is set, with the `functions` glob
  adjusted to stay relative to it.

A `vercel.json` outside the root directory is ignored **silently** — no error,
no cron, no clue. If the job never runs, check this first.

---

## 4. Verify it works

**First, check the schedules actually registered.** A `vercel.json` in the
wrong directory is ignored silently (§3), and this is the cheapest way to find
out — it reads what the *deployment* has, not what the file says:

```
vercel crons ls
```

Three rows, or the file is not being read. `vercel crons run /api/jobs/alerts`
then triggers a deployed job on demand, with the scheduler's own credentials,
which is a truer test than any request you construct by hand.

**Then call it by hand**, which is the only way to check the refusals below.
`GET` is what the scheduler sends; `POST` does the same thing and is the honest
method for a manual run:

```
curl -i -X POST https://<your-domain>/api/jobs/alerts \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expect `200` and a body like `{"considered":3,"sent":1}`:

- `considered` — saved searches that were due
- `sent` — how many produced an email. Lower than `considered` is normal and
  usually correct: a search with no new matches sends nothing, because "0 new
  listings match your search" is a commercial message about nothing.

The other two answer `{"expired":7}` and `{"purged":3,"failed":1}`. A non-zero
`failed` on the purge means object storage refused a delete; those documents
stay unpurged and are retried on the next run, which is the safe direction — a
row is only marked purged after its bytes are actually gone.

**Check the refusals too**, because they are what protects the endpoint:

```
curl -i https://<your-domain>/api/jobs/alerts                      # → 404
curl -i https://<your-domain>/api/jobs/alerts -H "Authorization: Bearer wrong"  # → 404
```

Both answer **404, not 401** — probing the path must not confirm that it
exists.

Then, after the first scheduled run, Vercel → **Project → Cron Jobs** shows the
last invocation and its status code. A `404` there means the secret the
scheduler is sending does not match the one the function reads: the variable
was added to the wrong environment, or after the last deployment (environment
variables apply from the next build).

---

## What the job will not do

- **It will not send anything without live consent.** `NotifyService` re-checks
  before every send. A saved search whose consent was withdrawn stays in
  `considered` and never appears in `sent`.
- **It will not retry a failed send.** Every due search is marked as run
  whether or not its email succeeded. The alternative is a failure staying due
  and mailing the same person on every tick the moment it clears, which is a
  worse outcome than one missed alert.
- **It will not send without an email channel.** With no AWS credentials
  configured the send is refused by the channel, and the saved-searches page
  says so rather than offering a toggle it cannot honour.

---

## Adding another job

1. Add the handler to `src/http/routes/jobs.ts` and register it in
   `src/index.ts` for **both** `GET` (what the scheduler sends) and `POST`.
2. Add a route file under `backend/examples/nextjs/app/api/jobs/<name>/`.
3. Add an entry to `crons` in `vercel.json`, and a `functions` entry if it
   needs more than the default duration.
4. Reuse the same `CRON_SECRET` check. Do not invent a second scheme.

A test asserts that every `/api/jobs/*` GET route appears in `vercel.json`. A
job endpoint nobody schedules is a method that exists, is tested, is reachable
and never runs — which is exactly the state `expireStale` and `collectExpired`
were in, and it looks identical to one that works.

---

## Erasure, and what the purge finishes

Account deletion and this job are two halves of one path, so it is worth
knowing where the boundary is.

Deleting a **user** used to fail outright if they had ever uploaded a document
and opened it: `documents` cascaded from `users`, `document_access_log`
cascades from `documents`, and that log is append-only — so the cascade was
refused and the whole delete aborted. Migration `019_erasure.sql` resolves it.
The trail survives, in pseudonymised form, and the account goes:

- **The document becomes a tombstone.** `owner_id` is set to NULL rather than
  the row being deleted, so the access log still has something to point at.
- **The identity is redacted everywhere it was recorded.**
  `document_access_log.actor_id` by the foreign key, `audit_log.actor_id` and
  `ai_calls.actor_id` by a trigger on `users` — those two carry no foreign key
  by design, so nothing was erasing them before.
- **This job finishes it.** A tombstone is due immediately (`owner_id IS NULL`
  is one of the three purge categories), so the next nightly run destroys the
  bytes and blanks the title. Until it does, the document still exists — with
  no way to read it, because `canAccess` refuses a NULL owner.

An append-only table can now name columns that are **redactable to NULL**, and
that is the only mutation it will ever accept: `forbid_mutation('actor_id')`.
Setting such a column to a *different* value is still refused, as is any other
column, as is DELETE. Erasure removes an identity; it must not be able to
substitute one, or the log could be made to accuse somebody else.

`test/sql/uploads.sql` §10 asserts the general rule against the catalogue: an
append-only table may only carry `RESTRICT`/`NO ACTION`, or `SET NULL` on a
column its trigger names. A future table with a plain `CASCADE` fails the gate
when it is added, rather than the first time somebody tries to delete an
account.

What survives an erasure is "some document was opened at 14:02", plus — in
`audit_log` — the `actor_role` that did it. A staff decision remains
attributable to *staff* after that employee's own account is erased.
