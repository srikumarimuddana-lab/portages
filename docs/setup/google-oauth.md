# Google Sign-In — setup

What you end up with: a `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your
environment, and "Continue with Google" working.

**Time:** ~15 minutes. **Cost:** free.

---

## 1. Create a Google Cloud project

1. Go to <https://console.cloud.google.com/>
2. Click the project dropdown in the top bar → **New Project**
3. Name it `Portage` → **Create**
4. Make sure the new project is selected in that dropdown before continuing —
   this is the single most common mistake, and everything below silently
   applies to the wrong project if it isn't.

## 2. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen**

| Field | Value |
|---|---|
| User type | **External** (Internal only exists for Google Workspace orgs) |
| App name | Portage |
| User support email | your email |
| App logo | optional — but uploading one triggers Google review, so skip it for now |
| Application home page | `https://portage.ca` |
| Privacy policy link | `https://portage.ca/privacy` |
| Terms of service link | `https://portage.ca/terms` |
| Authorised domains | `portage.ca` |
| Developer contact | your email |

**Scopes:** add exactly these three, no more:

- `openid`
- `.../auth/userinfo.email`
- `.../auth/userinfo.profile`

> Requesting anything beyond these pushes you into Google's verification
> process, which takes weeks. The backend only ever asks for
> `openid email profile` (see `backend/src/modules/auth/oauth/providers.ts`).

**Test users:** while the app is in *Testing* mode only listed accounts can
sign in. Add your own address. Publish the app when you're ready for real
users — with only these three scopes, publishing does not require review.

## 3. Create the OAuth client

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

- **Application type:** Web application
- **Name:** Portage Web

**Authorised JavaScript origins** — the origins your app is served from:

```
http://localhost:3000
https://portage.ca
```

**Authorised redirect URIs** — these must match **character for character**,
including the scheme, any port, and no trailing slash:

```
http://localhost:3000/api/auth/oauth/google/callback
https://portage.ca/api/auth/oauth/google/callback
```

> The path is built by `OAuthService.redirectUriFor()` as
> `{PUBLIC_ORIGIN}/api/auth/oauth/{provider}/callback`. If you change
> `PUBLIC_ORIGIN`, change this list too. A mismatch produces
> `Error 400: redirect_uri_mismatch`, and Google shows you the exact URI it
> received — compare it to this list rather than guessing.

Add a redirect URI for every Vercel preview domain you intend to test on, or
test OAuth only on localhost and production.

Click **Create**. Copy the client ID and client secret.

## 4. Put them in your environment

Local — `backend/.env`:

```bash
PUBLIC_ORIGIN=http://localhost:3000
GOOGLE_CLIENT_ID=1234567890-abc123.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
```

Production — Vercel → Project → Settings → Environment Variables. Set
`PUBLIC_ORIGIN=https://portage.ca` and add both values for the Production
environment.

`loadEnv()` treats these as all-or-nothing: setting only one of the pair is a
startup error rather than a half-working button.

## 5. Verify

```bash
cd backend && npm run dev
```

Open <http://localhost:3000/api/auth/oauth/google>. You should be redirected to
Google, and after consenting, back to `/` with a session cookie set.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `redirect_uri_mismatch` | The URI in step 3 doesn't exactly match `{PUBLIC_ORIGIN}/api/auth/oauth/google/callback`. Google's error page shows the URI it received — diff it against your list. |
| `access_blocked: app not verified` | The app is in Testing and your account isn't a test user. Add it, or publish the app. |
| Redirected back to `/signin?error=signin_failed` | The exchange or token verification failed. Check the server log for the request id. Usually a wrong client secret. |
| `Sign-in with google is not enabled` | Only one of ID/secret is set, or the process didn't pick up `.env`. |
| Works locally, fails on Vercel | `PUBLIC_ORIGIN` still points at localhost in the Production environment. |

## What the backend does with this

Worth knowing, because it affects who can sign in:

- The `id_token` is verified against Google's JWKS, with `iss`, `aud`, `exp`
  and `nonce` all checked (`backend/src/lib/jwt.ts`).
- An existing Portage account is only linked automatically when Google
  asserts `email_verified` **and** that address was already verified on our
  side. Otherwise the user is asked to prove control of one side first
  (`backend/src/modules/auth/oauth/linking.ts`). This is deliberate: it is
  the defence against account takeover through an unverified provider email.
