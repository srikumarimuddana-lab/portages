# Vercel AI Gateway — setup

**None of this could be run in the environment the code was written in.** Every
step below was attempted and blocked by that sandbox's egress policy, not by
anything about this project:

| Command | Result when attempted |
|---|---|
| `npm i -g vercel` | `403 Forbidden — registry.npmjs.org/vercel` |
| `npx plugins add vercel/vercel-plugin` | `403 Forbidden — registry.npmjs.org/plugins` |
| `npm install ai` | `403 Forbidden — registry.npmjs.org/ai` |
| `curl https://ai-gateway.vercel.sh/v1/models` | `CONNECT tunnel failed, response 403` |
| `curl https://vercel.com/plugin` | egress blocked |

So the steps below are written to be run **on your machine**, and the code was
built so that none of it is a prerequisite for the app working. Run them in
order; each one is verifiable before the next.

---

## 0. Before you start

You need: a Vercel account with this project deployed (or at least created),
Node 20+, and npm working. Nothing else.

The Gateway is a routing layer — one credential reaches every model from every
provider, with failover and spend caps managed by Vercel rather than by us.
That is why model IDs in this project are environment variables and not
constants: switching from `anthropic/claude-haiku-4-5` to something else is a
config change, not a deploy of new code.

---

## 1. Install the Vercel CLI

```bash
npm i -g vercel
vercel --version
```

## 2. Install the Vercel plugin for Claude Code (optional)

```bash
npx plugins add vercel/vercel-plugin
```

For other agents:

```bash
npx skills add vercel-labs/agent-skills
```

This is a convenience for the agent, not a dependency of the app. Skip it if
you are setting up by hand.

## 3. Link the project and pull credentials

```bash
cd backend
vercel link          # pick the Portage project
vercel env pull      # writes .env.local
```

`vercel env pull` writes an OIDC token into `.env.local`. **That token is
short-lived** — typically hours. It is fine for local development and it is
refreshed automatically in the deployed environment, but if local AI calls
start returning 401 after working earlier, re-run `vercel env pull`; that is
almost always the cause.

Confirm one of these is now present:

```bash
grep -E 'AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN' .env.local
```

If you would rather use a long-lived key than the OIDC token — useful for CI,
or for a worker that is not a Vercel deployment — create one in the Vercel
dashboard under **AI Gateway → API Keys** and set `AI_GATEWAY_API_KEY`
instead. The code accepts either; an explicit key wins when both are present.

## 4. Install the AI SDK

```bash
npm install ai
```

