# Portage — Canada Business Analysis (Regina-first)

Complete analysis of the Portage zero-fee, owner-direct real-estate marketplace concept for Canada, launching in Regina, Saskatchewan. Built from five parallel research streams (~130 web searches, 2026-08-28) benchmarking Canadian, US and Indian players.

## Documents

| # | Document | What's in it |
|---|---|---|
| 01 | [Feature inventory](01-feature-inventory.md) | All 40 features extracted from your design prototype, user journeys, design-internal observations |
| 02 | [Competitive landscape](02-competitive-landscape.md) | **Does this already exist?** Canadian players, the FSBO graveyard, rental gaps, Regina market data |
| 03 | [US & India benchmarks](03-benchmarks-us-india.md) | Zillow/Redfin/Angi monetization + failure lessons; NoBroker & MyGate teardown; what doesn't translate |
| 04 | **[Feature list — keep or remove](04-feature-list-keep-or-remove.md)** | **The decision sheet.** Every candidate feature with reference, effort, revenue flag, phase |
| 05 | [Regina GTM, business model, regulatory](05-regina-gtm-business-model-regulatory.md) | How to launch, how to make money without breaking "free," and the Saskatchewan legal map |
| 06 | [Technology stack](06-technology-stack.md) | Recommended stack, AI architecture, data acquisition, build order |
| — | [research/](research/) | The five raw research reports with full sourcing |

## Executive summary

**Does Portage already exist? No — but not because nobody tried.**

No Canadian platform is simultaneously owner-direct for **both sales and rentals**, genuinely **zero-fee**, **AI-native**, and **present in Regina**. The nearest analog is **Bōde** (Calgary; $949 flat or 1% capped at $10,000; already covers Saskatchewan; a licensed brokerage). **DuProprio** proved the model can take ~20% of a province — but only in Quebec. **OpenHaus** claims "100% free" with unverified traction.

**The threat is the business model, not the competition.** Purplebricks Canada → FairSquare shut down in Feb 2023 despite Desjardins' $60.5M. Properly sold for parts. Unreserved paused after a $33.85M seed. Homie (US, $35M) was dead by 2024. They share one autopsy line: *fixed or falling revenue per listing, against cyclical volume, carrying human-service costs.*

**Three findings that should shape the plan:**

1. **Lead with rentals, not resale.** Regina has ~6,000–9,000 lease-ups/yr vs ~4,000 sales — 2× the volume and far higher frequency. Rentals are also Zillow's fastest-growing segment (+45% YoY). And the incumbents are weakest there: RentFaster charges $54.50/listing, while the free tier (Kijiji + Facebook) is where the **fraud** lives.

2. **"Verified" beats "free" in rentals.** Listing is *already* free on Kijiji and Facebook — free is not differentiating. But Saskatchewan's FCAA, the SRA, the Saskatchewan Landlord Association and BBB have all issued fake-listing warnings, and the Canadian Anti-Fraud Centre logged $638M in reported losses in 2024. **Your verified-owner ID feature is the strongest thing in the design.**

3. **Zillow structurally cannot copy your wedge.** Zillow buries owner listings under "By owner & other" because agents pay the bills. A marketplace whose *default tab is owner listings* is differentiated in a way the incumbent cannot match without destroying its own revenue.

**On monetization:** "free for everyone" is viable only if marginal cost per listing is near zero (AI self-serve, no salaried agents) and revenue comes from adjacencies — home services, mortgage/lawyer referrals, premium listing media, landlord acceleration tiers. Note that Azibo (free, unmonetized) was absorbed by TurboTenant in 2025: **free with no plan is equally fatal.**

**On the document-locker scope decision:** correct, and it avoids three regulatory landmines — rent payments would trigger FINTRAC MSB + Bank of Canada RPAA registration; holding deposits has no lawful home outside a registered brokerage's trust account; and lease/offer drafting risks both unauthorized practice of law and the "trading in real estate" line. It also sidesteps a Saskatchewan-specific trap: the RTA prohibits charging tenants to apply — which kills the #1 US rental monetizer regardless.

**Regulatory posture:** structure Portage as an *advertising medium* where the **owner** is the exempt trader (Real Estate Act s.3(1)(a)) — the model Kijiji and Facebook use and that **DuProprio successfully defended in court** (acquitted 2011, upheld 2013, and again in April 2020 when the court held it "does not act as an intermediary"). Those cases construe Quebec's statute, so a Saskatchewan legal opinion is required. Meanwhile the **Competition Bureau** is actively investigating CREA's commission rules — expressly probing whether policy makes it harder for "alternative listing services" to compete. That's you.

## Next steps

1. Work through [doc 04](04-feature-list-keep-or-remove.md) and mark keep/remove
2. Book a Saskatchewan real-estate lawyer for the one-meeting agenda in [doc 05](05-regina-gtm-business-model-regulatory.md)
3. Do direct diligence on **Bōde's actual Saskatchewan listing depth** and **OpenHaus's traction** — the two nearest competitors with unverified positions
4. Add **Regina** to the product's city list (it's absent from the current design)

---

*Research conducted 2026-08-28. Every factual claim in these documents carries a source link and as-of date in the underlying research files. Items that could not be verified are labelled UNVERIFIED. The regulatory document is research, not legal advice.*
