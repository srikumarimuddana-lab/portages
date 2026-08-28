# 01 — Portage Feature Inventory (from the design prototype)

> Source: `Portage_Real_Estate_standalone.html` (design prototype, uploaded 2026-08-28). All 553 visible UI strings were extracted from the bundled page and grouped into the features below. Stats shown in the design (e.g. "142,608 active listings") are illustrative placeholder data, as the design's own footer notes ("Design prototype — data is illustrative").

## Positioning (as designed)

- **"FREE FOR EVERYONE — No listing fees · No commission · No paywalls — buyers, renters and sellers."**
- Owner-direct marketplace: *"No agent required. Portage is free — the owner pays nothing and neither do you."*
- Scope: **Buy · Rent · Sell across Canada**, prices in CAD, "all 10 provinces."
- Brand: PORTAGE, Airbnb-inspired soft/rounded visual theme.

## Feature inventory (grouped, F1–F40)

### A. Discovery & search
| # | Feature | Detail in design |
|---|---|---|
| F1 | Buy/Rent mode toggle | Hero + search page |
| F2 | Location search | City / neighbourhood / address box; city quick-picks: Toronto, Vancouver, Montréal, Calgary, Ottawa, Halifax, Winnipeg (**Regina is absent** — must be added for the chosen launch city) |
| F3 | Property-type browse | houses, condos, townhouses, apartments, cabins, land |
| F4 | Filters | Max price, bedrooms, bathrooms, property type (detached/semi/condo/townhouse/apartment), min size (sqft), must-have amenities, keyword (e.g. "garage, pet friendly"), saved-homes-only |
| F5 | **Room-type filter** | Any / Entire place / Private room / Shared room — "Room sharing and private rooms — great for students and newcomers" (a differentiator most Canadian portals lack) |
| F6 | Sort & results | Newest, price asc/desc; result count; load-more pagination; empty-state guidance |
| F7 | Map view | Interactive map with price pins, tap-to-preview card, list/grid/map switcher |
| F8 | Saved searches + alerts | Per-search alert toggle and frequency |
| F9 | **AI "Search by chat"** | Natural-language search ("two bedrooms in Ottawa under $2,000 with parking") → assistant sets visible filter chips; user can remove any chip; live match count; open results in map view |

### B. Listing page
| # | Feature | Detail in design |
|---|---|---|
| F10 | Media gallery | Multi-photo, cover photo |
| F11 | **3D virtual tour** | Badge/CTA on listing |
| F12 | Facts & description | Type, beds, baths, size, amenities, home features |
| F13 | "What's nearby" | Nearby places list |
| F14 | **Mortgage calculator** | Down-payment %, rate %, amortization years → monthly payment + property-tax estimate + total monthly cost |
| F15 | **Rent vs buy** | Own monthly cost vs average rent for the city + verdict |
| F16 | **Price history & "Portage estimate"** | Automated valuation (AVM) "Portage estimate today" + multi-year price history |
| F17 | **Neighbourhood scores** | Transit, schools, quiet — "built from open Canadian data" |
| F18 | Owner card | "Owner · verified · replies in ~1 h"; Message the owner; Save; **Book a viewing** |

### C. Selling / listing (supply side)
| # | Feature | Detail in design |
|---|---|---|
| F19 | Listing wizard | Address → Sell/Rent-out → type/beds/baths/size → price → photos (drag-drop, cover) → description → review → publish ($0) |
| F20 | **AI price suggestion** | "Portage suggestion for similar homes nearby" |
| F21 | **AI description drafting** | "Describe the home, or let Portage draft it for you" |
| F22 | **AI "List by chat"** | Assistant interviews the seller and builds a live listing draft; publish unlocks when complete; attach photos + **ID documents for validation**; voice notes |
| F23 | Moderated publishing | "Listings are checked by our team within 24 hours"; pending-review state; edit/pause anytime |

### D. Messaging & viewings
| # | Feature | Detail in design |
|---|---|---|
| F24 | Owner-direct chat | Threads per listing; emoji; photo/document attachments; **voice notes**; listing context panel in-thread |
| F25 | ID/document validation in chat | "Attach more photos or ID documents for validation" |
| F26 | Viewings | Book/cancel; date/time/host; status; dashboard list |

### E. Dashboard (role-aware: buyer / renter / seller / owner)
| # | Feature | Detail in design |
|---|---|---|
| F27 | Saved homes | Heart/save anywhere; remove; view |
| F28 | **Compare table** | Price, beds, baths, size, $/sqft, transit score across saved homes |
| F29 | Saved searches & alerts management | Query, tags, frequency |
| F30 | Messages hub | Unread badges |
| F31 | **My-listings analytics** | Status, views, saves, messages per listing |
| F32 | Viewings hub | Upcoming, cancel |
| F33 | Profile & preferences | Name/phone/email, notification toggles, preferred cities |

### F. Home-services marketplace
| # | Feature | Detail in design |
|---|---|---|
| F34 | Pro directory | "Vetted local pros — cleaning, HVAC, plumbing and more"; category chips; city; rating ★ + jobs count; "Verified · insured"; upfront pricing; availability |
| F35 | Pro profile | Photos, services & pricing table, reviews, book a visit / message / save |
| F36 | Pro acquisition | "Are you a pro? Join the marketplace — leads from homeowners in your area, **no subscription**. Apply to join" |

### G. Admin & trust (staff)
| # | Feature | Detail in design |
|---|---|---|
| F37 | Listing review queue | Approve / reject / request changes; photos; seller description; **automated checks**; **document verification** panel |
| F38 | User management | Name, role, listings count, joined |
| F39 | Reports queue | User-flagged listings/threads; type, subject, reporter, severity, resolve |
| F40 | Assistant capabilities card | "What I can do": find a rental or home; list your property; book viewings; mortgage estimates |

## User journeys the design supports

- **Buyer**: search (form or chat) → filter/map → listing page (tour, calculator, estimate, scores) → save/compare → message verified owner → book viewing → (transaction happens off-platform).
- **Renter / student / newcomer**: rent mode + room-type filter → alerts → chat with owner → viewing. (No application, screening, lease, or payment step yet — see gap analysis.)
- **Seller / landlord**: wizard or chat-listing with AI price + description → ID validation → 24 h moderation → live listing → analytics → chats/viewings → (offer, paperwork, closing happen off-platform).
- **Service pro**: apply → profile with pricing/reviews → receive bookings/messages.
- **Admin**: review queue with automated checks + documents → user management → abuse reports.

## Observations (design-internal)

1. **Regina is missing from the design's own city list** — the launch city needs first-class presence (data, scores, seeded listings).
2. **The journey stops at the viewing.** Offers, purchase agreements, deposits, rental applications, screening, leases, rent collection, and move-in are all off-platform today — this is where most competitor differentiation (and monetization) lives. See `04-gap-analysis-and-roadmap.md`.
3. **Trust mechanics are a real strength**: ID validation, human 24 h moderation, automated checks, verified-owner badge, reports queue — these map directly to the #1 pain of Kijiji/Facebook-style owner-direct markets (scams).
4. **"Free forever" + "no subscription" for pros** means the design currently has **zero revenue surface** — the business-model section must reconcile this (NoBroker's playbook is the reference).
5. AVM estimates, price history, and neighbourhood scores depend on **data acquisition** (sold data access is restricted in Canada; open data varies by city) — see regulatory and competitor docs.
6. Accessibility/i18n: design is English-only (fine for Regina launch; French matters only for later Québec expansion).
