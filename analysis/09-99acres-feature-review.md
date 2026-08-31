# 99acres — feature and design review

A read of what 99acres actually puts in front of users, and what of it belongs
in Portage. Features and interface only; pricing and monetization are out of
scope by request.

**How this was gathered.** Direct access to 99acres.com, magicbricks.com and
housing.com is blocked by this environment's network egress policy, so nothing
below comes from reading the live site. It is assembled from search-result
summaries of the company's own help pages, app-store listings, and comparison
write-ups (sources at the end). Anything about layout or interaction is
therefore a description of what is documented, **not** a firsthand observation —
treat the design notes in §2 as hypotheses to confirm by opening the site,
which takes ten minutes and is worth doing before building anything from them.

---

## 1. Feature inventory

### Search and discovery

| Feature | What it does | For Portage |
|---|---|---|
| **Advanced filters** | Location, budget, property type, size, amenities | ✅ **Built** — `FilterSpec` covers all of these |
| **Map search** | Browse on a map, with nearby civic amenities shown | ✅ Sprint 6 |
| **Similar localities** | "You might also like these neighbourhoods" | ⚠️ **Worth adding** — see §3 |
| **Saved searches** | Store a search and return to it | ⚠️ Schema exists (`saved_searches`), unbuilt |
| **Property alerts** | Notify when new matches appear | ⚠️ Schema + consent gate exist, unbuilt |
| **Shortlist / favourites** | Save individual listings | ⚠️ Not built |
| **Compare** | Side-by-side comparison of shortlisted properties | ⚠️ **Worth adding** — cheap, high value |
| **Personalized recommendations** | Ranking learned from a user's behaviour | ❌ Not at Regina scale — needs volume we won't have |

### Trust and verification

| Feature | What it does | For Portage |
|---|---|---|
| **Verified tag** | Owner uploads ownership documents; location data validated; badge granted after screening | ⚠️ Partly built — `verifications` table exists, only email wired |
| **Resident reviews** | Current and past residents rate the building/locality | ⚠️ **Strong idea**, see §3 |
| **Builder ratings** | Ratings for developers | ❌ Not applicable — Regina resale/rental, not new-build towers |
| **Genuine photos and video** | Presented as an authenticity signal | ✅ Photo pipeline built this sprint; `phash` for stolen-photo detection still open |

### Market data

| Feature | What it does | For Portage |
|---|---|---|
| **Price trends** | Price movement by locality across 22 cities | ⚠️ **Yes** — from SAMA assessment data |
| **Locality insights** | Per-neighbourhood pages with stats | ⚠️ **Yes** — the gazetteer already has boundaries |
| **Registry records** | Government registry data on transactions | ❌ Saskatchewan ISC data is fee-based; check terms first |
| **Area unit converter** | sq ft ↔ sq m ↔ acres etc. | ✅ Trivial; do it client-side |

### Owner / seller tools

| Feature | What it does | For Portage |
|---|---|---|
| **Post property** | Address, size, price, features, photos | ✅ **Built** (Sprint 4) |
| **My99acres dashboard** | Active / expired / deleted / under-screening listings, plus responses | ⚠️ Partly — `listMine` returns them; no response inbox |
| **Response management** | Enquiries collected against each listing | ⚠️ Not built — `messaging` module is an empty directory |
| **Post via WhatsApp** | Create a listing through a chat thread | ❌ Deferred — matches the existing "design for WhatsApp, build later" decision |
| **Relationship manager** | A human who shortlists buyers, plans visits, arranges photography | ❌ **Deliberately not.** This is the salaried-human cost that killed every Canadian competitor. Non-negotiable. |

### Financial tools

| Feature | For Portage |
|---|---|
| **EMI calculator** (mortgage payment) | ⚠️ **Yes** — trivial, and the single most-used tool on any property portal |
| **Budget calculator** ("what can I afford") | ⚠️ Yes |
| **Loan eligibility calculator** | ⚠️ Yes, but Canadian rules differ — this is the **stress test** (qualifying rate), which is a genuine differentiator most Canadian sites do badly |

### Content

Blog, buyer guides, market news. Cheap SEO surface. Portage's SEO moat is
listing pages, but neighbourhood guides for Regina would compound.

---

## 2. Design notes — treat as unverified

What the write-ups consistently describe: clarity, low clutter, everything
findable, filters prominent. Nothing surprising, and nothing that argues
against the direction Portage is already going.

Two structural patterns worth confirming firsthand, because both are decisions
Portage has to make anyway:

1. **Filters as a persistent rail, not a modal.** Property search is iterative
   — people adjust price, then beds, then draw a boundary. A modal that must be
   reopened per change makes that painful. Confirm whether 99acres keeps
   filters visible alongside results on desktop.

