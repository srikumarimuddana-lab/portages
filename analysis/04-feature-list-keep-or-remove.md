# 04 — Master Feature List (Keep / Remove Decision Sheet)

> **How to use this:** every candidate feature has an ID, a source of inspiration with a reference, an effort estimate, a revenue flag, and a recommended phase. Mark **KEEP** or **REMOVE** in the last column. Features already in your design are marked ✅ EXISTS.
>
> Effort: **S** = days · **M** = 2–6 weeks · **L** = 2–3 months · **XL** = 3+ months
> Revenue: 💰 = direct revenue · 🔁 = retention/engagement · 🛡️ = trust/defensibility
>
> **Scope decisions already applied (your call, 2026-08-28):** no lease generation, no rent collection, no payment rails. Replaced by a **document locker** (D1). The regulatory research strongly supports this — see the note under Section D.

---

## Section A — Already in your design (validate, don't rebuild)

| ID | Feature | Verdict from research | Keep? |
|---|---|---|---|
| A1 | ✅ Buy/Rent/Sell modes, free for everyone | Novel bundle in Canada; no direct competitor | |
| A2 | ✅ Map / list / grid search + filters | Table stakes | |
| A3 | ✅ **Room-type filter** (entire/private/shared) | **Validated** — SpacesShared already runs student-senior room-sharing in SK with 10k+ users via college partnerships | |
| A4 | ✅ Saved searches + alerts | Table stakes. ⚠️ CASL: needs express opt-in, unchecked by default | |
| A5 | ✅ **AI chat search** (NL → filters) | On-trend but **will be commoditized** — Zillow (2023), Realtor.com "Search It, How You Say It" (Oct 2025), RealAssist AI (Jun 2026). Ship fast; don't treat as a moat | |
| A6 | ✅ **AI listing builder by chat** | Genuinely rare. Strong differentiator for non-technical owners | |
| A7 | ✅ AI price suggestion | Keep, but see A8 warning and C4 | |
| A8 | ✅ **AVM "Portage estimate"** | **Table stakes, not a moat** — HonestDoor gives free AVMs nationally incl. SK since 2022. ⚠️ Must be disclaimed as "estimate, not an appraisal" | |
| A9 | ✅ AI listing descriptions | Keep + require owner review/attestation (Competition Act s.74.01 exposure) | |
| A10 | ✅ Mortgage calculator + rent-vs-buy | Keep — becomes the funnel for B7/B8 | |
| A11 | ✅ Neighbourhood scores (transit/schools/quiet) | Keep — differentiate on **Regina open-data depth**, since HouseSigma is absent from SK | |
| A12 | ✅ Price history | Keep. Note: sold-price data access is restricted in Canada | |
| A13 | ✅ 3D virtual tour | Keep — upgrade path to a paid SKU (C1) | |
| A14 | ✅ **Verified-owner ID validation** | **This is your strongest feature.** FCAA/SRA/BBB Saskatchewan have all issued fake-listing warnings; CAFC logged $638M fraud losses in 2024 | |
| A15 | ✅ Owner-direct chat (photos, docs, voice notes) | Keep | |
| A16 | ✅ Viewing bookings | Keep — but keep it **tool-like** (owner controls the calendar); staff scheduling on a seller's behalf risks the "showing" limb of SK's trading definition | |
| A17 | ✅ Saved homes + **compare table** | Keep — genuinely good, rare in Canadian portals | |
| A18 | ✅ My-listings analytics (views/saves/messages) | Keep — extend with benchmarking (C6) | |
| A19 | ✅ Home-services marketplace | Keep — **this is your primary revenue engine**. Restructure per E1–E4 | |
| A20 | ✅ Admin moderation + automated checks + reports queue | Keep — supercharge with B1/B2 | |
| A21 | ⚠️ **Add Regina to the city list** | Your design's city chips list Toronto/Vancouver/Montréal/Calgary/Ottawa/Halifax/Winnipeg — **Regina is missing** | |

---

## Section B — Trust & anti-fraud (highest strategic value)

