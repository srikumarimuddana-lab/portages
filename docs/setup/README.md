# Setup guides

Step-by-step instructions for every external service Portage depends on —
the things that cannot be configured from inside the codebase.

## Order to do them in

| # | Guide | Needed for | Time | Cost |
|---|---|---|---|---|
| 1 | [Supabase](supabase.md) | Database and file storage | 10 min | $0 → $25/mo |
| 2 | [Vercel](vercel.md) | Hosting, cron jobs, environment variables | 15 min | Pro (already held) |
| 3 | [Google Sign-In](google-oauth.md) | "Continue with Google" | 15 min | Free |
| 4 | [Apple MapKit JS](apple-mapkit.md) | The map | 20 min | $99/yr (already held) |
| 5 | [AWS SES + SMS](aws-messaging.md) | Email and SMS | 30 min + waits | Pay per message |
| 6 | [Facebook Login](facebook-oauth.md) | "Continue with Facebook" | 20 min + review | Free |

**Start numbers 5 and 6 early.** AWS SES production access and Canadian SMS
registration, and Facebook's Business Verification, all involve review queues
measured in days to weeks. Everything else you can do in an afternoon.

## Things that block a launch, not a build

These do not stop development, but they do gate going live. Start them in
parallel:

- **Saskatchewan legal opinion** on whether Portage's feature set stays
  outside "trading in real estate" under The Real Estate Act. The agenda for
  that one meeting is in `analysis/05-regina-gtm-business-model-regulatory.md`.
- **Two written questions to Apple Developer Support** about storing
  coordinates sourced outside Apple — see [apple-mapkit.md](apple-mapkit.md).
- **AWS SES production access** (you start in a sandbox that only sends to
  addresses you have verified).

## The environment variables, in one place

Every variable is documented inline in `backend/.env.example`. Summary:

| Variable | Guide | Required |
|---|---|---|
| `DATABASE_URL` | Supabase | Yes |
| `SESSION_SECRET`, `STORAGE_SIGNING_SECRET`, `PSEUDONYM_PEPPER` | — | Yes |
| `ALLOWED_ORIGINS`, `PUBLIC_ORIGIN` | Vercel | Yes |
| `GOOGLE_CLIENT_ID` / `_SECRET` | Google | Optional |
| `FACEBOOK_CLIENT_ID` / `_SECRET` | Facebook | Optional |
| `MAPKIT_TEAM_ID` / `_KEY_ID` / `_PRIVATE_KEY` | Apple | Optional |

Generate each secret separately — never reuse one value across two variables:

```bash
openssl rand -base64 48
```

Optional groups are **all-or-nothing**: setting one half of a pair is a
startup error rather than a half-working feature. That is deliberate — a
sign-in button that 500s is worse than one that isn't shown.

## Where secrets live

| Environment | Where |
|---|---|
| Local | `backend/.env` (gitignored — never commit it) |
| Preview / Production | Vercel → Settings → Environment Variables |
| AWS keys | AWS Secrets Manager, or Vercel env vars scoped to Production |

CI has a check that fails the build if private key material appears in the
diff (`.github/workflows/ci.yml`). It is narrow by design — it looks for real
PEM blocks and provider key formats, not the word "secret".
