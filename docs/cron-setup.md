# Scheduled jobs on Vercel

One job exists today: **saved-search alerts**. It is configured in
`backend/examples/nextjs/vercel.json` and runs hourly.

Nothing in this repository can deploy or schedule anything, so this file is the
set-up: what to configure, in what order, and how to tell whether it worked.

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

## 2. Confirm the schedule

`backend/examples/nextjs/vercel.json`:

```json
{
  "crons": [{ "path": "/api/jobs/alerts", "schedule": "7 * * * *" }],
  "functions": { "app/api/jobs/alerts/route.ts": { "maxDuration": 60 } }
}
```

**Hourly, at seven minutes past.** Hourly because the shortest alert frequency
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

On the Pro plan a cron fires **within** its minute, not at an exact second.
Nothing here depends on precision.

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

**Before relying on the schedule**, call it by hand. `GET` is what the
scheduler sends; `POST` does the same thing and is the honest method for a
manual run:

```
curl -i -X POST https://<your-domain>/api/jobs/alerts \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expect `200` and a body like `{"considered":3,"sent":1}`:

- `considered` — saved searches that were due
- `sent` — how many produced an email. Lower than `considered` is normal and
  usually correct: a search with no new matches sends nothing, because "0 new
  listings match your search" is a commercial message about nothing.

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

Two obvious candidates already exist as unwired service methods:
`ListingService.expireStale()` (the 90-day listing TTL) and
`DocumentService.collectExpired()` (PIPEDA retention deletion). Both are
written and tested; neither has anything calling it.