| ID | Feature | Inspired by / reference | Effort | Flag | Phase | Keep? |
|---|---|---|---|---|---|---|
| B1 | **"Broker Buster" AI** — detect agents/scammers posing as owners: repeat phone/email/IP, portfolio-size heuristics, reverse-image photo matching | NoBroker's architecturally-enforced owner-only rule ([model analysis](https://www.markhub24.com/post/nobroker-s-direct-property-listing-without-brokerage-model)) | M | 🛡️ | MVP | |
| B2 | **100% AI conversation auditing + auto-delist** — scan in-app chat for scam patterns, off-platform payment steering, "already rented/sold" signals; auto-flag or delist | NoBroker **ConvoZen**: 45,000+ hrs training data, 100% call audits vs ~2% human sampling, real-time auto-delisting ([Business Standard, Feb 2025](https://www.business-standard.com/content/press-releases-ani/nobroker-unveils-convozen-ai-a-comprehensive-conversational-ai-cloud-for-the-agentic-era-125022800864_1.html)) | M | 🛡️🔁 | MVP | |
| B3 | **"Verified owner" trust badge + public scam-safety page** — explain exactly what was verified, plus "never e-transfer before a viewing" guidance | Saskatchewan FCAA/SRA/BBB scam warnings; [FTC: ~half of rental scams start on Facebook](https://search.ftc.gov/system/files/ftc_gov/pdf/rental-scams-spotlight-2025.pdf) | S | 🛡️ | MVP | |
| B4 | **"Your listing, your lead" written promise** — every inquiry goes only to that owner; never resold, never diverted | Homes.com ([Your Listing Your Lead](https://www.homes.com/solutions/yourlistingyourlead)); brand awareness 4%→33% in a year | S | 🛡️ | MVP | |
| B5 | **Verified-resident reviews of buildings & landlords** — only lease-verified tenants can review | MyGate's staff-rating layer, adapted; unique data no MLS portal has | M | 🛡️🔁 | v2 | |
| B6 | **Neighbourhood UGC polls** ("safe at night?", "walkable?", "quiet?") | Trulia **"What Locals Say"** ([trulia.com/neighborhoods](https://www.trulia.com/neighborhoods/)) — millions of resident reviews | M | 🔁 | v2 | |
| B7 | ⚠️ **Optional** tenant screening as a *referral* (SingleKey ~$29.99, Certn) — landlord-paid or tenant-initiated portable profile | Zillow $35/30-day universal application; [SingleKey](https://singlekey.com/knowledge-base/%F0%9F%92%BC-singlekey-pricing-breakdown-know-what-youre-paying-for) | M | 💰 | v2 | |

> ⚠️ **B7 carries a Saskatchewan legal trap.** The Residential Tenancies Act, 2006 states: *"A landlord must not charge a person for accepting an application for a tenancy, processing an application… investigating an applicant's suitability as a tenant, or accepting a person as a tenant."* Charging **tenants** for applications/screening would likely be attacked as doing indirectly what landlords cannot do directly. **This kills the #1 US rental monetizer.** If you do screening, charge the landlord — and get legal review first.

---

## Section C — Buyer/seller product depth

| ID | Feature | Inspired by / reference | Effort | Flag | Phase | Keep? |
|---|---|---|---|---|---|---|
| C1 | **Premium listing media SKU** — AI virtual staging + interactive floor plan + hero placement, ~$40–80/listing | Zillow **Showcase**: listings sell for **~$7,000 more**, +75% views, +68% saves, agents win 30% more listings ([Zillow, Sep 2025](https://zillow.mediaroom.com/2025-09-10-Zillow-brings-AI-powered-Virtual-Staging-to-Showcase-listings)) | M | 💰 | v2 | |
| C2 | **Seller "deal room" dashboard** — showings calendar, offer list, counter-offer tracking, document checklist | Houzeo's seller dashboard; sellers saved avg $8,701 in 2025 ([houzeo.com](https://www.houzeo.com/pricing)) | L | 🔁 | v2 | |
| C3 | **Self-serve tour booking with ID-verified buyers** — owner publishes slots, verified buyers self-book | Zillow Real-Time Touring: *"the highest-quality buyers book tours on their own"* ([Zillow](https://www.zillow.com/premier-agent/real-time-touring/)) | M | 🔁 | MVP+ | |
| C4 | **Publish AVM accuracy stats + confidence bands** per city | Zillow publishes Zestimate median error (1.94% on-market / 7.06% off-market). Transparency defuses "black box" objections and the FSBO underpricing attack | S | 🛡️ | v2 | |
| C5 | **AI "ask this home anything"** — per-listing Q&A on taxes, utilities, zoning, reno history | Flyhomes AI; Homes.com "transformative AI experience" (Feb 2026); CoStar Smart Search (Oct 2025) | M | 🔁 | v2 | |
| C6 | **Benchmarked listing analytics** — "your listing got 68% more saves than comparable Regina 3-beds" | Zillow Showcase metrics; sells the C1 upgrade | S | 💰 | v2 | |
| C7 | **Flat-fee MLS / REALTOR.ca "mere posting" bridge** as an optional paid upgrade via a partner brokerage | Houzeo $199–399 (US); Canadian mere postings run **$500–$1,500** (ComFree $497–$1,197, HonestDoor ~$500, Bōde $949) | M | 💰 | v2 | |
| C8 | **Commute-time & amenity map overlays** | Trulia's 34 overlays; Zillow NL commute search. ⚠️ Avoid crime overlays in Canada (defamation/discrimination risk) | M | 🔁 | v2 | |
| C9 | **Roommate / flatmate matching** | NoBroker "Find My Flatmate"; pairs with your existing A3 room filter; U of R had record enrolment of 17,409 (Fall 2024) | M | 🔁 | v2 | |
| C10 | **Quarterly "Regina Rent & Price Index"** from platform data — free PR and SEO | Apartments.com RentPulse; Zumper rent reports | S | 🔁 | v2 | |
| C11 | **Portage app inside ChatGPT / Claude / Gemini** — conversational search deep-linking back to Portage | Zillow launched the only real-estate app in ChatGPT (Oct 6, 2025), built in ~6 weeks | M | 🔁 | v3 | |
| C12 | **Buyer affordability badge** ("what you can afford at today's rates") on every listing | Zillow **BuyAbility**: 2.9M enrollees; ~44% mortgage attach in enhanced markets | M | 💰 | v2 | |

---

## Section D — Documents (your revised scope)

| ID | Feature | Notes & reference | Effort | Flag | Phase | Keep? |
|---|---|---|---|---|---|---|
| D1 | **📁 Document locker** — upload, organize, retrieve and share signed agreements, invoices, receipts, inspection reports, condo documents. Attach to a listing, a chat thread, or a property. **Passive storage — Portage does not generate, sign, or process anything** | Your scope decision. Fills the post-viewing gap without touching regulated activity | M | 🔁 | MVP+ | |
| D2 | Document **sharing with expiry** — share a document into a chat thread with a time limit and revocation | Extends A15 | S | 🛡️ | v2 | |
| D3 | Document **checklist templates** (informational only — "what you'll need for a private sale in SK") linking to lawyers, not filled-in forms | SK exempts *"the provision of legal information"* from the practice of law — but completing forms for a user is legal **services** | S | 🔁 | v2 | |
| D4 | ~~Lease generation / e-signing~~ | **REMOVED per your decision** | — | — | — | ❌ |
| D5 | ~~Rent collection / payment rails / rent reporting~~ | **REMOVED per your decision** | — | — | — | ❌ |

> ### ✅ Why your scope cut is the right call — three regulatory landmines avoided
> 1. **Rent payments would trigger FINTRAC MSB registration.** FINTRAC's published position is that acting as an intermediary for payments including *"mortgage and rent"* is money-services-business activity requiring registration and a compliance program — **plus** Bank of Canada registration under the Retail Payment Activities Act.
> 2. **Holding deposits has no lawful home.** Only registered brokerages may run real-estate trust accounts in Saskatchewan. An unregistered platform holding transaction money invites both SREC and FINTRAC problems.
> 3. **Lease/offer drafting risks unauthorized practice of law** *and* the "trading in real estate" line under The Real Estate Act (SK).
>
> **But note the flip side:** you have also removed the two highest-yield revenue lines in the US rentals playbook (tenant-paid applications and payment spread). Section E must therefore carry the business model. See doc 05.
>
> ⚠️ **The locker still carries PIPEDA duties** — leases, invoices and ID documents are sensitive personal information. Design for: encryption at rest, user-controlled deletion, a documented retention schedule, Canadian data residency, and breach-response. The OPC has found that indefinite retention of ID data violates PIPEDA, and advises that copying government ID "should not be a standard operating practice" — so for **verification** (A14) use verify-then-delete (store pass/fail + audit hash), and keep the user's own locker (D1) strictly user-controlled.

---

## Section E — Services marketplace (your main revenue engine)

| ID | Feature | Inspired by / reference | Effort | Flag | Phase | Keep? |
|---|---|---|---|---|---|---|
| E1 | **Homeowner-choice quote requests** — the homeowner picks which pros to contact. **Never sell one lead to five pros** | Angi's 2025 pivot: deliberately destroyed **81% of network lead volume**; pro churn then fell ~30%, retention +17%. Thumbtack's opposite model: 1,000+ BBB complaints | M | 💰 | MVP+ | |
| E2 | **Transaction-moment sequencing** — trigger movers at lease signing, cleaning at move-out, locksmith/painting at possession | NoBroker does ~200,000 service requests/month by attaching to transaction moments | M | 💰 | v2 | |
| E3 | **Pro subscription or per-accepted-booking fee** (not per-lead) | Yelp Request-a-Quote; Homes.com membership (~$3,400/yr avg) | M | 💰 | v2 | |
| E4 | **Verified trade licences in pro onboarding** | ⚠️ In SK, electrical and gas contractors are licensed by **TSASK** ($10,000 surety bond); construction electrician, plumber, refrigeration/AC, sheet metal and sprinkler fitter are **compulsory-apprenticeship trades**. Saying pros are "vetted & insured" without a per-pro evidence file is a Competition Act s.74.01 exposure | M | 🛡️ | MVP+ | |
| E5 | **Movers quote calculator** (distance/size → instant estimate) with 2–3 vetted Regina partners | NoBroker packers & movers, adapted as referral not aggregator | S | 💰 | v2 | |

---

## Section F — Directories (your additions)

| ID | Feature | Notes & reference | Effort | Flag | Phase | Keep? |
|---|---|---|---|---|---|---|
| F1 | **Real-estate agent directory** — profiles, specialties, reviews, contact; "find an agent if you want one" | Your request. Zillow Premier Agent is the model: leads at ~$20–60 (up to $450+) or **Flex at 15–40% of closed commission**. ⚠️ **Never use REALTOR® or MLS® in branding or as a generic noun** — CREA trademarks; "REALTOR® must not be used as a synonym for real estate agent" | M | 💰 | v2 | |
| F2 | **Mortgage broker/agent directory** + pre-approval hand-off from the calculator (A10) | Your request. Zillow's mortgage attach is ~44% in enhanced markets. ⚠️ SK mortgage brokerages are FCAA-licensed under The Mortgage Brokerages and Mortgage Administrators Act; referral-fee disclosure rules apply to the licensee. Mortgage brokers became FINTRAC reporting entities in Oct 2024 (you stay a referrer) | M | 💰 | v2 | |
| F3 | **Real-estate lawyer directory** — flat-fee conveyancing quotes | **Every Saskatchewan private sale ends at two law offices.** ISC transfers need a witness who is a practising SK lawyer (or affidavit of execution). Lean into this rather than replacing it — DuProprio bundles notary support for exactly this reason | S | 💰 | MVP+ | |
| F4 | **Home inspector / photographer / stager directory** | Extends E1 into the sale journey | S | 💰 | v2 | |

> **Positioning tension to resolve:** your design says *"No agent required."* F1 adds agents. The clean framing is **agent-optional, never agent-required**: owner listings are always the default tab (that's your structural wedge — see doc 03), and the agent directory is a service *the user chooses to open*. If agent leads ever start outranking owner listings, you have become Zillow, and the wedge is gone.

---

## Section G — Supply-side growth

| ID | Feature | Inspired by / reference | Effort | Flag | Phase | Keep? |
|---|---|---|---|---|---|---|
| G1 | **Property-manager & condo-board vacancy pipeline** — free lightweight tools (move-out notice capture → auto-drafted listing) so Portage sees vacancies *before* the market | MyGate/NoBrokerHood flywheel without building gate software. Condo Control already owns Canadian condo ops — partner, don't compete | L | 🔁 | v3 | |
| G2 | **Landlord acceleration tiers** — featured placement, boosts, "leased in 30 days or refund" guarantee | NoBroker MoneyBack tiers (₹3.4k–11k). Regina's 2.7% vacancy makes the guarantee cheap to honour. ⚠️ Write refund terms in plain English — refund disputes are NoBroker's biggest reputational wound | M | 💰 | v2 | |
| G3 | **Student & newcomer channel partnerships** (U of R, Sask Polytechnic) | SpacesShared's proven model — 10k+ users via college partnerships, already operating in SK | S | 🔁 | MVP+ | |
| G4 | **Remote/investor landlord bundle** via a licensed local property manager (~8–10% of rent, platform takes a slice) | NoBroker NRI property management. ⚠️ **Property management is registrable activity in SK** — you must be the referrer, not the manager | M | 💰 | v3 | |
| G5 | **Builder/new-construction listings** (1,687 Regina starts in 2025, +38%) | Fills the inventory gap in a 1.6-months-supply market | M | 🔁 | v2 | |
| G6 | **Seller concierge package** ($499–999: photos, 3D tour, AI price report, showing scheduler, lawyer referral) | Purplebricks-lite without licensed-agent overhead. ⚠️ **Verify the licensing boundary first** — anything resembling pricing advice or negotiation for a specific seller risks the "trade" definition | M | 💰 | v3 | |
| G7 | **Lightweight CRM for repeat landlords/multi-property owners** | Zillow paid $400M+ for Follow Up Boss for this logic, miniaturized | M | 🔁 | v3 | |
| G8 | **Hyperlocal advertising to verified residents** — *defer until ~10k+ MAU* | MyGate: **65–70% of revenue is advertising**, not SaaS. Needs density Regina won't have for years. ⚠️ CASL/PIPEDA constraints | M | 💰 | v4 | |

---

## Section H — Explicitly do NOT build

| ID | Anti-feature | Why |
|---|---|---|
| H1 | ❌ **iBuying / instant cash offers on your balance sheet** | Zillow Offers lost **>$1B in 3.5 years**; Opendoor lost $1.3B in 2025. Never take inventory risk on your own AVM. If wanted, offer a **partner** cash-offer button (referral only) |
| H2 | ❌ **Holding deposits or rent money** | FINTRAC MSB + RPAA + SK trust-account rules. NestAway (₹1,800 Cr → ₹90 Cr) died partly on deposit disputes |
| H3 | ❌ **Blind lead resale** in home services | Thumbtack's model; Angi burned 81% of its lead volume to escape it |
| H4 | ❌ **Salaried agents / human relationship managers** | Killed FairSquare, Homie, and Redfin's salaried model. Keep humans out of the unit economics |
| H5 | ❌ **Contact paywalls at launch** | Kills liquidity while Facebook Marketplace is free |
| H6 | ❌ **Guard/gate/visitor-management app** | No Canadian market; Condo Control owns the niche |
| H7 | ❌ **A second brand** | Trulia's UGC decayed under Zillow's shadow. One brand |
| H8 | ❌ **Using REALTOR®, MLS® or Multiple Listing Service®** in branding, product names or SEO copy | CREA trademarks. "The MLS® mark can never be used as part of a business name, trade name or in any corporate branding" |
| H9 | ❌ **Scraping Realtor.ca** | Breaches terms; CREA's DDF feed requires a Data Access Agreement and member direction — a non-member platform cannot get a feed on its own |
| H10 | ❌ **Crime map overlays** | US-normal, Canadian-risky (defamation + discrimination exposure) |
| H11 | ❌ **Operating co-living beds** | Stanza Living: 75,000 beds, first profit only via non-operating income |

---

## Recommended MVP (if you want a default answer)

**Ship:** A1–A21 (your design, plus Regina) + B1, B2, B3, B4 (trust) + D1 (document locker) + E1, E4 (services done right) + F3 (lawyer directory) + G3 (student/newcomer channel).

**Everything else is v2+.** That is roughly a 4–6 month build with the stack in doc 06, and it is the smallest thing that is genuinely better than Kijiji + Facebook + RentFaster for a Regina renter and a Regina FSBO seller.
