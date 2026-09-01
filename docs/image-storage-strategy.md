# Image storage and optimization strategy

Photos are the heaviest thing Portage will ever move. This document decides
where they live, what sizes exist, what format they are served in, and where
the resizing happens — and shows the arithmetic behind each choice, because at
this scale the wrong default is not slightly worse, it is ten times the bill.

**Status:** proposed. Nothing here is built yet. `listing_media` already carries
`storage_key`, `mime`, `bytes`, `position` and `phash`, and `ListingService`
already issues signed direct-to-storage upload tickets — so this slots into an
existing shape rather than needing new plumbing.

---

## The number that decides everything

A phone photo is 3–8 MB. A listing carries up to 30. At a modest Regina scale:

| | |
|---|---|
| Active listings | 2,000 |
| Photos per listing | 12 |
| **Total images** | **24,000** |
| Raw, untouched (5 MB each) | **120 GB** |
| After the strategy below | **~29 GB** |

But storage is the *small* number. A listings site is read-heavy in a very
particular way: one search page loads 24 cards, each with a photo. So:

| | |
|---|---|
| Page views / month | 100,000 |
| Images per view | 24 |
| Card image size | 150 KB |
| **Egress / month** | **~360 GB** |

**Egress is 12× storage, and it is the number that grows with success.**
Every hosting decision below follows from that one fact.

---

## 1. Where the bytes live

| Option | Storage /GB/mo | Egress /GB | 360 GB/mo egress costs | Verdict |
|---|---|---|---|---|
| **Cloudflare R2** | $0.015 | **$0.00** | **$0** | ✅ **Recommended** |
| Supabase Storage (Pro) | included to 100 GB | $0.09 over 250 GB | ~$10 and rising | Fine to start, unbounded later |
| AWS S3 + CloudFront | $0.025 | ~$0.085 | ~$31 | Costs more for the same thing |
| Vercel Blob | $0.023 | $0.05 | ~$18 | Convenient, priced for small files |
| Bunny.net | $0.01 | ~$0.01 | ~$4 | Cheap and good; smaller vendor |

### Why R2

**Zero egress fees, permanently.** That is R2's entire product thesis and it is
exactly the axis Portage is exposed on. Storage at this scale costs
`29 GB × $0.015 = **$0.44/month**`. The egress that would cost $10–31 elsewhere
costs nothing, and — more importantly — *stays* nothing when traffic triples.

For a business whose whole premise is charging no commission, a cost line that
scales with page views rather than revenue is the thing to design out.

**It also needs no new dependency.** R2 speaks the S3 API, and `lib/awssig.ts`
already implements AWS SigV4 by hand for SES and SMS. The same signer signs R2
requests. No SDK, no `npm install`, consistent with the zero-dependency rule
the rest of the backend follows.

### What to keep on Supabase

Nothing image-related. Supabase Storage stays available for the **document
locker** (agreements, invoices), which is low-volume, private, and benefits
from sitting next to the database and its row-level security. Different
problem, different tool.

> **Note on the current plan.** `analysis/06` said "S3 (ca-central-1)". That was
> written before the egress arithmetic above. S3 is not wrong, it is just
> ~$31/month more than R2 for identical behaviour, growing. Data residency is
> the one thing S3 ca-central-1 gives that R2 does not guarantee by default —
> see the caveat below.

### The one caveat: data residency

R2 buckets can be given a **location hint** (`enam` — eastern North America)
but Cloudflare does not contractually guarantee a region the way S3
ca-central-1 does. Listing photos are not personal information in the PIPEDA
sense — they are photographs of buildings, published deliberately — so this is
a lower bar than the document locker, which stays in `ca-central-1` regardless.

If Saskatchewan counsel comes back wanting Canadian residency for *all* user
content, the fallback is **Bunny.net** (which lets you pin a Canadian storage
region) or S3 ca-central-1 at the higher egress cost. This is worth adding to
the legal-opinion question list.

---

## 2. What gets stored: the variant ladder

Never serve a 5 MB original to a browser. Five derivatives, generated once:

| Variant | Longest edge | Where it is used | Typical size |
|---|---|---|---|
| `blur` | 20 px | inline placeholder, in the **database row** | ~30 bytes (blurhash) |
| `thumb` | 320 px | map pin previews, gallery filmstrip | ~15 KB |
| `card` | 800 px | search results — **the hot path** | ~90 KB |
| `detail` | 1600 px | listing page main image | ~250 KB |
| `full` | 2560 px | lightbox / zoom | ~600 KB |
| `original` | as uploaded | archival, re-deriving future sizes | ~600 KB |

Per image, all-in: **~1.2 MB**. Hence the 29 GB total above rather than 120 GB.

### The `blur` placeholder earns its place

