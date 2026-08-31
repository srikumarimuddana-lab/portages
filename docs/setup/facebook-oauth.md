# Facebook Login — setup

What you end up with: a `FACEBOOK_CLIENT_ID` and `FACEBOOK_CLIENT_SECRET`, and
"Continue with Facebook" working.

**Time:** ~20 minutes, plus Business Verification if you want it live for the
public. **Cost:** free.

> **Read this first.** Facebook is materially more awkward than Google for a
> product like Portage, and it is worth knowing before you spend the time:
>
> - Facebook **may return no email at all** — the user can decline the email
>   permission, or the account may have only a phone number. The backend
>   handles this (it creates a fresh account rather than guessing), but those
>   users cannot be matched to an existing Portage account.
> - Even when an email comes back, Facebook's `userinfo` response **asserts
>   nothing about verification**. The backend therefore marks it unverified,
>   which means it will never auto-link to an existing account.
> - Going live for non-test users requires **Business Verification** —
>   business documents, and days to weeks of review.
>
> Google covers the large majority of Canadian users. Consider shipping Google
> first and adding Facebook only if signup data shows you need it.

---

## 1. Create the app

1. Go to <https://developers.facebook.com/apps/>
2. **Create App**
3. Use case: **Authenticate and request data from users with Facebook Login**
4. App type: **Business**
5. Name it `Portage`, add a contact email → **Create app**

## 2. Add Facebook Login

1. In the left sidebar: **Add Product** → **Facebook Login** → **Set up**
2. Choose **Web**
3. Site URL: `https://portage.ca` (this initial wizard is cosmetic; the real
   configuration is the next step)

## 3. Configure the redirect URIs

**Facebook Login → Settings**

**Valid OAuth Redirect URIs** — exact matches, no trailing slash:

```
http://localhost:3000/api/auth/oauth/facebook/callback
https://portage.ca/api/auth/oauth/facebook/callback
```

Also set:

| Setting | Value | Why |
|---|---|---|
| Client OAuth Login | **Yes** | |
| Web OAuth Login | **Yes** | |
| Enforce HTTPS | **Yes** | Facebook allows `http://localhost` regardless |
| Use Strict Mode for redirect URIs | **Yes** | Requires exact matching — leave this on |
| Login with the JavaScript SDK | **No** | We use the server-side flow only |

## 4. Get the credentials

**App settings → Basic**

- **App ID** → `FACEBOOK_CLIENT_ID`
- **App Secret** (click Show) → `FACEBOOK_CLIENT_SECRET`

While on this page, fill in **Privacy Policy URL** and **User Data Deletion**
— both are required before the app can go live.

## 5. Permissions

**App Review → Permissions and Features.** You need:

- `email` — usually granted without review
- `public_profile` — granted by default

The backend requests exactly `email public_profile`. Do not add more: every
additional permission drags you into a longer review.

## 6. Put them in your environment

```bash
PUBLIC_ORIGIN=http://localhost:3000
FACEBOOK_CLIENT_ID=1234567890123456
FACEBOOK_CLIENT_SECRET=abcdef0123456789abcdef0123456789
```

On Vercel, add both to the Production environment with
`PUBLIC_ORIGIN=https://portage.ca`.

## 7. Going live

While the app is in **Development** mode only people listed under
**App Roles** can sign in — add yourself as a tester.

Switching the toggle to **Live** requires:

1. Privacy Policy URL and User Data Deletion URL (step 4)
2. **Business Verification** — business documents, reviewed by Meta over
   days to weeks

Start verification early if you want Facebook available at launch; it is not
something you can rush at the end.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `URL Blocked: This redirect failed because the redirect URI is not whitelisted` | The URI isn't in step 3, or Strict Mode is rejecting a near-match. Compare character by character. |
| `App Not Setup: This app is still in development mode` | You aren't listed under App Roles, or the app isn't Live. |
| Sign-in works but the user has no email | Expected — the user declined the permission, or the account has no email. The backend creates a new account rather than guessing at a match. |
| The account won't link to an existing Portage user | Also expected. Facebook does not assert email verification, so the backend requires proof first. Sign in with a password and link from the profile page instead. |
| `Invalid Scopes` | A scope was added that hasn't been approved. Keep it to `email public_profile`. |

## What the backend does with this

- If Facebook returns an `id_token`, it is verified against Facebook's JWKS
  exactly like Google's.
- If it does not, the backend falls back to the `/me` endpoint and marks the
  email **unverified** — because that endpoint makes no verification claim.
  `linking.ts` then refuses to auto-link it to an existing account.
