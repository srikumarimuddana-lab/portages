# Apple MapKit JS — setup

What you end up with: `MAPKIT_TEAM_ID`, `MAPKIT_KEY_ID` and
`MAPKIT_PRIVATE_KEY`, and a working map.

**Time:** ~20 minutes. **Cost:** $99 USD/yr Apple Developer Program (you have this).

---

## Why Apple, and the one constraint that shapes the architecture

Cost is the reason: at 200,000 map loads/month you are using roughly 2.7% of
Apple's daily allowance, so the map costs nothing beyond the membership you
already pay. The alternatives are $250–1,650/mo (Mapbox, plus a mandatory
negotiated real-estate licence) or $630–3,430/mo (Google, whose terms also bar
use "in a listings or directory service").

**The constraint:** Apple's Developer Program Licence Agreement defines "Map
Data" to include latitude and longitude, forbids storing it beyond "temporary
and limited", and bars using it "as part of any secondary or derived
database". Portage's `properties.lat/lng` column is permanent — exactly that.

So the split is: **Apple renders the map; Apple never produces a coordinate we
store.** Coordinates come from City of Regina open data instead, which is free,
authoritative for our launch city, and carries no such restriction.

> ⚠️ This reading of the licence came from search extraction, not from reading
> `developer.apple.com` directly. **Send the two questions at the bottom of
> this page to Apple Developer Support before launch.**

## 1. Create a MapKit JS key

1. <https://developer.apple.com/account> → **Certificates, Identifiers & Profiles**
2. **Keys** → **+**
3. Name: `Portage MapKit JS`
4. Tick **MapKit JS**, then **Configure** and pick your domain(s)
5. **Continue** → **Register**
6. **Download** the `.p8` file

> You can download the `.p8` **exactly once.** Save it immediately to a
> password manager. If you lose it, revoke the key and make a new one.

## 2. Collect the three values

| Value | Where |
|---|---|
| **Team ID** | Top right of the developer portal, or Membership details. 10 characters. |
| **Key ID** | Shown on the key you just created. 10 characters. |
| **Private key** | The contents of the `.p8` file, including the BEGIN/END lines. |

## 3. Put them in your environment

```bash
MAPKIT_TEAM_ID=ABCDE12345
MAPKIT_KEY_ID=FGHIJ67890
MAPKIT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQg...
-----END PRIVATE KEY-----"
```

If your host cannot hold multi-line values, replace the newlines with `\n` —
`loadEnv()` restores them.

All three are required together; setting one or two is a startup error.

## 4. Verify

```bash
cd backend && npm run dev
curl -s localhost:3000/api/maps/token | head -c 120
```

You should get `{"token":"eyJhbGciOiJFUzI1NiIs...","expiresAt":...}`.

## How tokens work here

The browser cannot hold your private key, so the server mints a short-lived
JWT (`backend/src/modules/maps/mapkit.ts`):

- **ES256** signed with your `.p8`
- **30 minute** lifetime, bound to your **origin**, so a token scraped from
  your page cannot be replayed from another site against your quota
- Served from `GET /api/maps/token`, rate-limited and edge-cached for less
  than the token's lifetime

> **MapKit JS 6** (June 2026) added static domain-bound tokens, which remove
> the need for JWT signing entirely. The JWT path is built and tested, so
> there is no urgency, but it is a simplification worth evaluating.

## Quotas — the real risk

| Allowance | Limit |
|---|---|
| Map views | 250,000 / day |
| **Service calls** (search, geocoding) | **25,000 / day** |

Exceeding either returns **HTTP 429**. There is **no overage billing and no
paid tier** — only a contact-Apple form.

Map views are not the concern; service calls are. This is the second reason
address autocomplete is built from our own Regina gazetteer rather than
`mapkit.Search`: it sidesteps the licence *and* the quota.

## Regina coverage

Apple's rebuilt map covers all of Canada. The 3D "detailed city experience" is
Montreal, Toronto and Vancouver only — irrelevant for our use.

For addresses, City of Regina open data publishes roughly 70,000 authoritative
civic address points plus neighbourhood boundaries, free. That is better local
data than any global geocoder, and it is permanently storable.

## Ask Apple these two questions before launch

1. May we permanently store latitude/longitude in our database when those
   coordinates were obtained from a **non-Apple** source (municipal open
   data), while displaying them on an Apple map via MapKit JS?
2. Does displaying **our own** property data on an Apple map create any
   restriction on how we store or use that data elsewhere in our product?

Keep the written answers. If either comes back unfavourable, the fallback is
MapLibre GL JS with self-hosted Protomaps tiles (~$0–10/month), and the swap
is contained because the map sits behind an interface.