A ~30-byte [BlurHash](https://blurha.sh) string stored on the `listing_media`
row itself renders as a blurred approximation *instantly*, with no network
request, while the real image loads. It costs one small text column and removes
every grey rectangle from the search page.

This is the highest perceived-performance return available, and it is nearly
free. It needs a new column:

```sql
ALTER TABLE listing_media ADD COLUMN blurhash text;
```

---

## 3. Format: AVIF, then WebP, then JPEG

| Format | Size vs JPEG | Browser support |
|---|---|---|
| **AVIF** | ~50% smaller | Chrome, Firefox, Safari 16.4+ |
| **WebP** | ~30% smaller | Universal in practice |
| JPEG | baseline | Everything |

Serve by content negotiation on the `Accept` header, or with `<picture>`:

```html
<picture>
  <source type="image/avif" srcset="…/card.avif">
  <source type="image/webp" srcset="…/card.webp">
  <img src="…/card.jpg" loading="lazy" decoding="async" width="800" height="600">
</picture>
```

Always set `width`/`height` (or `aspect-ratio`) — without them the page reflows
as each image arrives, which is both unpleasant and a Core Web Vitals penalty.

### HEIC must be transcoded

iPhones shoot HEIC by default and **no browser displays it**. `ALLOWED_PHOTO_MIME`
already accepts `image/heic`, which is right — rejecting it would turn away
photos from the most common camera in the country — but it means transcoding is
mandatory, not optional. A HEIC that reaches storage untranscoded is an image
that silently never renders.

---

## 4. Where the resizing happens

This is the decision with the most ways to get it wrong.

### Step 1 — Compress in the browser, before upload

**The single biggest win, and it costs nothing.** Resize to 2560 px and encode
WebP at q80 using a `<canvas>` before the bytes ever leave the device:

- 5 MB → ~600 KB, an **88% reduction**
- Uploads finish in a fraction of the time on a phone connection
- Storage, transform cost, and bandwidth all shrink by the same factor
- A 30-photo listing becomes a plausible thing to upload rather than a
  five-minute ordeal

The server must still validate — a client-side control is a courtesy to honest
users, never a security boundary — but the honest 99% get a dramatically better
experience for zero infrastructure.

### Step 2 — Derive variants on Cloudflare

| Approach | Cost | Notes |
|---|---|---|
| **Cloudflare Images** | $5 per 100k stored/mo, $1 per 100k delivered | Storage + resize + format in one product |
| **Image Resizing on R2 via Workers** | $0.50 per 1,000 unique transforms | Keeps R2 as the origin; pay per *unique* variant, cached after |
| Vercel Image Optimization | ~$5 per 1,000 source images beyond Pro's included | Expensive at this volume |
| `sharp` in a Vercel function | compute per transform | Native binary, cold starts, and an npm dependency |

**Recommended: R2 + Cloudflare Image Resizing.** It keeps the origin bytes
under our control in a bucket we can move, pays only for *unique* transforms
(cached thereafter, so a popular listing costs one transform not one per view),
and avoids adding `sharp` to a backend that currently has exactly one runtime
dependency.

### Step 3 — Eager for three sizes, lazy for the rest

Generate `thumb`, `card` and `detail` at upload — they are certain to be
requested. Leave `full` to be generated on first view; most listings are never
opened in the lightbox.

---

## 5. Strip EXIF. This one is not optional.

**Phone photos carry GPS coordinates in EXIF.** A listing photo published with
its metadata intact discloses the exact location of the property — and often the
photographer's device identifier and the timestamp.

Three reasons this is a hard requirement rather than a nicety:

1. **Privacy.** For a rental listing where the owner has chosen to show an
   approximate location, embedded GPS silently overrides that choice.
2. **It contradicts the entire map architecture.** Portage takes deliberate care
   to source coordinates from City of Regina open data because Apple's licence
   forbids storing theirs. Leaking a precise coordinate through an image's
   metadata makes that care pointless.
3. **Safety.** Photos of an occupied home, with a public "when is this vacant"
   signal and exact coordinates attached, is a combination worth not shipping.

Strip **all** metadata on ingest, keeping only the EXIF orientation flag — and
apply that rotation to the pixels before discarding it, or every photo taken in
portrait arrives sideways.

---

## 6. Abuse and integrity, using what already exists

`listing_media.phash` is in the schema and currently unwritten. Compute a
perceptual hash at upload:

- **Stolen photos.** The most common listing scam is photographs lifted from
  another listing or a real-estate site. A near-duplicate phash against an
  existing listing is a strong signal and should feed `risk_signals`, which
  already orders the moderation queue.
- **Duplicate detection within a listing.** Cheap and slightly polishing.

Also validate that the bytes are actually the image type claimed — check magic
bytes server-side, not `Content-Type`, which the client chooses.

---

## 7. Cost summary

At 2,000 listings / 24,000 images / 100k monthly page views:

| Line | Monthly |
|---|---|
| R2 storage (29 GB) | $0.44 |
| R2 egress (360 GB) | **$0.00** |
| R2 Class B operations (~2.4M reads) | ~$0.86 |
| Cloudflare Image Resizing (~72k unique transforms, first month) | ~$36 one-off, then near zero |
| **Steady state** | **~$1.30 / month** |

For comparison, the same traffic on Supabase Storage runs ~$10/month and rises
linearly with page views; on S3 + CloudFront, ~$31/month.

The point is not the $9 difference today. It is that R2's line stays flat while
the others grow with exactly the metric a free-to-list marketplace most wants
to grow.

---

## 8. What this needs, in order

1. `ALTER TABLE listing_media ADD COLUMN blurhash text` (migration 013)
2. `modules/storage/` — R2 client signing with the existing `lib/awssig.ts`
3. Upload-completion callback: validate magic bytes, strip EXIF, compute
   `phash` and `blurhash`, write the real `content_hash`
4. Browser-side compression in the upload component
5. Variant URL helper, so the frontend asks for `card`/`detail` by name and
   never constructs a transform URL by hand
6. `<picture>` rendering with AVIF → WebP → JPEG

Steps 1–3 close WS0 gap 4, which is still open: `signStorageUrl` mints tickets
and `verifyStorageUrl` has no caller, so **no uploaded byte is currently stored
anywhere**. That gap has to close before listings are usable regardless of which
vendor wins.