2. **Card density.** How much goes on a search card — price, beds/baths, sqft,
   one photo, locality — decides how many fit above the fold, which decides
   whether search feels fast. Portage's `SearchResultCard` already returns
   exactly this set, so the question is presentation, not data.

---

## 3. The three worth stealing

Filtering everything above by "does this work at Regina scale, with no salaried
humans, and does it help the demand side that a cold-start marketplace needs":

### 1. Resident reviews of buildings and neighbourhoods

**Why it matters more here than there.** Portage's cold-start problem is having
no listings. Reviews are content that does *not* require a listing to exist —
someone who rented in Cathedral for three years can write one today. It gives
people a reason to visit before there is any inventory, and it is exactly the
information Realtor.ca does not carry.

**Cost:** a table, a form, moderation through the queue already built. Low.

**Risk:** defamation. A review naming a landlord as a slumlord is a legal
exposure that is genuinely different in Canada than in India. Review the
building, not the person — and put that in the moderation rules, not just the
guidelines. **Add to the Saskatchewan legal opinion.**

### 2. Compare shortlisted properties side by side

Cheap — it is a saved set of ids and a table view over data already returned by
search. It changes how people use the site: shortlisting turns browsing into a
decision process, which is what brings them back.

Needs a `shortlists` table and roughly one screen. Should be built with saved
searches, since both are "things a user keeps".

### 3. Mortgage tools built for Canadian rules

Every Indian portal has an EMI calculator. The Canadian equivalent that is
actually hard — and that most Canadian sites do badly — is the **mortgage
stress test**: qualifying at the greater of the contract rate plus 2% or the
minimum qualifying rate, plus CMHC insurance premium tiers by down payment,
plus provincial land transfer (Saskatchewan has none, which is itself worth
saying plainly), plus first-time buyer programs.

Doing this properly is genuinely useful, is pure computation with no per-use
cost, and is the sort of page that earns links.

### Explicitly not adopting

- **Relationship managers, professional photoshoots, site-visit coordination.**
  Every one is a salaried human against cyclical volume — the exact structure
  that killed FairSquare, Properly, Unreserved and Homie. This is not a
  resource question; it is the thing the business model is built to avoid.
- **Builder ratings.** Wrong market.
- **Behavioural recommendations.** Needs volume Regina will not produce for
  years. A good filter beats a bad recommender.

---

## 4. What this changes about the plan

Nothing already decided. Three additions to the backlog, in order of
value-per-effort:

| Add | Effort | Sprint |
|---|---|---|
| Shortlist + compare | ~1 sprint-week | With saved searches |
| Canadian mortgage tools | ~1 sprint-week | Any; independent of everything |
| Resident reviews | ~1.5 sprint-weeks | After moderation is live — it needs the queue |

The 99acres feature that Portage most conspicuously lacks is not on this list:
it is a **response inbox**, so an owner can see and answer enquiries. That is
already implied by the empty `modules/messaging/` directory and is a bigger
piece than any of the above.

---

## Sources

- [99acres — About Us](https://www.99acres.com/info/about-us)
- [99acres — Post Free Property Ads](https://www.99acres.com/postproperty/)
- [99acres — How to use My99acres effectively](https://www.99acres.com/articles/how-to-use-my99acres-effectively.html)
- [99acres — How to get your property verified](https://www.99acres.com/articles/verification-of-property-listed-on-99acres-com.html)
- [99acres — Property Rates & Price Trends](https://www.99acres.com/property-rates-and-price-trends-prffid)
- [99acres — Locality Reviews & Ratings](https://www.99acres.com/real-estate-reviews-and-ratings-wrffid)
- [99acres — Mobile Apps](https://www.99acres.com/mobile-apps)
- [99acres — Property Search on the App Store](https://apps.apple.com/us/app/99acres-property-search/id781765588)
- [Magicbricks vs 99acres vs Housing — 2025 buyer comparison](https://reraproperty.com/blog/1118/magicbricks-vs-99acres-vs-housing-vs-rerapropertycom-which-is-better-for-property-buyers-in-2025)
- [99acres vs MagicBricks vs Housing — lead quality](https://closingfox.com/for-business-owners/99acres-vs-magicbricks-vs-housing/)
- [NoBroker — Post property for rent](https://www.nobroker.in/post-property-for-rent/)
- [NoBroker — Online rental agreement](https://www.nobroker.in/rental-agreement)
- [New Age Property Search for 99acres — UI/UX case study](https://www.behance.net/gallery/87657893/New-Age-Property-Search-for-99acrescom-UIUX-Design)
