# Vercel — setup

What you end up with: the app deployed, environment variables set, and cron
jobs running the scheduled work.

**Time:** ~15 minutes. **Cost:** Pro, $20/seat (you have this).

> Hobby is **contractually barred from commercial use**, so Pro is not
> optional for Portage.

---

## 1. Import the project

<https://vercel.com/new> → import `srikumarimuddana-lab/portages`.

| Setting | Value |
|---|---|
| Framework | Next.js |
| Root directory | wherever the Next.js app lives |
| Node version | 22.x |

## 2. Function region

**Settings → Functions → Function Region → Montreal (`cdg1`/`yul1` — pick the
Canadian option).**

Put compute next to the database. Cross-continent round trips to
`ca-central-1` show up directly in your p95 latency budget.

## 3. Environment variables

**Settings → Environment Variables.** Add each for the environments it applies
to. See `backend/.env.example` for the full annotated list.

| Variable | Production value |
|---|---|
| `DATABASE_URL` | Supabase **transaction pooler** (port 6543) |
| `SESSION_SECRET` | `openssl rand -base64 48` |
| `STORAGE_SIGNING_SECRET` | a different `openssl rand -base64 48` |
| `PSEUDONYM_PEPPER` | a third one |
| `ALLOWED_ORIGINS` | `https://portage.ca` |
| `PUBLIC_ORIGIN` | `https://portage.ca` |
| `TRUST_PROXY` | `true` |
| `NODE_ENV` | `production` |

**`TRUST_PROXY=true` matters on Vercel.** Without it the backend refuses to
read `X-Forwarded-For` — correct when directly exposed, since a client could
otherwise spoof the header and pick its own rate-limit bucket, but on Vercel
it means every request looks like the same client.

Never reuse one random value across two variables.

## 4. Cron jobs

Scheduled work has no HTTP request to run inside. Vercel Pro gives you 100
cron jobs at per-minute cadence with a 300-second function timeout — ample,
because the jobs finish in seconds at single-city scale.

`vercel.json`:

```json
{
  "crons": [
    { "path": "/api/jobs/moderation", "schedule": "* * * * *" },
    { "path": "/api/jobs/alerts",     "schedule": "0 14 * * *" },
    { "path": "/api/jobs/retention",  "schedule": "30 8 * * *" },
    { "path": "/api/jobs/sweep",      "schedule": "0 * * * *" }
  ]
}
```

> **Cron schedules are UTC only.** Regina is UTC−6 (CST, no daylight saving),
> so 8am local is `14` UTC — that is what the alerts entry above says.

Protect the endpoints: Vercel sends a `CRON_SECRET` header if you set that
variable. Reject requests without it, or anyone can trigger your jobs.

Jobs must process a **bounded batch per invocation** — that is what keeps you
inside the 300-second timeout as volume grows, and it is why no separate
always-on worker is needed at this scale.

## 5. Runtime

Every API route must declare:

```ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
```

The security core uses `node:crypto` scrypt, which the **Edge runtime does not
provide**. `force-dynamic` stops Next.js from statically rendering a route
that sets cookies.

## 6. Preview deployments

Every PR gets a URL. Two things to decide:

- **Database:** point previews at a **staging** Supabase project, never
  production. A preview deploy running migrations against production is a bad
  afternoon.
- **OAuth:** preview domains are unpredictable, so their redirect URIs are not
  registered. Either register a stable preview domain or test OAuth on
  localhost and production only.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `scrypt is not a function` | The route is on the Edge runtime. Add `export const runtime = 'nodejs'`. |
| `too many connections` | Using the direct Supabase connection. Switch to the transaction pooler. |
| Rate limiting seems not to apply | `TRUST_PROXY` is unset, so every request shares one bucket. |
| Cron never fires | Missing `vercel.json`, or the schedule is in local time instead of UTC. |
| Cookies not set in the browser | `PUBLIC_ORIGIN`/`ALLOWED_ORIGINS` disagree with the domain actually served. |