Only `scripts/verify-gateway.ts` imports it today — see
[Why the app does not depend on the SDK](#why-the-app-does-not-depend-on-the-sdk)
below.

## 5. Verify

```bash
set -a; . .env.local; set +a
node --experimental-strip-types scripts/verify-gateway.ts
```

Expected: tokens stream to stdout, then a line like
`✓ 84 chars in 900ms · in 22 / out 19 tokens`.

The script tells you which of the three failure modes you hit:

| Message | Fix |
|---|---|
| `The 'ai' package is not installed` | `npm install ai` |
| `No Gateway credentials found` | `vercel link && vercel env pull` |
| `Gateway rejected the credentials` | `vercel env pull` — the OIDC token expired |
| `Cannot reach the Gateway` | check egress to `ai-gateway.vercel.sh` |

Then verify the model Portage actually uses, not just the one from Vercel's
onboarding snippet:

```bash
node --experimental-strip-types scripts/verify-gateway.ts \
  --model anthropic/claude-haiku-4-5
```

The default is `openai/gpt-5.6-sol` because that is the model in Vercel's own
docs, so the first run reproduces exactly what their instructions promise.
Portage's own features run on Claude — proving the Gateway works for a model
you will never call is a weaker result than it looks.

---

## 6. Environment variables

Set these in **Vercel → Settings → Environment Variables**, per environment.
None of them are readable from inside the product — see
[analysis/11](../../analysis/11-configuration-and-kill-switches.md) for why
that is deliberate.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `AI_GATEWAY_API_KEY` | one of these two | — | Explicit key. Wins over the OIDC token. |
| `VERCEL_OIDC_TOKEN` | one of these two | — | Provisioned automatically for a linked project. Read per request. |
| `AI_GATEWAY_BASE_URL` | no | `https://ai-gateway.vercel.sh/v1` | Override for a self-hosted gateway or tests. |
| `AI_MODEL_CHAT_SEARCH` | no | `anthropic/claude-haiku-4-5` | High volume, structured extraction. |
| `AI_MODEL_LISTING_BUILDER` | no | `anthropic/claude-opus-5` | Output a person reads; quality matters. |
| `AI_MODEL_MODERATION` | no | `anthropic/claude-haiku-4-5` | High volume, classification. |

**With none of them set, the site works.** Browsing, search, listings and
messaging are unaffected; only the AI paths report themselves unavailable.
That is the same rule the storage and notification blocks follow, and it is
what makes a partial deployment a coherent state rather than a broken one.

### Why those model defaults

From [analysis/06](../../analysis/06-technology-stack.md): *"use a fast, cheap
model (Haiku-class) for high-volume moderation and classification; a stronger
model (Sonnet/Opus-class) for the listing-builder conversation and pricing
rationale."* Chat search is classification — the model turns a sentence into
filters and never writes prose — so it sits on the cheap side. Change any of
them with an env var; no code change, no deploy of new code.

---

## 7. Spend controls

Three independent limits, and you want all three:

1. **Gateway budget** — Vercel dashboard → AI Gateway → set a monthly cap.
   This is the only one that survives a bug in our code.
2. **Kill switches** — `ai.chat_search`, `ai.listing_builder`, `ai.moderation`
   in `feature_flags`. An admin flips one in the console and it takes effect in
   under 30 seconds without a deploy. Every AI flag **fails closed**: if the
   flag store cannot be read, AI stays off. See
   [analysis/11](../../analysis/11-configuration-and-kill-switches.md).
3. **Per-request ceilings** — `maxTokens` and a hard timeout in the adapter, so
   one pathological input cannot become one enormous bill.

Per-feature spend is attributable in the Gateway dashboard because every call
sends `x-title: portage/<task>`.

---

## Why the app does not depend on the SDK

`src/modules/ai/adapters/gateway.ts` speaks the Gateway's HTTP API with
`fetch` and nothing else. This is a considered choice, not a workaround:

- **It works with npm blocked.** The environment this was built in cannot
  install packages at all, and a module that only type-checks is not a module
  that works.
- **The dependency count stays at one** (`pg`). That property is what has kept
  every other integration here — AWS SigV4, SES, JWKS verification, S3
  presigning — auditable in a single readable file.
- **The Gateway is the routing layer either way.** The AI SDK is a client for
  it. Going direct loses the SDK's ergonomics, not the Gateway's features:
  failover, spend caps, provider fan-out and one key for every model are all
  properties of the Gateway, not of the client library.

Everything talks to the `ModelProvider` interface in
`src/modules/ai/provider.ts`, so swapping in an SDK-backed adapter is one line
in the composition root and no change to any feature. If you want that once
npm is available, write `adapters/vercel-ai.ts` against the same interface and
change `app.ts`.

---

## A note on Vercel Passport

Passport is deployment protection: it puts a deployment behind **your own
identity provider** (Okta, Entra, Auth0, any OIDC) and hands the app a signed
identity token. It is an Enterprise feature at $100 per project per month.

**It is the wrong tool for the public site**, and the reason is structural
rather than about cost:

- Portage is a public marketplace. SEO is explicitly the moat against
  Realtor.ca ([analysis/02](../../analysis/02-competitive-landscape.md)), and a
  deployment behind an IdP login is invisible to Google.
- Every Regina renter would need an account in your corporate identity
  provider. There is no version of that which works.

**Where it does fit is `/admin`** — genuinely an internal app, a handful of
staff, and "authenticated against employee identity, every entry auditable,
policy set centrally" is exactly right for it. Worth revisiting if you move to
an Enterprise plan and hire staff who should not have separate Portage
passwords.

Until then the RBAC built in Sprint 7 covers the same ground at $0: `staff` and
`admin` roles, 404 (not 403) to everyone else so the admin surface cannot be
enumerated, and every staff action in an append-only `audit_log`. Passport
would replace the *authentication* half of that; it would not replace the
authorization or the audit trail, which are the parts that took the work.

Sources: [Vercel Passport docs](https://vercel.com/docs/passport) ·
[GA changelog](https://vercel.com/changelog/vercel-passport-generally-available)
