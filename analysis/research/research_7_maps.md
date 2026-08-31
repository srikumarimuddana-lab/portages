# Research 7 — Interactive Map Providers for Portage (map-first real-estate marketplace)

**Prepared:** 2026-08-28 · **Target:** Regina, SK · **Stack:** Next.js/TS on Vercel Pro, Supabase Postgres (ca-central-1)
**Scale modelled:** 50,000–500,000 map loads/month (2,000–10,000 MAU)

## Method note and confidence caveat — READ FIRST

This session's egress proxy **blocked direct HTTPS access to every vendor domain** (mapbox.com, maptiler.com, docs.protomaps.com, developers.google.com, stadiamaps.com, openfreemap.org, radar.com, geoapify.com, thunderforest.com, carto.com — all returned `403 CONNECT tunnel failed` / `EGRESS_BLOCKED`). All figures below come from **search-index summaries citing primary vendor URLs**, not from reading those pages myself. The cited URLs are correct destinations; the *numbers* attributed to them are second-hand.

**Treat every price as "confirm on the vendor page before signing anything."** Figures not corroborated across two independent results are marked **UNVERIFIED**.

**Modelling assumption throughout:** for tile-billed providers I assume **~30 vector tile requests per map load** — 6–12 tiles for the initial viewport plus panning/zooming. Real range is 15–60. Thunderforest's guidance is "a typical page view will lead to around 15-20 map tiles being loaded" ([thunderforest.com/articles/using-your-quota](https://www.thunderforest.com/articles/using-your-quota/), as of 2026-08); Jawg defines 1 Map View = 15 vector tiles ([jawg.io/en/pricing](https://www.jawg.io/en/pricing/), as of 2026-08). A map-first product sits at the high end — **double these for a pessimistic case**.

---

## Decision table

| Provider | Free tier | Cost @ 100k loads/mo | Cost @ 500k loads/mo | Self-host? | Licence gotchas |
|---|---|---|---|---|---|
| **PMTiles self-host (Cloudflare R2)** | R2 free: 10 GB storage + 10M Class B reads/mo | **~$0–5/mo** | **~$5–10/mo** | Yes — that's the point | ODbL: must show "© OpenStreetMap". Browser range-request caching is broken; needs edge cache |
| **OpenFreeMap (public instance)** | Unlimited, no key, no cookies | **$0** | **$0** | Yes (€4.5/mo VPS) | No SLA. Donation-funded (~$500/mo). Single-maintainer risk |
| **Protomaps Hosted API** | 1M tile req/mo, **non-commercial only** | from **$14/mo** (commercial via GitHub Sponsors); higher tiers UNVERIFIED | UNVERIFIED | Yes (same PMTiles files) | Commercial use requires sponsorship. ODbL attribution |
| **Stadia Maps Starter** | 200k credits/mo, **non-commercial only** | **~$80/mo** ($20 + 2M credits) | **~$440/mo** ($20 + 14M credits) | No | Free plan explicitly barred from revenue-generating apps |
| **MapTiler Flex** | 100k req + 5k sessions, **non-commercial only** | **~$275/mo** (est., request-billed) | **~$1,475/mo** (est.) | Yes (MapTiler Server; commercial price UNVERIFIED) | Free plan needs MapTiler logo. Geocoding results **may not be permanently stored** |
| **Thunderforest** | 150k tile req/mo (Hobby, non-commercial) | **£95/mo** (Solo Dev, 1.5M tiles) | **£195/mo** (Small Business, 15M tiles) | No | **Raster tiles only** — no vector styling, rotation, or GPU clustering |
| **Jawg** | 25k map views/mo, **non-commercial only** | from **$289/mo** | UNVERIFIED | No | Commercial entry price is high for a pre-revenue product |
| **Mapbox GL JS** | 50k map loads/mo | **$250/mo** + mandatory real-estate licence | **$1,650/mo** + mandatory real-estate licence | No | ⚠️ **Real-estate apps must buy a Commercial Application License — PAYG is not permitted.** GL JS v2+ is proprietary |
| **Google Maps Platform** | 10k Dynamic Maps events/mo | **$630/mo** | **~$2,800–3,430/mo** | No | ⚠️ **ToS prohibits use "in a listings or directory service."** Places results must render on a Google map. 30-day cache cap |
| **CARTO** | Basemaps free under "fair use" with API key | Contact sales | Contact sales | No | No public self-serve pricing; enterprise contract required |

