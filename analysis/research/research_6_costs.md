# Portage — Cost Research (Regina, SK proptech startup)

**Compiled:** 2026-08-28
**Scope:** Real, sourced 2025–2026 cost figures for building and operating "Portage," a zero-fee owner-direct real-estate marketplace. Team of 1–3 devs. Stack: Next.js/TypeScript, Postgres+PostGIS, AWS ca-central-1 or Supabase, Claude API, MapLibre. No payment rails, no rent collection.

## Method & caveats — read this first

- **Every figure below carries an inline source URL and an as-of date.** Anything I could not source is explicitly marked **UNVERIFIED**.
- **Access limitation:** this research environment blocks direct page fetches to most first-party pricing domains (`aws.amazon.com`, `supabase.com`, `vercel.com`, `jobbank.gc.ca`, `innovationsask.ca` all returned egress-proxy 403s). Figures below therefore come from **search-result extracts of those primary pages** plus secondary pricing aggregators. Primary-source URLs are cited so they can be re-verified directly. Treat aggregator-sourced numbers (Vantage, CloudPrice, pricing-comparison blogs) as **±15% accurate** and re-check the vendor page before committing to a budget.
- **Currency:** Cloud/SaaS vendors bill in **USD** unless noted. Salaries, grants, legal, insurance and media are **CAD**. Conversions use **USD/CAD 1.386** ([Trading Economics, 2026-08-27](https://tradingeconomics.com/canada/currency)). USD figures are labelled `USD`; everything else is CAD.
- Sales tax: Saskatchewan is GST 5% + PST 6% = 11%. SaaS from foreign vendors generally attracts GST; most is recoverable as input tax credits once GST-registered. Not modelled below.

---

## 1. Developer costs — Canada / Saskatchewan, 2026

### 1.1 Employed developers

| Item | Cost (CAD) | As of | Source |
|---|---|---|---|
| Software Developer, Regina–Moose Mountain — Job Bank wage range | $32.00–$57.69/hr (≈$66.5k–$120k FT) | 2025-11-19 | [Job Bank 22548/geo29307](https://www.jobbank.gc.ca/marketreport/wages-occupation/22548/geo29307) |
| Software Development Programmer, Saskatchewan — Job Bank range | $28.85–$68.68/hr (≈$60k–$143k FT) | 2025-11-19 | [Job Bank 22531/SK](https://www.jobbank.gc.ca/marketreport/wages-occupation/22531/SK) |
| Senior Software Developer, Saskatchewan — Job Bank range | $28.85–$68.68/hr | 2025-11-19 | [Job Bank 227158/SK](https://www.jobbank.gc.ca/marketreport/wages-occupation/227158/SK) |
| Senior Software Developer, Saskatoon–Biggar | $26.44–$68.68/hr | 2025-11-19 | [Job Bank 227158/geo29309](https://www.jobbank.gc.ca/marketreport/wages-occupation/227158/geo29309) |
| Software Developer, Canada-wide — Job Bank range | $30.00–$76.92/hr | 2025-11-19 | [Job Bank 22548/ca](https://www.jobbank.gc.ca/marketreport/wages-occupation/22548/ca) |
| Software Engineer, Regina — Glassdoor average | $78,540/yr (P25 $58,318 / P75 $105,772) | 2026 | [Glassdoor Regina](https://www.glassdoor.ca/Salaries/regina-software-engineer-salary-SRCH_IL.0,6_IM985_KO7,24.htm) |
| Software Engineer, Regina — Indeed average | $116,197/yr | 2026 | [Indeed Regina](https://ca.indeed.com/career/software-engineer/salaries/Regina--SK) |
| Software Developer, Regina — PayScale average | $67,643/yr (range $56k–$79k) | 2026 | [PayScale Regina](https://www.payscale.com/research/CA/Job=Software_Developer/Salary/6bc312af/Regina-SK) |
| Full-stack developer, Canada — Talent.com average | $90,909/yr ($46.62/hr) | 2026 | [Talent.com](https://ca.talent.com/salary?job=full+stack+developer) |
| Full-stack developer, Saskatchewan — Indeed average | $80,036/yr | 2026 | [Indeed SK](https://ca.indeed.com/career/full-stack-developer/salaries/Saskatchewan) |

**Reading the spread.** Regina figures disagree by nearly 2× depending on source — Glassdoor says $78.5k, Indeed says $116k, PayScale says $67.6k. Job Bank (Statistics Canada wage survey, the most methodologically defensible) puts the Regina band at $66.5k–$120k FT-equivalent. **Plan on $85k–$105k base for a competent mid/senior full-stack hire in Regina, and $115k–$135k if you need a genuine senior who could otherwise work remote-for-Toronto.** Job Bank also flags the SK employment outlook for this occupation as **"Limited" for 2025–2027** ([Job Bank outlook](https://www.jobbank.gc.ca/marketreport/outlook-occupation/227158/SK)), which cuts both ways: less competition for hires locally, but also a thin local talent pool.

### 1.2 Employer burden on top of salary

| Item | Cost | As of | Source |
|---|---|---|---|
| CPP employer match | 5.95% to $4,230.45 max | 2026 | [RN Canada CPP/EI guide](https://rncanada.ca/resources/cpp-cpp2-ei-explained) |
| CPP2 employer match | 4% on $74,600–$85,000 band; $416.00 max | 2026 | [Workzoom 2026 maximums](https://www.workzoom.com/blog/canadian-payroll-deductions-guide/) |
| EI employer premium | 1.4× employee rate (2.212%); $1,572.30 max | 2026 | [MaxRefund CPP/EI employer](https://www.maxrefund.ca/blog/cpp-ei-employer-canada) |
| **Total statutory employer cost, max earnings** | **$6,218.75/employee/yr** | 2026 | (sum of above) |

Saskatchewan has **no employer health tax** (unlike ON/BC/MB), so statutory burden is ~6–7% of salary — cheap by Canadian standards. Budget **salary × 1.12–1.18** fully loaded (statutory + basic benefits + equipment).

### 1.3 Contract, freelance, and offshore

| Item | Rate | As of | Source |
|---|---|---|---|
| Canadian freelance web/full-stack — junior | $40–$65/hr CAD | 2026 | [Freel.ca rates](https://freel.ca/rates/web-developer-freelance-rates-canada) |
| Canadian freelance — mid-level | $65–$110/hr CAD | 2026 | [Freel.ca](https://freel.ca/rates/web-developer-freelance-rates-canada) |
| Canadian freelance — senior | $110–$175/hr CAD | 2026 | [Freel.ca](https://freel.ca/rates/web-developer-freelance-rates-canada) |
| Canadian freelance median (all professions) | ~$63/hr CAD; ~$712/day typical | 2026 | [FreelanceDesk Canadian rates 2026](https://freelancedesk.online/blog/canadian-freelance-rates-2026) |
| Offshore — India / South Asia | $15–$30/hr USD ($21–$42 CAD) | 2026 | [The Scalers](https://thescalers.com/offshore-software-development-rates-by-country/) |
| Offshore — Asia-Pacific regional average | $28/hr USD ($39 CAD) | 2026 | [Qubit Labs](https://qubit-labs.com/average-hourly-rates-offshore-development-services-software-development-costs-guide/) |
| Nearshore — Eastern Europe (PL/UA/RO) | $35–$70/hr USD ($49–$97 CAD); avg $37 | 2026 | [Qubit Labs](https://qubit-labs.com/average-hourly-rates-offshore-development-services-software-development-costs-guide/), [Cleveroad](https://www.cleveroad.com/blog/offshore-software-development-rates/) |
| Nearshore — LatAm (BR/CO/AR) | $25–$55/hr USD ($35–$76 CAD); avg $50 | 2026 | [Uvik](https://uvik.net/blog/offshore-software-development-rates-by-country/) |
| AI/ML specialist premium | +15–30% on base rate | 2026 | [Aalpha](https://www.aalpha.net/articles/offshore-software-development-hourly-rates/) |

**Critical adjustment:** multiple 2026 offshore-rate guides converge on a **loaded cost of 1.4×–1.8× the quoted rate** once you add management overhead, onboarding and attrition ([Qubit Labs](https://qubit-labs.com/average-hourly-rates-offshore-development-services-software-development-costs-guide/)). A $25/hr USD India rate is realistically $35–$45/hr USD ($49–$62 CAD) delivered — still roughly half a Canadian senior freelancer, but not the 4× saving the headline implies. For a product with Canadian regulatory surface (identity verification, PIPEDA, real-estate advertising rules), the coordination tax is higher than average.

### 1.4 Technical co-founder vs. hiring

| Arrangement | Equity | Cash | As of | Source |
|---|---|---|---|---|
| Technical co-founder, pre-product, equal partner | 40–50% | Below-market or nil | 2026 | [UX Continuum](https://uxcontinuum.com/blog/startup-cto/technical-cofounder-equity) |
| Founding CTO (typical co-founder band) | 20–40% | Below-market | 2026 | [UX Continuum](https://uxcontinuum.com/blog/startup-cto/technical-cofounder-equity) |
| Technical co-founder joining post-working-MVP | 15–30% | Below-market | 2026 | [UX Continuum](https://uxcontinuum.com/blog/startup-cto/technical-cofounder-equity) |
| Hired CTO at Series A | 2–5% | Market salary | 2026 | [UX Continuum](https://uxcontinuum.com/blog/startup-cto/startup-cto-equity-what-is-fair-2026) |
| Fractional CTO | 1–5% + monthly fee | $150–$500/hr USD; $200–$350 typical | 2026 | [Founding Developers](https://www.foundingdevelopers.com/blog/technical-cofounder-as-a-service) |

The stark arbitrage: **20% equity granted to a technical co-founder is worth ~$2M at a $10M Series A valuation, versus $10k–$20k USD to contract out an MVP** ([Founding Developers, 2026](https://www.foundingdevelopers.com/blog/technical-cofounder-as-a-service)). That comparison is unfair in one direction (a contractor won't maintain, iterate or care) and instructive in the other: **do not give away founder-scale equity for MVP-scale work.** For Portage specifically, the AI features (chat search, listing builder, AVM) are genuinely hard and ongoing — that argues for a real technical co-founder at 20–35%, with a vesting cliff, not a contractor.

---

## 2. Funding and support programs a Saskatchewan startup can access

### 2.1 SR&ED — federal (the single biggest lever)

Bill C-15 delivered the largest SR&ED expansion in decades. It **received Royal Assent 2026-03-26** and applies to tax years **beginning after 2024-12-15** ([BDO Canada](https://www.bdo.ca/insights/sr-ed-program-enhancements-and-updates-draft-legislation-released); [Welch LLP](https://welchllp.com/insights/knowledge/2026-changes-in-sred-largest-expansion-in-decades/)).

| Parameter | Value | As of | Source |
|---|---|---|---|
| Enhanced refundable rate, CCPC | **35%** on qualifying expenditures | 2026 | [Boast.ai SR&ED guide 2026](https://www.boast.ai/en-ca/resources/guides/the-complete-guide-to-sred-tax-credits-2026) |
| Enhanced expenditure limit | **$6M** (raised from $3M) | Bill C-15, RA 2026-03-26 | [BDO](https://www.bdo.ca/insights/sr-ed-program-enhancements-and-updates-draft-legislation-released) |
| Max annual refundable credit | **$2.1M** (was $1.05M) | 2026 | [Doane Grant Thornton](https://www.doanegrantthornton.ca/insights/proposed-sred-changes-could-boost-canadian-research-and-development/) |
| Basic rate above the limit | 15%, partially refundable | 2026 | [Clearwealth](https://clearwealth.tax/blog/sred-expenditure-limit-2026-ccpc/) |
| Taxable-capital phase-out range | **$15M–$75M** (was $10M–$50M) | 2026 | [Doane Grant Thornton](https://www.doanegrantthornton.ca/insights/proposed-sred-changes-could-boost-canadian-research-and-development/) |
| Capital expenditures | Eligible again (equipment ≥90% SR&ED use) | 2026 | [Welch LLP](https://welchllp.com/insights/knowledge/2026-changes-in-sred-largest-expansion-in-decades/) |

**What this means for Portage.** A 2-dev CCPC spending ~$180k of eligible salary on genuinely novel work (AVM modelling, AI listing/search R&D, PostGIS scoring) is nowhere near the $6M limit — you get the full 35% refundable rate. Realistic refundable credit: **$40k–$70k/yr**, received as cash even at zero revenue. Caveat: **routine CRUD/Next.js app-building is not SR&ED.** Only the parts with genuine technological uncertainty qualify, and you must contemporaneously document the hypotheses and failed experiments.

### 2.2 SR&ED — Saskatchewan provincial (stacks on federal)

| Parameter | Value | As of | Source |
|---|---|---|---|
| SK R&D tax credit rate | **10%** (was 15% pre-2015-04-01) | 2026 | [CRA — SK R&D tax credit](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/provincial-territorial-corporation-tax/saskatchewan-provincial-corporation-tax/saskatchewan-research-development-tax-credit.html) |
| Refundable portion — CCPC annual limit | **$2M** of qualifying expenditures (raised from $1M) | Effective 2024-12-16 | [PwC — SK Budget 2026](https://www.pwc.com/ca/en/services/tax/budgets/2026/saskatchewan.html) |
| Above the limit / non-CCPCs | 10% non-refundable | 2026 | [CRA](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/corporations/provincial-territorial-corporation-tax/saskatchewan-provincial-corporation-tax/saskatchewan-research-development-tax-credit.html) |
| Total annual cap per corporation | $1M in credits | 2026 | [Doane Grant Thornton — SK Budget 2026](https://www.doanegrantthornton.ca/insights/budgets/saskatchewan-budget-2026/) |
| Capital expenditures | Now eligible | 2026 | [PwC](https://www.pwc.com/ca/en/services/tax/budgets/2026/saskatchewan.html) |

Stacked federal + provincial on ~$180k of eligible SK salary: roughly **35% + 10% ≈ 45%** gross, before the provincial credit's grind against the federal base. Realistic combined recovery: **~$50k–$80k/yr.**

### 2.3 NRC IRAP

| Parameter | Value | As of | Source |
|---|---|---|---|
| Typical first-time award | **$75k–$200k** | 2026 | [GrantOps IRAP guide](https://grantops.ai/en/blog/irap-funding-guide-2026/) |
| Realistic first award band | $100k–$200k | 2026 | [GrantOps](https://grantops.ai/en/irap/) |
| Program range | $75k to $1M+ | 2026 | [GrantHub](https://granthub.ca/learn/how-much-funding-can-businesses-get-from-nrc-irap) |
| Cost-share | **80% of internal salary; 50% of subcontractor** cost | 2026 | [Sagentix](https://www.sagentix.ca/blog/irap-funding-guide-canadian-smes) |
| Absolute maximum | $10M (Large Value Contribution; <10 awards/yr >$1M) | 2024-25 | [GrantOps](https://grantops.ai/en/blog/irap-funding-guide-2026/) |
| Total program disbursement | >$550M to SMEs | FY2025-26 | [GrantCompass](https://grantcompass.ca/irap-funding-canada.html) |

Non-repayable, but gated by an Industrial Technology Advisor relationship — you cannot simply apply cold. **Budget 3–6 months of ITA courtship before first dollar.** IRAP funds salary, so it stacks awkwardly with SR&ED (IRAP-funded salary is government assistance that reduces the SR&ED base). Model them as alternatives on the same dollar, not additive.

### 2.4 Saskatchewan Technology Startup Incentive (STSI) — **the SK-specific headline**

| Parameter | Value | As of | Source |
|---|---|---|---|
| Investor tax credit | **45% non-refundable** | 2026 | [Innovation Saskatchewan](https://innovationsask.ca/programs/stsi/) |
| Program annual cap | **$7M** (doubled from $3.5M), first-come first-served | 2026 | [BetaKit](https://betakit.com/saskatchewan-government-doubles-cap-of-startup-investor-tax-credit-to-7-million/) |
| Max credit per investor per investment | $225,000 | 2026 | [Innovation Saskatchewan](https://innovationsask.ca/programs/stsi/) |
| Max claimable per investor per tax year | $140,000 | 2026 | [Innovation Saskatchewan](https://innovationsask.ca/programs/stsi/) |
| Max an Eligible Startup Business can raise under STSI | **$2,000,000** | 2026 | [GrantCompass](https://grantcompass.ca/grants/saskatchewan-technology-startup-incentive) |
| Eligibility | <50 employees, **≥50% SK-based**, HQ in SK, **≤$5M equity raised previously** | 2026 | [Innovation Saskatchewan](https://innovationsask.ca/programs/stsi/) |
| Sector scope | Digital + clean tech; **life sciences added 2026-04-21** | 2026-04-21 | [Gov. of Saskatchewan](https://www.saskatchewan.ca/government/news-and-media/2026/april/21/innovation-saskatchewan-expands-stsi-program-to-accelerate-life-sciences-innovation) |

**Portage is a textbook STSI fit** — digital tech, SK head office, sub-$5M raised. A 45% credit materially de-risks a Regina/Saskatoon angel cheque: an investor writing $100k effectively pays $55k. Register as an Eligible Startup Business *before* soliciting local angels.

### 2.5 Other programs

| Program | Value | Status / As of | Source |
|---|---|---|---|
| **Co.Labs** (SK tech incubator, Saskatoon) | **No fees, no equity** taken from portfolio startups | Active 2026 | [Co.Labs FAQ](https://www.co-labs.ca/faq) |
| Co.Labs **Co.Launch** program | 6-week cohort (Feb–Apr, Oct–Nov); **up to $20,000** non-repayable prize to top performer | 2026 | [GrantHub](https://granthub.ca/learn/how-to-apply-for-colabs-colaunch-saskatchewan-eligibility-deadlines-and-pitch-deck-tips) |
| Co.Labs funding base | Federally + provincially funded via PrairiesCan and Innovation Saskatchewan | 2026-04 | [Canada.ca / PrairiesCan](https://www.canada.ca/en/prairies-economic-development/news/2026/04/government-of-canada-investing-in-innovation-ecosystems-and-ai-to-strengthen-saskatchewans-tech-sector.html) |
| **Futurpreneur** loan (ages 18–39, first 24 months of business) | **Up to $75,000** total, collateral-free + mentorship | 2026 | [Futurpreneur press release](https://futurpreneur.ca/en/press_release/a-boost-for-new-business-futurpreneur-raises-loan-amounts-for-young-entrepreneurs-up-to-75000/) |
| — structure | $25k Futurpreneur @ CIBC prime + 3%; $50k BDC @ BDC floating base + 1.65% | 2026 | [Newswire](https://www.newswire.ca/news-releases/a-boost-for-new-business-futurpreneur-raises-loan-amounts-for-young-entrepreneurs-up-to-75-000-875004822.html) |
| **Innovation Challenge 2026** (SK) | Up to **$30,000** per startup | 2026 | [Funds for Companies](https://fundsforcompanies.fundsforngos.org/grant/call-for-applications-innovation-challenge-2026-canada/) |
| **MIST** (Made In Saskatchewan Technology) pilot program | >$100,000 combined across 4 companies (2026 cohort) — i.e. ~$25k each | 2026-07-28 | [Gov. of Saskatchewan](https://www.saskatchewan.ca/government/news-and-media/2026/july/28/nnovation-saskatchewan-supports-sk-startups-to-pilot-homegrown-technologies) |
| **CDAP (Canada Digital Adoption Program)** | **WOUND DOWN.** Boost Your Business Technology closed to new applicants **2024-02-19**; Grow Your Business Online closed **2024-09-30**; program wound down through 2025 | 2026 | [MNP](https://www.mnp.ca/en/insights/directory/whats-next-for-businesses-now-that-cdap-has-ended), [Attainment Labs](https://www.attainmentlabs.com/blog/canada-digital-adoption-program-cdap-ended-what-replaced-it) |
| CDAP successor for AI adoption | BDC **LIFT** program | 2026 | [Attainment Labs](https://www.attainmentlabs.com/blog/canada-digital-adoption-program-cdap-ended-what-replaced-it) |

**Do not budget for CDAP — it is gone.** The $1.4B envelope was cut to $780M in Budget 2023 and the streams closed in 2024.

---

## 3. Cloud hosting, 2026

### 3.1 AWS ca-central-1

| Item | Price (USD) | Region | As of | Source |
|---|---|---|---|---|
| EC2 `t4g.small` on-demand | **$0.017/hr** ≈ $12.41/mo | ca-central-1 | 2026 | [Holori ca-central-1 calculator](https://calculator.holori.com/aws/ec2/t4g.small/ca-central-1?os=Linux&upfront=no-upfront) |
| RDS PostgreSQL `db.t4g.micro` | ~$0.016–$0.03/hr; **~$21.90/mo** | us-east-1 baseline | 2026 | [Economize](https://www.economize.cloud/resources/aws/pricing/rds/db.t4g.micro/) |
| RDS PostgreSQL `db.t4g.small` | ~$0.032/hr ≈ $23/mo | us-east-1 baseline | 2026 | [Vantage](https://instances.vantage.sh/aws/rds/db.t4g.small) |
| Fargate | **$0.04048/vCPU-hr + $0.004445/GB-hr** | US baseline | 2026 | [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/), [Cloudchipr](https://cloudchipr.com/blog/aws-fargate-pricing) |
| S3 Standard storage | $0.023/GB-mo | us-east-1 baseline | 2026 | [AWS S3 pricing](https://aws.amazon.com/s3/pricing/) |
| Data transfer out to internet | **$0.09/GB** first 10 TB; $0.085 @10–50TB | most regions | 2026 | [EgressCost](https://egresscost.com/aws/data-transfer-pricing/) |
| Free egress allowance | First **100 GB/mo** free, aggregated across services | 2026 | [CloudZero](https://www.cloudzero.com/blog/reduce-data-transfer-costs/) |

⚠️ **UNVERIFIED (regional):** ca-central-1 RDS, Fargate and S3 rates could not be confirmed against the AWS pricing pages (blocked). ca-central-1 historically runs **~5–10% above us-east-1**. Apply that uplift and re-verify at [calculator.aws](https://calculator.aws) before committing.

### 3.2 Vercel

| Tier | Price (USD) | Included | As of | Source |
|---|---|---|---|---|
| Hobby | $0 | 100 GB Fast Data Transfer/mo. **Commercial use prohibited** | 2026 | [Vercel Hobby plan docs](https://vercel.com/docs/plans/hobby) |
| Pro | **$20/deploying seat/mo**, incl. $20 usage credit per seat | 1 TB bandwidth | 2026 | [Flexprice](https://flexprice.io/blog/vercel-pricing-breakdown) |
| Bandwidth overage | $0.15/GB | — | 2026 | [Flexprice](https://flexprice.io/blog/vercel-pricing-breakdown) |
| Fast Origin Transfer | $0.06/GB, billed from first byte | — | 2026 | [UsagePricing](https://www.usagepricing.com/blueprint/vercel) |
| Fluid Compute — active CPU | $0.128–$0.221/hr by region | — | 2026 | [Flexprice](https://flexprice.io/blog/vercel-pricing-breakdown) |
| Fluid Compute — provisioned memory | $0.0106/GB-hr after credit | — | 2026 | [Flexprice](https://flexprice.io/blog/vercel-pricing-breakdown) |

**Hard constraint:** Vercel defines commercial usage broadly enough that *"a paid employee or consultant writing the code"* triggers it ([Vercel Fair Use Guidelines](https://vercel.com/docs/limits/fair-use-guidelines)). Portage cannot legitimately run on Hobby. **Budget Pro from day one: $20–$60 USD/mo for 1–3 seats.**

### 3.3 Supabase

| Tier | Price (USD) | Notes | As of | Source |
|---|---|---|---|---|
| Free | $0 | Projects pause on inactivity | 2026 | [Supabase pricing](https://supabase.com/pricing) |
| Pro | **$25/mo/org** + $10 compute credit per project (covers one Micro instance) | 2026 | [Jetadmin](https://www.jetadmin.io/blog/supabase-pricing-2026-guide-to-plans-limits-and-real-world-costs/) |
| Team | **$599/mo** — adds SOC2/ISO 27001, 14-day PITR, priority support | 2026 | [MetaCTO](https://www.metacto.com/blogs/the-true-cost-of-supabase-a-comprehensive-guide-to-pricing-integration-and-maintenance) |
| Compute add-ons | Small $15/mo (+$5 net), Medium $60 (+$50), Large $110 (+$100) | 2026 | [Flexprice](https://flexprice.io/blog/supabase-pricing-breakdown) |
| Dominant cost drivers at scale | Compute, egress, MAU overages | 2026 | [Flexprice](https://flexprice.io/blog/supabase-pricing-breakdown) |

**Canadian region: YES.** Supabase supports **`ca-central-1` (Canada Central)**, and each project is bound to its region at the infrastructure level — real data residency, not a marketing claim ([Supabase — Available regions](https://supabase.com/docs/guides/platform/regions)). This matters for Portage's ID-verification and document-locker features under PIPEDA. Supabase also ships PostGIS, so the geo requirement is satisfied natively.

### 3.4 Cheaper PaaS alternatives

| Platform | Price (USD) | As of | Source |
|---|---|---|---|
| Railway | Hobby **$5/mo**, Pro **$20/mo**, usage billed on top | 2026 | [Techsy comparison](https://techsy.io/en/blog/railway-vs-render-vs-fly-io) |
| Railway — typical small stack (web + DB + worker) | **$10–$15/mo** | 2026 | [HOSTIM.DEV](https://hostim.dev/blog/render-vs-railway-vs-fly-pricing/) |
| Render — web service | Starter $7, Standard $25, Pro $85–$450 | 2026 | [HOSTIM.DEV](https://hostim.dev/blog/render-vs-railway-vs-fly-pricing/) |
| Render — managed Postgres | Basic compute from ~$6/mo + **$0.30/GB-mo storage** | 2026 | [HOSTIM.DEV](https://hostim.dev/blog/render-vs-railway-vs-fly-pricing/) |
| Render — same small stack | $21–$34/mo | 2026 | [HOSTIM.DEV](https://hostim.dev/blog/render-vs-railway-vs-fly-pricing/) |
| Fly.io | Per-VM-second, no base fee; **old $5 free allowance removed** for new accounts (2 VM-hr or 7-day trial) | 2026 | [Techsy](https://techsy.io/en/blog/railway-vs-render-vs-fly-io) |

### 3.5 Claude API (AI chat search, listing builder)

| Model | Input $/MTok | Output $/MTok | As of | Source |
|---|---|---|---|---|
| Claude Opus 5 | $5.00 | $25.00 | 2026-06-24 | Anthropic pricing (cached in `claude-api` skill); live: [anthropic.com/pricing](https://www.anthropic.com/pricing) |
| Claude Sonnet 5 | $2.00 | $10.00 | 2026-06-24 | as above |
| Claude Haiku 4.5 | $1.00 | $5.00 | 2026-06-24 | as above |

**ESTIMATE (calculated from published rates, not measured):** an AI chat-search turn at ~3k input + 400 output tokens costs **~$0.010 USD on Sonnet 5**, ~$0.005 on Haiku 4.5. An AI listing-builder run (~6k in / 1.5k out) is **~$0.027 USD on Sonnet 5**. At 20,000 searches + 500 listings/month: **~$215 USD/mo on Sonnet 5**, or **~$110** on Haiku 4.5. Prompt caching on the system prompt and listing corpus cuts the input side materially. Batch API halves cost for non-interactive work (AVM recomputation, neighbourhood scoring).

### 3.6 Realistic monthly hosting totals

| Stage | Low (USD/mo) | Likely (USD/mo) | Notes |
|---|---|---|---|
| Pre-launch / <1,000 users | $30 | **$75–$120** | Supabase Pro $25 + Vercel Pro $20–40 + Sentry free/$26 + minimal AI |
| ~10,000 users | $250 | **$450–$700** | Supabase Pro + Medium compute (~$85), Vercel Pro w/ overage ($60–150), AI $110–215, email/SMS $30–60, maps $25, monitoring $30–80 |

At 10k users the **AI inference line is the largest single item** — bigger than compute and database combined. Model selection (Haiku vs. Sonnet), caching and per-user rate limits are the levers that matter most.

---

## 4. Vendor / SaaS costs

### 4.1 Identity verification (verified-owner checks)

| Vendor | Per-verification (USD) | Minimum / platform fee | As of | Source |
|---|---|---|---|---|
| **Stripe Identity** | **~$1.50** | **No minimum** | 2026 | [Index.dev comparison](https://www.index.dev/skill-vs-skill/authentication-stripe-identity-vs-onfido-vs-persona) |
| Persona | $2.00–$5.00 (config-dependent) | ~$500/mo | 2026 | [Trust Swiftly](https://trustswiftly.com/blog/identity-verification-pricing-comparison-and-alternatives/) |
| Onfido | ~$2.25 | **From $15,000/yr** annual subscription | 2026 | [Index.dev](https://www.index.dev/skill-vs-skill/authentication-stripe-identity-vs-onfido-vs-persona) |
| Jumio / Onfido enterprise | — | Tens of thousands per year | 2026 | [Trust Swiftly](https://trustswiftly.com/blog/identity-verification-pricing-comparison-and-alternatives/) |
| Trulioo | **UNVERIFIED** — enterprise, quote-only | — | — | — |

⚠️ Onfido bills for **every completed attempt regardless of outcome** — including fake IDs and repeated fraudster failures ([Trust Swiftly, 2026](https://trustswiftly.com/blog/identity-verification-pricing-comparison-and-alternatives/)). For an owner-verification flow that fraudsters will probe, that is a real cost risk. **Stripe Identity at ~$1.50 with no minimum is the correct pre-PMF choice.** At 500 owner verifications/month: ~$750 USD/mo.

### 4.2 Tenant / background screening

| Vendor | Price (CAD) | As of | Source |
|---|---|---|---|
| **SingleKey** tenant report | **$44.99 + tax** | 2026 | [SingleKey KB](https://www.singlekey.com/en/knowledge-base/%25f0%259f%2592%25bc-singlekey-pricing-breakdown-know-what-youre-paying-for/) |
| SingleKey via Mi Property Portal | ~$42.99 (−$2) | 2026 | [Mi Property Portal](https://www.mipropertyportal.com/tenant-screening/) |
| **Certn** background checks | From **$10–$18**; basic criminal record check ~$17.99 | 2026 | [Certn pricing](https://certn.co/pricing/) |
| Canadian market range | $20–$50/report | 2026 | [Rentals Dream PM](https://rentalsdreampm.com/2025/05/29/what-is-a-tenant-screening-report/) |

Pass-through to the landlord/owner rather than absorbing it — this is a per-transaction cost, not a platform cost.

### 4.3 Email

| Vendor | Price (USD) | As of | Source |
|---|---|---|---|
| **AWS SES** | **$0.10 per 1,000 emails**, no monthly minimum | 2026 | [SMTPedia](https://smtpedia.com/amazon-aws-ses-pricing/) |
| Resend | From **$20/mo** | 2026 | [BuildMVPFast](https://www.buildmvpfast.com/blog/resend-vs-ses-vs-postmark-transactional-email-deliverability-saas-2026) |
| Postmark | From **$50/mo** base; ~$105 at 100k emails/mo | 2026 | [BuildMVPFast](https://www.buildmvpfast.com/blog/resend-vs-ses-vs-postmark-transactional-email-deliverability-saas-2026) |
| At 100k emails/mo | SES ~$10 vs Postmark ~$105 vs SendGrid ~$90 | 2026 | [BuildMVPFast](https://www.buildmvpfast.com/blog/resend-vs-ses-vs-postmark-transactional-email-deliverability-saas-2026) |

SES is ~10× cheaper but requires warming, DKIM/SPF/DMARC setup and your own bounce handling. For a marketplace whose core loop is *owner ⇄ buyer messaging notifications*, deliverability is product-critical — **Resend at $20/mo is the right early trade**, migrating to SES once volume justifies the ops work.

### 4.4 SMS

| Item | Price (USD) | As of | Source |
|---|---|---|---|
| Twilio outbound SMS to Canada | **$0.0079/message** | 2026 | [Twilio Canada SMS pricing](https://www.twilio.com/en-us/sms/pricing/ca) |
| Failed-message processing fee | $0.001/message | 2026 | [Twilio](https://www.twilio.com/en-us/sms/pricing/ca) |
| Canadian phone number monthly rental | **UNVERIFIED** — page not fetchable; typically ~$1–$2/mo/number | — | [Twilio pricing](https://www.twilio.com/en-us/pricing) |

Note: A2P messaging to Canadian numbers requires carrier registration; Canadian short-code and campaign fees are **UNVERIFIED** here and can add meaningfully. Budget SMS only for viewing-booking confirmations and 2FA — at 10k SMS/mo that is just **$79 USD**, so it is not a cost problem, it is a compliance/registration problem.

### 4.5 Maps

| Option | Free tier | Overage | As of | Source |
|---|---|---|---|---|
| **Mapbox** | 50,000 web map loads/mo; 100,000 geocoding lookups/mo | **$5/1,000** map loads; **$0.75/1,000** geocoding; $2.00/1K for geocode requests 100,001–500,000 | 2026 | [Woosmap Mapbox pricing](https://www.woosmap.com/blog/mapbox-pricing), [APICostCalc](https://apicostcalc.com/mapbox.html) |
| **MapTiler** Free | 100,000 requests/mo, 5,000 sessions/mo, 100 MB hosting — **non-commercial only**; service pauses at cap | 2026 | [MapTiler pricing](https://www.maptiler.com/cloud/pricing/) |
| MapTiler **Flex** | **$25/mo**, 500,000 requests, automatic overage billing | 2026 | [MapTiler pricing](https://www.maptiler.com/cloud/pricing/) |
| MapTiler **Unlimited** | $295/mo, 5M requests, 99.9% SLA | 2026 | [MapTiler pricing](https://www.maptiler.com/cloud/pricing/) |
| MapLibre GL JS (library) | **$0** — BSD-licensed, no vendor fee | 2026 | (open source) |

**Mapbox's $5/1,000 map-load overage is brutal for a listings marketplace** where every search result page is a map load. 50k free loads is roughly 1,600 sessions/day. **MapTiler Flex at $25/mo for 500k requests is ~10× better value** and pairs natively with MapLibre. Self-hosting tiles is a third option: OpenMapTiles/Protomaps on S3+CloudFront turns a per-request cost into a flat storage+egress cost — worth doing once map loads exceed ~1M/mo. **UNVERIFIED:** self-hosted tile cost depends entirely on extract size and cache hit rate; a Saskatchewan-only extract would be small (single-digit GB).

### 4.6 Monitoring & analytics

| Tool | Price (USD) | As of | Source |
|---|---|---|---|
| **Sentry** Developer (free) | $0 — 5,000 errors/mo, 1 user | 2026 | [ToolPick](https://www.toolpick.dev/pricing/sentry) |
| Sentry Team | **From $26/mo** (50k errors) | 2026 | [Middleware.io](https://middleware.io/blog/sentry-pricing/) |
| Sentry Business | $80/mo (50k errors + advanced) | 2026 | [Middleware.io](https://middleware.io/blog/sentry-pricing/) |
| **PostHog** | Free tier, then usage-based on events/recordings/API | 2026 | [Schematic](https://schematichq.com/blog/posthog-pricing) |
| **Plausible** | **No free tier**; Starter **$9/mo** (10k pageviews), Growth $14, Business $19; 30-day trial; self-host Community Edition $0 | 2026-06 | [Seline](https://seline.com/blog/plausible-analytics-pricing), [theStacc](https://thestacc.com/reviews/plausible/) |

PostHog's free tier is generous enough to carry Portage through validation; its session replay is genuinely useful for debugging an unfamiliar listing-creation flow. Plausible is cheaper and simpler if you only need pageviews.

---

## 5. Real-estate media (the premium media SKU)

| Item | Price (CAD) | As of | Source |
|---|---|---|---|
| Interior/exterior HDR photography, 25–35 images | **$175–$300** | 2026 | [Big Picture 360 GTA guide](https://bigpicture360.ca/photography-experts/real-estate-photography/real-estate-photography-cost-toronto-gta/) |
| Premium HDR package (residential + commercial) | ~$529 | 2026 | [Big Picture 360](https://bigpicture360.ca/photography-experts/real-estate-photography/real-estate-photography-cost-toronto-gta/) |
| Matterport 3D tour — up to 1,000 sq ft | **$139** | 2026 | [Lightbound3D Toronto](https://lightbound3d.com/blog/matterport-virtual-tour-pricing-toronto) |
| Matterport 3D tour — general | **$250–$550** by square footage; starts at $249 | 2026 | [Lightbound3D](https://lightbound3d.com/blog/matterport-virtual-tour-pricing-toronto) |
| Matterport 3D tour + schematic floor plan | $349 | 2026 | [Lightbound3D](https://lightbound3d.com/blog/matterport-virtual-tour-pricing-toronto) |
| Drone photography package (up to 15 images) | $629 | 2026 | [Big Picture 360](https://bigpicture360.ca/photography-experts/real-estate-photography/real-estate-photography-cost-toronto-gta/) |
| **Full media bundle** (photos + video + drone + floor plan + 3D tour) | **$400–$900** | 2026 | [Big Picture 360](https://bigpicture360.ca/photography-experts/real-estate-photography/real-estate-photography-cost-toronto-gta/) |

⚠️ These are **Toronto/GTA and Montreal** market rates. **Regina should run 15–30% below GTA** on local photographer labour, but that discount is **UNVERIFIED** — no Regina-specific price list was found. Treat GTA figures as a ceiling.

### Virtual staging (AI)

| Tool | Price (USD) | As of | Source |
|---|---|---|---|
| **REimagine Home** | Free 5 designs; Essential **$14**, Pro $49, Advanced $74, Agency $99/mo (credit-based) | 2026 | [HousingWire](https://www.housingwire.com/articles/virtual-staging-companies-apps/) |
| StageHQ pay-as-you-go | $19 / 20 images, down to **$0.28/image** at volume | 2026 | [StageHQ cost guide](https://stagehq.ai/guides/virtual-staging-cost) |
| Collov AI | From ~$16/mo, effective **$0.23/image** at full quota | 2026 | [StageHQ](https://stagehq.ai/guides/virtual-staging-cost) |
| Market span, all approaches | **<$0.30/image (AI) to $100+/image (human-edited)** | 2026 | [StageHQ](https://stagehq.ai/guides/virtual-staging-cost) |

**Margin implication:** a $400–$900 media bundle costed at $150–$300 of photographer time plus <$5 of AI staging is a genuinely profitable SKU — likely Portage's best near-term revenue line given no payment rails and no listing fees.

---

## 6. Marketing costs

| Metric | Value | Market | As of | Source |
|---|---|---|---|---|
| Google Ads CPC — residential real estate | **$3–$12** | Canada | 2026 | [Little Dragon Media](https://littledragon.ca/google-ads-pricing-costs-breakdown-what-to-expect/) |
| Google Ads CPC — commercial real estate | $15–$40 | Canada | 2026 | [Little Dragon Media](https://littledragon.ca/google-ads-pricing-costs-breakdown-what-to-expect/) |
| Google Ads CPC — real estate (alternative estimate) | $2–$5 | Canada | 2026 | [Digilite](https://digilite.ca/blog/how-much-does-google-ads-ppc-cost-in-canada/) |
| Google CPL — **seller** leads | **$15–$20** | US/Canada | 2026 | [Softtrix](https://www.softtrix.com/qna/real-estate/what-is-the-cost-per-lead-for-real-estate-google-ads) |
| Google CPL — **buyer** leads | $200–$250 (CPC $20–25 @ 10–15% CVR) | US/Canada | 2026 | [Expert PPC Services](https://expertppcservices.com/google-ads-for-real-estate-2026-benchmarks-strategies/) |
| Google CPL — competitive range | $90–$170 | US/Canada | 2026 | [Expert PPC Services](https://expertppcservices.com/google-ads-for-real-estate-2026-benchmarks-strategies/) |
| Meta CPL — residential real estate | **$18–$35** | — | 2026 | [AdLibrary](https://adlibrary.com/posts/meta-ad-benchmarks-real-estate-2026) |
| Meta CPL — real estate average | **$51.90**; Tier-1 markets $35–$65 | — | 2026 | [AdLibrary](https://adlibrary.com/posts/meta-ad-benchmarks-real-estate-2026) |
| Meta CPM | $14–$22 | US markets | 2026 | [AdLibrary](https://adlibrary.com/posts/meta-ad-benchmarks-real-estate-2026) |
| Meta link CTR | 0.8–1.4% | — | 2026 | [AdLibrary](https://adlibrary.com/posts/meta-ad-benchmarks-real-estate-2026) |
| Real estate conversion rate (lowest of all industries) | **2.15%** | — | 2026 | [Foundry CRO](https://foundrycro.com/blog/facebook-ads-benchmarks-by-industry-2026/) |
| Real estate CPC YoY change | **+40%** | — | 2026 | [Get-Ryze](https://www.get-ryze.ai/blog/meta-ads-cost-benchmarks-by-industry-2026) |
| Real estate CPL YoY change | +5–10% (2025→2026) | — | 2026 | [AdLibrary](https://adlibrary.com/posts/meta-ad-benchmarks-real-estate-2026) |
| Typical Canadian realtor Google Ads budget | $500–$1,500/mo | Canada | 2026 | [Little Dragon Media](https://littledragon.ca/google-ads-pricing-costs-breakdown-what-to-expect/) |

**Two structural warnings for Portage's paid-acquisition plan:**

1. **Meta's Special Ad Category for housing removes most targeting levers** — you cannot target by age, gender, postal code radius, or most interests. Creative quality and broad delivery are your only controls ([AdLibrary, 2026](https://adlibrary.com/posts/meta-ad-benchmarks-real-estate-2026)). This makes early Meta CPLs unpredictable.
2. **Marketplace CAC is double-sided.** Every published real-estate CPL above prices *one* side. Portage must acquire both an owner-lister and a buyer/renter for a transaction to exist. **UNVERIFIED:** no reliable published CAC benchmark for a two-sided owner-direct real-estate marketplace was found — the "typical marketplace CAC" figure the brief asked for does not exist in a citable, comparable form for this niche. Model it as *supply-side CAC + demand-side CAC*, and assume supply (listings) is the constrained side worth paying $50–$150 per acquisition to seed, with demand acquired far more cheaply once inventory exists via organic/SEO.

At $20–$50 blended CPL and 2.15% conversion, a **$2,000/mo paid budget buys roughly 40–100 leads** — enough for validation, nowhere near enough for liquidity. Assume organic/PR/community (Co.Labs network, local Regina press, Facebook Marketplace crossover) carries early supply.

---

## 7. Legal, compliance and insurance — Saskatchewan

| Item | Cost (CAD) | As of | Source |
|---|---|---|---|
| **SK provincial incorporation** — government fee | **$265.00** | 2026 | [ISC Corporate Registry Fees](https://www.saskregistries.ca/fees/corporateregistryfees) |
| SK named corporation — NUANS/search report | + **$60.00** | 2026 | [Corporation Centre SK](https://www.corporationcentre.ca/docen/pinc/home.asp?t=checksk) |
| **Federal incorporation** (Corporations Canada, online) | **$200.00** | 2026 | [Launch a Business](https://www.launchabusiness.ca/post/incorporate-in-canada-cost-federal-vs-provincial-fees) |
| Provincial fee range across Canada, for comparison | $265 (SK) – $450 (AB) | 2026 | [2727 Coworking](https://2727coworking.com/articles/canada-incorporation-costs-2026-federal-provincial) |
| Lawyer — junior associate | $250–$350/hr | 2026 | [J. Kleiman](https://www.jkleiman.com/blog/business-lawyer-cost-toronto/) |
| Lawyer — mid-level (5–10 yrs) | $350–$500/hr | 2026 | [J. Kleiman](https://www.jkleiman.com/blog/business-lawyer-cost-toronto/) |
| Lawyer — senior partner | $500–$800+/hr (Toronto; **lower in smaller markets**) | 2026 | [J. Kleiman](https://www.jkleiman.com/blog/business-lawyer-cost-toronto/), [Founder Feast](https://founderfeast.com/blog/best-startup-lawyers-canada-2026) |
| Legal fees — SAFE round ($250k–$1M) | $3,000–$8,000 | 2026 | [Mayo Law](https://mayo.law/startup-lawyer-toronto/) |
| Legal fees — priced seed ($1M–$3M), company side | $15,000–$35,000 | 2026 | [Mayo Law](https://mayo.law/startup-lawyer-toronto/) |
| Legal fees — Series A, company side | $50,000–$150,000+ | 2026 | [Mayo Law](https://mayo.law/startup-lawyer-toronto/) |
| **Trademark — CIPO application, 1st class (online)** | **$491.06** | 2026 | [CIPO — Fees for trademarks](https://ised-isde.canada.ca/site/canadian-intellectual-property-office/en/trademarks/fees-trademarks) |
| Trademark — non-online filing, 1st class | $640.10 | 2026 | [CIPO](https://ised-isde.canada.ca/site/canadian-intellectual-property-office/en/trademarks/fees-trademarks) |
| Trademark — each additional class | **$149.04** | 2026 | [CIPO](https://ised-isde.canada.ca/site/canadian-intellectual-property-office/en/trademarks/fees-trademarks) |
| Trademark — agent/lawyer fees | +$1,000–$2,500 | 2026 | [Clearview Counsel](https://www.clearviewcounsel.io/our-blog/trademark-lawyer-costs-in-canada-what-to-expect) |
| Trademark fee increase (planned) | 1st-class fee → **$499.41 on 2027-01-01** (+1.7%) | 2027-01-01 | [LawyerInfo — CIPO 2026 fee increases](https://lawyerinfo.ca/guides/money-taxes-ip/intellectual-property/cipo-fee-increases-2026-how-to-budget-for-canadian-ip-protection/) |
| **Tech E&O — early-stage SaaS <$2M revenue** | **$1,500–$4,000/yr** | 2026 | [Aiden Risk](https://aidenrisk.com/blogs/tech-eo-insurance) |
| Tech E&O — median at $1M limit | $2,049/yr | 2026 | [TechInsurance](https://www.techinsurance.com/errors-omissions-insurance/cost) |
| Standalone cyber, $1M limit | From ~$1,500/yr; $1,200–$2,400 for <$1M revenue | 2026 | [Christensen Group](https://www.christensengroup.com/article/small-business-cyber-insurance-costs) |
| Canada — standard $1M/$2M CGL package | $500–$3,000/yr | 2026 | [SmartSMSSolutions](https://smartsmssolutions.com/resources/blog/ca/business-insurance-canada-types-costs-coverage) |
| **PIPEDA — formal certification** | $5,000–$30,000 | 2026 | [Sprinto](https://sprinto.com/blog/pipeda-certification/) |
| SME cybersecurity stack (10–50 employees) | $3,000–$15,000/yr CAD | 2026 | [SmartSMSSolutions](https://smartsmssolutions.com/resources/blog/ca/cybersecurity-small-business-canada-2026) |
| PIPEDA maximum fine | Up to $100,000 per violation | 2026 | [Fusion Computing](https://fusioncomputing.ca/pipeda-compliance-small-business-canada/) |

**Incorporation recommendation:** federal ($200) is cheaper than SK provincial ($265+$60), but **STSI requires a Saskatchewan head office and ≥50% SK-based employees** — those are operational facts, not a charter requirement, so federal incorporation with extra-provincial SK registration works and gives name protection Canada-wide. **UNVERIFIED:** the SK extra-provincial registration fee for a federal corporation was not confirmed; check [ISC fees](https://www.saskregistries.ca/fees).

**PIPEDA — do not buy certification early.** The $5k–$30k figure is for formal certification, which no early-stage marketplace needs. The four gaps that matter are a real privacy policy, a named privacy contact, actual security controls, and a documented access/breach-request process ([Fusion Computing, 2026](https://fusioncomputing.ca/pipeda-compliance-small-business-canada/)). A **$2,000–$5,000 lawyer-drafted privacy policy + terms + a short regulatory memo** is the right spend — and for Portage that memo genuinely matters, because facilitating owner-direct property transactions without licensed agents touches Saskatchewan's real-estate regulatory regime. **UNVERIFIED:** whether Portage's model triggers registration obligations under *The Real Estate Act* (SK) — that is precisely the memo to buy, budget $3,000–$8,000 for it.

---

## 8. Funding environment — Canadian proptech, 2025–2026

| Metric | Value | As of | Source |
|---|---|---|---|
| Canadian proptech total funding | **$450M CAD across 30 disclosed rounds** in 2025 (vs. 50 rounds at 2021 peak) | 2025 | [BetaKit](https://betakit.com/how-ai-and-a-tight-fundraising-market-are-reshaping-canadian-proptech/) |
| Average Canadian seed round | **$3M CAD**, held steady | 2026 | [BetaKit / RBCx](https://betakit.com/canadas-early-stage-startup-funding-is-in-a-sustained-decline-rbcx-finds/) |
| Canadian early-stage Q1 2026 | 61 startups, ~$190M CAD — **down 40% YoY on both count and dollars** | Q1 2026 | [BetaKit / RBCx](https://betakit.com/canadas-early-stage-startup-funding-is-in-a-sustained-decline-rbcx-finds/) |
| Global median seed (all sectors) | $2M USD; Series A $9M; Series B $20M | 2026 | [New Market Pitch](https://newmarketpitch.com/blogs/news/proptech-funding-analysis) |
| Canadian proptech pre-seed example | Landerz — $1.5M CAD seed | — | [BetaKit](https://betakit.com/proptech-startup-landerz-plots-a-course-for-growth-with-1-5-million-cad-seed-round/) |
| Canadian pre-seed example (non-proptech) | Prévoir — $750k CAD pre-seed | — | [BetaKit](https://betakit.com/prevoir-closes-750k-pre-seed-round-to-scale-its-ai-powered-fashion-platform/) |

**Runway math.** A $500k–$750k CAD pre-seed at a $250k–$400k/yr burn (2 people + infra, see below) buys **18–30 months**. A $3M CAD seed at a 5-person burn (~$800k/yr) buys ~3.5 years — but the market is contracting 40% YoY, so a Regina proptech should plan to reach revenue on a pre-seed, not assume a seed. STSI's 45% credit plus SR&ED's 35–45% recovery means **a Saskatchewan startup can stretch a given dollar roughly 1.5× further than a Toronto equivalent** — the single strongest financial argument for building Portage in Regina.

---

## Bottom line: what a lean 12-month Regina build actually costs

Assumptions: **2 people** (one technical co-founder taking below-market or deferred comp, one paid developer), calendar year 1, MVP → soft launch → <1,000 users. All CAD. USD line items converted at 1.386.

| Line | Low | Likely | High | Basis |
|---|---:|---:|---:|---|
| **People** | | | | |
| Developer #1 (paid, loaded ×1.15) | $78,000 | $109,000 | $155,000 | Job Bank Regina band $66.5k–$120k + 15% burden |
| Technical co-founder cash (deferred / stipend) | $0 | $36,000 | $90,000 | Below-market founder draw |
| Contract help (design, DevOps, spot work) | $0 | $12,000 | $35,000 | 100–300 hrs @ $65–$120/hr CAD |
| **People subtotal** | **$78,000** | **$157,000** | **$280,000** | |
| **Infrastructure & tooling (12 mo)** | | | | |
| Hosting (Supabase Pro + Vercel Pro / AWS) | $700 | $1,400 | $3,300 | $42–$200 USD/mo |
| Claude API (AI search + listing builder) | $500 | $2,300 | $7,000 | $30–$420 USD/mo, Haiku→Sonnet |
| Maps (MapTiler Flex) | $0 | $420 | $1,700 | $0–$100 USD/mo |
| Email + SMS | $170 | $700 | $2,000 | Resend $20 + Twilio usage |
| Monitoring + analytics (Sentry, PostHog) | $0 | $430 | $1,400 | Free tiers → $26–$85 USD/mo |
| Identity verification (Stripe Identity @ $1.50 USD) | $400 | $2,100 | $8,300 | 200–4,000 checks/yr |
| Dev tooling, domains, misc SaaS | $600 | $1,800 | $4,000 | UNVERIFIED — planning estimate |
| **Infra subtotal** | **$2,370** | **$9,150** | **$27,700** | |
| **Legal, IP & insurance** | | | | |
| Incorporation (federal + SK registration) | $200 | $600 | $1,500 | CIPO $200 / ISC $265+$60 |
| Startup legal package (founders' agreement, T&Cs, privacy policy) | $2,000 | $5,000 | $12,000 | $250–$500/hr, 8–25 hrs |
| SK real-estate regulatory memo | $0 | $4,000 | $8,000 | UNVERIFIED scope; $250–$500/hr |
| Trademark (1 class + agent) | $500 | $2,000 | $3,000 | CIPO $491.06 + $1,000–$2,500 agent |
| Tech E&O + cyber insurance | $1,500 | $2,800 | $5,500 | $1,500–$4,000 E&O + cyber |
| Accounting / SR&ED filing prep | $2,000 | $5,000 | $12,000 | UNVERIFIED — SR&ED consultants typically take 15–20% of the claim |
| **Legal subtotal** | **$6,200** | **$19,400** | **$42,000** | |
| **Go-to-market (12 mo)** | | | | |
| Paid ads | $0 | $12,000 | $36,000 | $0–$3,000/mo at Canadian real-estate CPLs |
| Seed listing media (photographer, 30–60 listings) | $0 | $9,000 | $27,000 | $150–$450/listing at Regina-discounted rates |
| Brand, content, community, events | $1,000 | $6,000 | $18,000 | UNVERIFIED — planning estimate |
| **GTM subtotal** | **$1,000** | **$27,000** | **$81,000** | |
| **Workspace** | | | | |
| Coworking (Regus Regina dedicated desk, 2 people) | $0 (home) | $5,200 | $6,900 | $215–$289/person/mo ([Regus Regina](https://www.regus.com/en/ca/saskatchewan/regina/coworking)) |
| | | | | |
| **GROSS 12-MONTH TOTAL** | **$87,600** | **$217,800** | **$437,600** | |
| | | | | |
| **Offsets — money back** | | | | |
| SR&ED federal 35% refundable (on eligible salary) | −$15,000 | −$38,000 | −$62,000 | 35% of ~30–50% of dev salary |
| SK R&D credit 10% refundable | −$4,000 | −$11,000 | −$18,000 | 10% of same base |
| Co.Labs Co.Launch prize (if won) | $0 | $0 | −$20,000 | Up to $20k, not guaranteed |
| **NET 12-MONTH CASH REQUIREMENT** | **~$68,600** | **~$168,800** | **~$337,600** | |

### How to read this

- **The "Low" column is a real scenario, not a fantasy** — two technical co-founders, both unpaid except one modest salary, working from home, no paid ads, launching with organically-sourced listings. It is how most successful marketplaces actually start. ~$70k net.
- **The "Likely" column is the honest plan:** one paid developer, one founder on a stipend, a coworking desk, a real legal foundation including the regulatory memo, seeded listing media, and a modest ad budget. **~$170k net for year one.** That is comfortably inside a $500k–$750k CAD pre-seed with room for year two.
- **The single biggest cost is people (72% of the Likely total), and the single biggest lever is SR&ED + the SK R&D credit**, which returns ~30% of eligible developer salary in cash. Structure the work so the genuinely novel parts (AVM, AI search relevance, neighbourhood scoring) are documented as experiments from day one — that documentation *is* the money.
- **The second-biggest controllable lever is STSI.** A 45% investor credit on a local angel round makes Regina angels dramatically cheaper to raise from than out-of-province capital, and Portage meets every eligibility test.
- **Watch three cost traps:** (1) Mapbox's $5/1,000 map-load overage on a map-first product — use MapTiler or self-hosted tiles; (2) Vercel Hobby is contractually unavailable to you, budget Pro; (3) identity verification vendors that bill per *attempt* rather than per success will be probed by fraudsters — Stripe Identity's $1.50 no-minimum model is the safe default.

### Explicitly UNVERIFIED items

1. **ca-central-1-specific** AWS RDS / Fargate / S3 rates (only US baselines confirmed; apply +5–10%).
2. **Trulioo** per-verification pricing (enterprise, quote-only).
3. **Twilio Canadian phone-number monthly rental** and A2P campaign registration fees.
4. **Regina-specific** real-estate photography rates (GTA/Montreal used as ceiling).
5. **Two-sided marketplace CAC** for owner-direct real estate — no citable benchmark exists.
6. **SK extra-provincial registration fee** for a federally-incorporated company.
7. Whether Portage's model triggers registration under **The Real Estate Act (Saskatchewan)** — this is the regulatory memo to buy.
8. Self-hosted MapLibre tile-serving cost (depends on extract size and cache hit rate).
9. SR&ED consultant contingency rates (commonly cited as 15–20% of claim, not confirmed for 2026).
10. Dev tooling / brand / content line items in the bottom-line table — planning estimates, not sourced figures.