**Headline:** the spread between the cheapest viable option and the most expensive is roughly **three orders of magnitude** at 500k loads/month (~$5 vs ~$3,400). For a zero-fee business model this is not a close call.

---

## 1. Mapbox GL JS

**What triggers a billable event.** A map load is counted "whenever a Mapbox GL JS `Map` object is initialized on a webpage." Once initialized, the user can pan, zoom, toggle layers and switch styles with no additional charge, and the load "includes unlimited Vector Tiles API and Raster Tiles API requests." **Maximum session length is 12 hours**, after which a new map load is counted ([docs.mapbox.com/mapbox-gl-js/guides/pricing](https://docs.mapbox.com/mapbox-gl-js/guides/pricing/), as of 2026-08).

This is a *generous* definition — pan/zoom/draw-polygon interactions are free within a load. A Portage user browsing for 20 minutes costs exactly one load.

**Pricing (as of 2026-07/08).** 50,000 free web map loads/month; **$5 per 1,000** from 50k to 200k; **$3 per 1,000** above 200k ([buildmvpfast.com/api-costs/maps](https://www.buildmvpfast.com/api-costs/maps), July 2026; corroborated by [vendr.com/marketplace/mapbox](https://www.vendr.com/marketplace/mapbox)). Credit card required from day one. Whether tiers are marginal or blended is **UNVERIFIED**; Mapbox describes discounts applying "progressively within each billing period," implying marginal, so: 100k → $250/mo; 500k → $750 + $900 = **$1,650/mo**.

**Other SKUs.** Static Images: 50,000 free/mo then **$1.00/1,000** ([docs.mapbox.com/accounts/guides/pricing](https://docs.mapbox.com/accounts/guides/pricing/)). Address Autofill: **$12.50 per 1,000 sessions** above 1,000 free ([docs.mapbox.com/mapbox-search-js/guides/pricing](https://docs.mapbox.com/mapbox-search-js/guides/pricing/)). Search Box is session-billed on `/suggest`+`/retrieve`, with per-keystroke exposure (~$0.005/keystroke) if you don't debounce.

**The disqualifying gotcha.** Mapbox Product Terms state that **if a customer makes production use of a Licensed Application related to real estate, the customer must in all cases obtain a Commercial Application License** — an annual subscription with, where applicable, a per-seat component. Pay-as-you-go is **not** an acceptable route for real estate ([Mapbox Product Terms, Feb 5 2026 PDF](https://cdn.prod.website-files.com/609ed46055e27a02ffc0749b/6985385d62132c83959197b6_Mapbox%20Product%20Terms%20(February%205,%202026).docx.pdf)). The figure is negotiated and **UNVERIFIED** — but for a zero-fee marketplace, an annual seat-based commitment is the wrong shape of cost.

Note also that Mapbox GL JS v2+ is proprietary (the December 2020 relicensing from BSD-3-Clause) and requires an active subscription ([geoapify.com/mapbox-gl-new-license-and-6-free-alternatives](https://www.geoapify.com/mapbox-gl-new-license-and-6-free-alternatives/)).

---

## 2. MapTiler

**Plans (as of 2026-08).** Free $0 — 100,000 API requests, 5,000 sessions, 100 MB hosting. **Flex $25/mo** — 500,000 requests, overage **$0.10 per 1,000 extra requests**. **Unlimited $295/mo** — 5M requests + 99.9% SLA. Custom prepaid contracts above ([maptiler.com/cloud/pricing](https://www.maptiler.com/cloud/pricing/); corroborated by [pricingnow.com](https://pricingnow.com/question/maptiler-cloud-pricing/)). One source lists Flex at $29/mo — **UNVERIFIED which is current**.

**Sessions vs requests.** A Map Session is counted when a page loads containing a map initialization; interaction within it is unlimited. A new session starts when: the user reloads the tab, a session exceeds **6 hours**, or the session reaches **10,000 requests**. A tile request is a single API call for one tile ([docs.maptiler.com/guides/maps-apis/maps-platform/tile-requests-and-map-sessions-compared](https://docs.maptiler.com/guides/maps-apis/maps-platform/tile-requests-and-map-sessions-compared/), as of 2026-08).

**Critical unknown:** each plan caps *both* sessions and requests, and "when you hit either of these two limits, you get charged extra." The **session allowance on Flex is UNVERIFIED** — the free plan's 1:20 session:request ratio would imply ~25,000 sessions on Flex, which 100k monthly map loads would blow through. My table costs use the *request* limit only ($0.10/1,000 is cheap: 100k loads × 30 tiles = 3M requests → $25 + $250 = **$275/mo**; 500k = 15M requests → $25 + $1,450 = **$1,475/mo**). **Confirm the session cap and session-overage rate before relying on these.**

**Free plan is non-commercial:** "limited to non-commercial use and research & development," and free accounts must display the MapTiler *logo*, not just text attribution ([maptiler.com/terms/cloud](https://www.maptiler.com/terms/cloud/)). Portage cannot ship on it.

**MapLibre drop-in:** yes. MapTiler founded and sponsors MapLibre ([maptiler.com/news/2021/01/maplibre-mapbox-gl-open-source-fork](https://www.maptiler.com/news/2021/01/maplibre-mapbox-gl-open-source-fork/)) and serves standard TileJSON/style endpoints. Swapping MapTiler → Protomaps → OpenFreeMap is a style-URL change, not a rewrite. **This is the most valuable architectural fact in this document.**

**Self-host:** MapTiler Server offers a free download with sample data; commercial on-prem pricing requires contacting sales — **UNVERIFIED** ([maptiler.com/server](https://www.maptiler.com/server/)).

---

## 3. MapLibre GL JS + tile source comparison

**MapLibre GL JS is BSD-3-Clause and free forever** — a community fork of the last BSD-licensed Mapbox GL JS, created after Mapbox's December 2020 relicensing ([github.com/maplibre/maplibre-gl-js](https://github.com/maplibre/maplibre-gl-js/blob/main/README.md)). It gives Portage everything it needs natively: GPU price pins, `cluster: true` on GeoJSON sources, `maplibre-gl-draw` for polygon search, vector fill layers for boundaries. **The library is a solved, zero-cost problem. Only tiles cost money.**

- **Stadia Maps** — Free: 200,000 credits/mo, **non-commercial only**. **Starter $20/mo = 1,000,000 credits**, overage **$0.03 per 1,000 credits**. 1 vector tile = 1 credit; 1 geocode = 20 credits ([stadiamaps.com/pricing](https://stadiamaps.com/pricing/), as of 2026-08). Works with MapLibre for all non-satellite styles. At 30 tiles/load: 100k → **$80/mo**; 500k → **$440/mo**. The best-value *managed* option found, by a wide margin.
- **Thunderforest** — Hobby free at 150,000 tile req/mo (non-commercial); Solo Developer £95/mo = 1.5M; Small Business £195/mo = 15M; Large Business £395/mo = 150M ([thunderforest.com/pricing](https://www.thunderforest.com/pricing/)). **Raster only** — rules it out for vector pins, rotation and GPU clustering.
- **Jawg** — free 25,000 map views/mo, **non-commercial**; commercial from **$289/mo**; 1 Map View = 15 vector tiles ([jawg.io/en/pricing](https://www.jawg.io/en/pricing/)). Entry price too high pre-revenue.
- **CARTO** — no public self-serve pricing; Enterprise tiers all "contact vendor" ([capterra.com/p/140192/CartoDB/pricing](https://www.capterra.com/p/140192/CartoDB/pricing/)). Positron/Voyager basemaps are free under "fair use" with an API key ([docs.carto.com/faqs/carto-basemaps](https://docs.carto.com/faqs/carto-basemaps)) — fine as an emergency fallback, unwise as a load-bearing dependency without a contract.
- **OpenFreeMap** — public instance is **free with no limits on map views or requests, no registration, no API keys, no cookies** ([openfreemap.org](https://openfreemap.org/)). Funded by ~$500/mo in donations covering infrastructure; Cloudflare sponsors bandwidth, runs on Hetzner, and it survived a 100,000 req/s load event ([blog.hyperknot.com/p/openfreemap-survived-100000-requests](https://blog.hyperknot.com/p/openfreemap-survived-100000-requests), as of 2026). Fully open source including production deploy scripts — no open-core holdback — and self-hosting is tested on a **€4.5/mo Contabo Storage VPS** ([self_hosting.md](https://github.com/hyperknot/openfreemap/blob/main/docs/self_hosting.md)).
  **2026 verdict:** viable, with an honest risk profile — no SLA, no support contract, effectively one maintainer. It is *safe to depend on precisely because you can self-host the identical stack* if the public instance degrades. A launch shortcut, not a permanent single point of failure.
- **Protomaps Hosted API** — free for **non-commercial** use up to 1M tile req/mo; **commercial from $14/mo via GitHub Sponsors** ([protomaps.com/api](https://protomaps.com/api)). Higher tiers **UNVERIFIED**. CDN-cached vector tiles via style/TileJSON/ZXY endpoints with API keys — cheap, and uses the same data you'd otherwise self-host.

---

## 4. Protomaps / PMTiles self-hosting (deep dive)

**How it works.** A PMTiles archive is a **single file** containing a whole tile pyramid plus a compressed directory index. The client (MapLibre + the `pmtiles` protocol plugin) issues **HTTP Range requests** for the byte ranges it needs. There is no tile server, no database, no container to keep alive — just an object in a bucket behind a CDN ([docs.protomaps.com/pmtiles](https://docs.protomaps.com/pmtiles/)).

**Building an extract.** Protomaps publishes **daily planet builds**, and the `pmtiles` CLI can extract a bounding box **from the remote build without downloading the planet**:

```
pmtiles extract https://build.protomaps.com/<DATE>.pmtiles regina.pmtiles \
  --bbox=<MIN_LON,MIN_LAT,MAX_LON,MAX_LAT> --maxzoom=15
```

([docs.protomaps.com/pmtiles/cli](https://docs.protomaps.com/pmtiles/cli); [docs.protomaps.com/basemaps/downloads](https://docs.protomaps.com/basemaps/downloads))

**Size.** Full-zoom extracts "typically land between one and a few gigabytes for a mid-sized country," and **each additional zoom level roughly doubles file size** — dropping maxzoom 15→14 approximately halves it. A **Saskatchewan-only** or **Regina-metro** extract is dramatically smaller; I estimate **tens of MB for Regina metro at z15**, but the exact size is **UNVERIFIED** and takes ten minutes to measure. For scale, the **entire global tileset (~130 GB) costs about $3/month** on R2 ([latlong.blog/2024/01/protomaps-cost-calculator](https://latlong.blog/2024/01/protomaps-cost-calculator.html)).

**Hosting cost — Cloudflare R2 (as of 2026-07).** Storage **$0.015/GB-month**; Class B (read) operations **$0.36 per million**; **zero egress fees**; permanent free tier of **10 GB storage + 1M Class A + 10M Class B ops/month** ([egresscost.com/cloudflare](https://egresscost.com/cloudflare/); corroborated by [flarecalc.com/calculators/r2](https://flarecalc.com/calculators/r2/)).

Applied to Portage: a Regina/Saskatchewan extract fits inside the 10 GB free storage tier. At 100k loads × 30 tiles = 3M reads/month — **entirely inside the 10M free Class B allowance, so $0**. At 500k loads = 15M reads → 5M billable × $0.36/M = **$1.80/month**, plus Cloudflare Workers at **$5/mo for 10M requests** ($0.30/additional million) if fronted by a Worker. **Call it $0–$10/month at any volume Portage sees in year one or two.**

The widely cited benchmark: **10M tile requests/month ≈ $3,600 on Google Maps, ~$120 on AWS S3, ~$11 on Cloudflare R2** ([bonitotech.com](https://bonitotech.com/2024/03/19/how-we-reduced-our-mapping-costs-by-90-using-protomaps-and-cloudflare/); [docs.protomaps.com/deploy/cost](https://docs.protomaps.com/deploy/cost)). S3 is ~10× R2 purely because of egress fees — **do not use S3 for this**.

**Supabase Storage as host.** It is S3-compatible and **supports HTTP Range Requests**, with a first-party tutorial for exactly this ([supabase.com/blog/self-host-maps-storage-protomaps](https://supabase.com/blog/self-host-maps-storage-protomaps)). Public buckets allow all CORS origins and sit behind a CDN edge cache; restricting to your own domain requires an Edge Function proxy. Cost: Pro includes **250 GB egress**, then **$0.03/GB cached / $0.09/GB uncached** ([supabase.com/pricing](https://supabase.com/pricing)). Since you already pay for Pro this is the *simplest* option — but R2's zero-egress model is structurally cheaper at volume, and keeps your map's blast radius separate from your database's.

**Gotchas — all real, all cheap to handle:**

1. **Browsers do not cache range requests.** Neither Firefox nor Chrome caches range responses against a `.pmtiles` file, even when ETags match ([PMTiles#272](https://github.com/protomaps/PMTiles/issues/272)). Every pan re-fetches. **Mitigation: front the bucket with a Cloudflare Worker or CDN cache** — this also keeps R2 read counts down.
2. **Cloudflare can corrupt HTTP Range responses.** Documented fix is `Cache-Control: no-transform` from the origin — unavailable on hosts that can't set custom headers, e.g. GitHub Pages ([demotiles#35](https://github.com/maplibre/demotiles/issues/35)).
3. **CORS must be explicit:** `Range` in `AllowedHeaders`, `ETag` in `ExposeHeaders`, and the server must answer OPTIONS preflight ([docs.protomaps.com/pmtiles/cloud-storage](https://docs.protomaps.com/pmtiles/cloud-storage)).
4. **R2 latency** can run 500ms+ versus other CDN-fronted storage — another reason for a Worker cache in front.
5. **Rebuild cadence.** A static file means static data. Regina's street network changes slowly, so a **monthly or quarterly rebuild** is fine — but it's a cron job someone must own. Version the filename (`regina-2026-08.pmtiles`) so cache invalidation is free.

**Licence.** Protomaps basemap tiles are Produced Works of OSM under **ODbL**, so web maps **must visibly attribute "© OpenStreetMap"** in the corner of the map. The Protomaps *visual style* is **CC0**; crediting Protomaps is requested but not required ([github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md](https://github.com/protomaps/basemaps/blob/main/LICENSE_DATA.md); [osmfoundation.org/wiki/Licence/Attribution_Guidelines](https://osmfoundation.org/wiki/Licence/Attribution_Guidelines)). Natural Earth data is public domain.

---

## 5. Google Maps Platform

**The March 2025 change.** As of **March 1, 2025**, Google **replaced the universal $200/month credit with per-SKU free monthly caps**: **Essentials 10,000 free calls per SKU/month, Pro 5,000, Enterprise 1,000**. Automatic volume discounts were simultaneously extended to scale to 5,000,000+ monthly billable events (previously topping out at 100,000+) ([developers.google.com/maps/billing-and-pricing/march-2025](https://developers.google.com/maps/billing-and-pricing/march-2025); [mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product](https://mapsplatform.google.com/resources/blog/start-building-today-with-up-to-10-000-monthly-free-calls-per-product/)).

**Dynamic Maps** is an Essentials SKU: **10,000 free events/month, then $7.00 per 1,000** for the 10,001–100,000 band ([developers.google.com/maps/billing-and-pricing/pricing](https://developers.google.com/maps/billing-and-pricing/pricing), as of 2026). At 100k loads that is **$630/month**. At 500k, rates above 100k are **UNVERIFIED**; at flat $7 it would be $3,430/mo, and with plausible volume discounts roughly **$2,800–3,430/mo**. Static Maps is also Essentials: 10,000 free then **$2–$7 per 1,000** (exact rate **UNVERIFIED**).

**The licensing problem is worse than the price.** Google Maps Platform terms state customers **"will not use the Google Maps Core Services in a listings or directory service, or to create or augment an advertising product"** ([cloud.google.com/maps-platform/terms](https://cloud.google.com/maps-platform/terms)). A real-estate listings marketplace is, on a plain reading, a listings service. There is a further restriction that Places API results shown on a map **must be shown on a Google map**, and a prohibition on creating or augmenting a mapping/business-listings dataset that substitutes for Google Maps ([developers.google.com/maps/documentation/places/web-service/policies](https://developers.google.com/maps/documentation/places/web-service/policies)).

**Verdict: Google is both the most expensive option and the one carrying the clearest use-case prohibition for Portage.** Eliminate it. If any Google surface is ever needed, get written confirmation from Google sales first.

---

## 6. Geocoding + address autocomplete

Two distinct jobs: (a) **listing address entry** — low volume, one call per new listing, results **must be stored** as coordinates in Postgres; (b) **search-by-address** — higher volume, results ephemeral.

| Provider | Free tier | Paid rate | Can you store/cache results? |
|---|---|---|---|
| **Mapbox Temporary** | 100k req/mo | **$0.75/1,000** | ❌ **No** — cannot be exported, stored in a DB, or cached; must re-call every time |
| **Mapbox Permanent** | None | **$5.00/1,000** | ✅ Yes, indefinitely (`permanent=true`) |
| **Google Geocoding** (Essentials) | 10k/mo | ~$5/1,000 (**UNVERIFIED**) | ⚠️ **30-day cache cap** |
| **Google Places Autocomplete** | 10k/mo (Essentials) | **$2.83/1,000** per-request; sessions can zero autocomplete cost but terminate on Place Details at **$17–$20/1,000** | ⚠️ 30-day cap; listings-service prohibition applies |
| **MapTiler Geocoding** | Within plan request quota; sessions introduced June 2026 | Bundled ($0.10/1,000 overage) | ❌ **No permanent storage permitted** |
| **Radar** | 100,000 API req/mo (Developer, free) | Team **$499/mo** up to 1M req | **UNVERIFIED** |
| **Geoapify** | **3,000 credits/day** (~90k/mo) — *enforced per day, not per month* | from ~€49–59/mo for 300k credits | ✅ **Yes** — permissive licence explicitly allows cache, store, redistribute |
| **Nominatim** (OSM public) | Free, no key | n/a | ✅ Yes, cache indefinitely — **but 1 req/sec, no autocomplete, no bulk. Not production-usable** |
| **Pelias / Nominatim self-host** | Free | Server cost only | ✅ Yes, no restrictions |

Sources: [geocod.io/geocoding-terms-of-use-comparison](https://www.geocod.io/geocoding-terms-of-use-comparison) (as of 2026); [docs.mapbox.com/api/search/geocoding](https://docs.mapbox.com/api/search/geocoding/); [stadiamaps.com/blog/why-is-your-geocoding-bill-higher-than-it-should-be](https://stadiamaps.com/blog/why-is-your-geocoding-bill-higher-than-it-should-be/); [operations.osmfoundation.org/policies/nominatim](https://operations.osmfoundation.org/policies/nominatim/); [geoapify.com](https://www.geoapify.com/); [radar.com/blog/google-geocoding-api-pricing](https://radar.com/blog/google-geocoding-api-pricing); [developers.google.com/maps/documentation/places/web-service/session-pricing](https://developers.google.com/maps/documentation/places/web-service/session-pricing).

**The storage restriction is the decisive axis, not price.** Portage *must* persist a lat/lng per listing — that is the entire product. Mapbox charges **6–8× more** for the right to do so, and MapTiler forbids it outright. **Geoapify's permissive licence and Nominatim/Pelias self-hosting are the only options where "store the coordinate forever" is unambiguously allowed at low cost.**

**Self-host sizing:** a *planet* Nominatim wants 32 GB RAM minimum (128 GB comfortable) and ~3.7 TB storage — absurd for Portage. But a **Saskatchewan or Canada extract is a tiny fraction of that**, and Pelias runs regional deployments in **~6 GB RAM** versus Nominatim's ~28 GB, with Elasticsearch giving genuinely better autocomplete ([wcedmisten.fyi/post/self-hosting-osm](https://wcedmisten.fyi/post/self-hosting-osm/); [pistack.xyz](https://www.pistack.xyz/posts/self-hosted-geospatial-mapping-servers-nominatim-tileserver-gl-geoserver-guide-2026/)). Rule of thumb from the same sources: **above ~50,000 lookups/month the maths favours self-hosting.**

---

## 7. Canadian address data — Regina specifically

**The best find in this research: the City of Regina publishes exactly what Portage needs, free.** [open.regina.ca](https://open.regina.ca/dataset/address) carries an **Address Points** dataset ("represents the addresses," live feeds in JSON), **ownership/assessment parcels**, **community association boundaries**, and city limits — served via **ArcGIS REST API and JSON** ([regina.ca/city-government/open-data](https://www.regina.ca/city-government/open-data/), as of 2026-08).

This means Portage can, for zero recurring cost:
- Load ~authoritative Regina address points into Postgres and run **address autocomplete entirely in-database** (`pg_trgm` on a normalized address column, plus PostGIS for the coordinate). No geocoding API, no per-request cost, no storage-licence question, and *better* accuracy than any global geocoder for a single city.
- Use community-association boundaries directly as the **neighbourhood boundary overlays** — as GeoJSON in a MapLibre fill layer.

**StatCan Open Database of Addresses (ODA):** ~10 million records aggregated from 99 government open-data sources, under the **Open Government Licence – Canada**. Version 1.0 was collected **January–April 2021** and covers only provinces/territories where open address data existed at that time ([statcan.gc.ca/en/lode/databases/oda](https://www.statcan.gc.ca/en/lode/databases/oda)). **Whether Regina/Saskatchewan is included is UNVERIFIED** — and it matters less than it seems, because the municipal source is fresher and directly available.

**OSM coverage of Regina:** **UNVERIFIED.** No Regina-specific quality study surfaced. Global research shows building-footprint completeness exceeds 80% in only ~16% of urban centres, and is below 20% for 48% of the urban population ([nature.com/articles/s41467-023-39698-6](https://www.nature.com/articles/s41467-023-39698-6)). Street networks in Canadian cities are generally well covered; *address point* coverage is the weak spot. **Action: spend 30 minutes measuring it** — count OSM `addr:housenumber` nodes in the Regina bbox against the city's address-point count. Don't guess.

**Canada Post AddressComplete:** 12 plan tiers ranging from **11.6¢ per lookup down to 4.0¢ per lookup** (at 500,000 lookups), +1¢ surcharge for international addresses; plans from $35 to $20,000; credits valid 12 months or until exhausted; free trial gives 100 lookups/day ([canadapost-postescanada.ca/ac/pricing](https://www.canadapost-postescanada.ca/ac/pricing/), as of 2026-08). At 4–11.6¢ this is **$40–$116 per 1,000** — roughly **50–150× the cost of Mapbox temporary geocoding** and 100× the cost of doing it yourself from Regina open data. It is authoritative for *deliverable postal* addresses, which matters for mailing, not for map pins. **Defer it; revisit only if Portage ever mails anything.**

---

## 8. Static map images for listing thumbnails and social cards

The important realisation: **listing thumbnails are generated once per listing, not once per view.** A marketplace with 1,000 active listings needs 1,000 images — ever — then caches them in Supabase Storage or Vercel Blob behind an immutable URL. Even at Mapbox's $1/1,000 that is **one dollar**. Static maps are a rounding error; choose on licence, not price.

- **Mapbox Static Images:** 50,000 free/mo then **$1.00/1,000** — but the real-estate Commercial Application License requirement applies to the whole account.
- **Google Static Maps:** 10,000 free/mo then $2–$7/1,000 (**UNVERIFIED** exact), plus the listings-service prohibition.
- **Self-render (recommended):** **MapLibre GL Native Node.js** bindings render styled PNGs headlessly from your own PMTiles archive ([madewithmaplibre.com/sdks/maplibre-gl-native-nodejs](https://madewithmaplibre.com/sdks/maplibre-gl-native-nodejs/)). Working precedents: [ConservationMetrics/mapgl-tile-renderer](https://github.com/ConservationMetrics/mapgl-tile-renderer) (MapLibre GL Native + Sharp), TileServer GL's server-side raster mode, and the Protomaps community discussion on saving PMTiles maps as PNGs ([github.com/protomaps/PMTiles/discussions/350](https://github.com/protomaps/PMTiles/discussions/350)). Cost is compute-only; you own the output and can cache it permanently with no licence question.

**Caveat:** MapLibre GL Native does not run in Vercel's serverless runtime (native bindings). Run it in a **Supabase Edge Function with a container, a small worker VM, or a one-off script triggered on listing publish** — not in a Next.js route handler.

---

## Recommendation for Portage

### Primary: MapLibre GL JS + self-hosted Protomaps PMTiles on Cloudflare R2

**Cost: roughly $0–10/month at every volume in the year-one plan**, versus $250–$1,650 (Mapbox, plus a mandatory annual real-estate licence) or $630–$3,430 (Google, which also likely prohibits the use case outright).

Why this and not the cheapest managed option (Stadia at $80–440/mo):

1. **The zero-fee model makes per-load cost an existential variable, not a line item.** With no transaction revenue, every map load is pure cost against a marketing or subscription budget you don't have yet. Success — a viral month in Regina — must not produce a bill. R2's structure (zero egress, 10M free reads/month, sub-$2 marginal cost) means **traffic growth is free**. Every metered provider inverts that: your best month is your most expensive month. For Portage that inversion is the wrong risk to carry.
2. **The two licence landmines are avoided entirely.** Mapbox requires a negotiated Commercial Application License for real estate; Google's terms bar "listings or directory services." Self-hosted OSM-derived tiles under ODbL require only a visible "© OpenStreetMap" credit in the map corner. No sales call, no seat count, no clause to re-read at Series A.
3. **The geographic scope is ideal for it.** Portage launches in *one city*. A Regina- or Saskatchewan-bounded extract is small, fast to build, and cheap to store. The self-hosting argument gets weaker the more of the planet you need — Portage needs almost none of it.
4. **Migration cost is near zero because MapLibre is source-agnostic.** Switching tile sources is a style-URL change. This is a reversible decision, which is exactly the kind you should make quickly and cheaply.

**Fallback: OpenFreeMap's public instance for launch, Stadia Maps Starter ($20/mo) as the paid escape hatch.** Ship on OpenFreeMap on day one — free, unlimited, no API key, and it costs about twenty minutes to wire up while the PMTiles pipeline is being built. If OpenFreeMap ever degrades and the R2 pipeline isn't ready, Stadia Starter at $20/mo + $0.03/1,000 credits is a same-day swap with a real commercial licence and support behind it. Keep the style URL in an environment variable from the first commit so all three are interchangeable without a deploy.

**Geocoding: build address autocomplete from City of Regina open data, in Postgres.** This is faster, more accurate for Regina, free, and — critically — sidesteps the storage-licence trap entirely (Mapbox temporary forbids persisting coordinates; MapTiler forbids it; Google caps caching at 30 days). Portage's whole product is a persisted coordinate per listing. Own that data. If a commercial geocoder is ever needed for out-of-city addresses, use **Geoapify** — it is the only mainstream provider whose licence explicitly permits caching, storing and redistributing results.

### Build first vs defer

**Build first (week one):**
- MapLibre GL JS with the tile style URL in an env var. Price pins as a GeoJSON source with `cluster: true` — native, free, no plugin.
- Neighbourhood overlays straight from Regina's community-association boundaries as GeoJSON fill layers.
- Address autocomplete from the Regina address-points dataset loaded into Postgres (`pg_trgm` + PostGIS).
- Ship on OpenFreeMap's public tiles. Add the "© OpenStreetMap" attribution control immediately — it is a licence obligation, not a nicety.

**Build second (weeks two–four):**
- The PMTiles pipeline: `pmtiles extract` a Saskatchewan bbox at maxzoom 15, upload to R2, front it with a Worker for edge caching (this is required, not optional — browsers cannot cache range requests). Set CORS with `Range` allowed and `ETag` exposed. Version the filename by build date.
- Draw-a-polygon search via `maplibre-gl-draw`, with the polygon handed to PostGIS `ST_Contains` server-side.
- Static thumbnails rendered once per listing with MapLibre GL Native (outside the Vercel runtime), cached immutably.

**Defer:**
- Canada Post AddressComplete — 50–150× the cost of the open-data route, and it solves postal deliverability, which Portage does not currently need.
- Any paid managed tile plan — revisit only if self-hosting proves operationally annoying, and revisit it as Stadia, not Mapbox or Google.
- Nationwide expansion of the tile extract — trivially handled later by re-running `pmtiles extract` with a bigger bbox.
- Satellite/aerial imagery — a genuinely different (and expensive) licensing conversation. Do not let it into scope early.

**One thing to verify before committing:** actually measure the Regina extract size and the OSM address-point coverage for Regina. Both are ten-minute checks, both are marked UNVERIFIED above, and both are load-bearing for the recommendation.
