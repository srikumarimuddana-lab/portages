# Design canvas

Source for the Portage product design canvas.

**Live canvas:** https://claude.ai/code/artifact/23bf3660-ffb7-4fe5-8499-968025291eb3

## Files

Nine artboards across three canvas pages.

### Public

| File | What it is |
|---|---|
| `Main.dc.html` | Listing detail, desktop (1280px). Three live tabs. |
| `Mobile.dc.html` | The same page at phone width (390px). |
| `Search.dc.html` | Search results — filter bar, result grid, map rail with price bubbles. |

### Owner

| File | What it is |
|---|---|
| `OwnerListings.dc.html` | Your listings, with per-listing performance and publish blockers. |
| `Inbox.dc.html` | Messages — thread list and conversation, including the blocked-message case. |

### Admin

| File | What it is |
|---|---|
| `AdminQueue.dc.html` | Moderation queue, ordered by risk then age. |
| `AdminReview.dc.html` | Single-item decision screen; toggles between listing and message review. |
| `AdminOps.dc.html` | Supply funnel, health tiles, moderation rates, audit log, kill switches. |

### Shared

| File | What it is |
|---|---|
| `Icon.dc.html` | The stroke-icon set — 25 glyphs on a 24px grid, one weight. |
| `canvas.json` | Layout for all nine, three pages, and the canvas notes. |

The admin screens are designed against `analysis/10-admin-dashboard.md`, which
sizes the moderation load and lists what is missing from the backend.

The seeded `portage-listing-detail.html` is **not committed**: it is 2.5 MB of
editor payload regenerated from these source files in one command, and a
generated artifact that large has no business in the history.

## Design system

Lifted from the original `Portage_Real_Estate_standalone.html` prototype, not
invented:

- **Type** — Golos Text; headings at 800, prices at 900, `-0.02em`
- **Accent** — `#356dbe`, with the 100–900 scale (`#eaf1fb` … `#14304f`)
- **Neutrals** — `#f8f9fb` … `#12151c`; background `#fafbfe`, surface `#ffffff`,
  divider `#e6e8ee`
- **Radii** — 10 / 16 / 24px, pills at 999px
- **Shadows** — `0 2px 10px rgba(16,24,40,.07)` · `0 10px 30px rgba(16,24,40,.11)`
- **Buttons** — `10px 18px`, 14px/600, pill
- **Segmented control** — 4px padding, 3px gap, surface fill, 1px divider border

Icon tiles use six hues at one fixed chroma and lightness
(`oklch(0.95 0.045 H)` on `oklch(0.44 0.125 H)`), so eight coloured tiles read
as one family rather than a paintbox.

## Regenerating

```bash
node "<design skill base>/seed-canvas.mjs" \
  --template "<design skill base>/payload.template.html" \
  --out portage-listing-detail.html \
  --title "Portage Product Design" \
  --artboard Main.dc.html --artboard Mobile.dc.html --artboard Search.dc.html \
  --artboard OwnerListings.dc.html --artboard Inbox.dc.html \
  --artboard AdminQueue.dc.html --artboard AdminReview.dc.html \
  --artboard AdminOps.dc.html --artboard Icon.dc.html \
  --canvas canvas.json
```

Then republish that file to the artifact URL above. Editing the canvas in the
browser and saving publishes a new version there — those edits do **not** flow
back into these files, so pull them back with `seed-canvas.mjs --extract`
before changing anything here.

## Adaptations from the 99acres reference

The reference was 99acres' listing page. Three things changed deliberately:

1. **No tenant-preference field.** 99acres shows "Available For: Family,
   Bachelors (Men Only)". The Saskatchewan Human Rights Code prohibits
   refusing housing on family status, sex, marital status, age or source of
   income, so an "Everyone may apply" panel sits where that field would be.
   This must hold on the listing form and in search filters too.
2. **RERA → what Portage can assert.** The Indian regulator badge becomes
   *Owner-direct · 0% commission* and *Email verified*.
3. **Society → Neighbourhood.** Their tab assumes a gated development; ours is
   fed by the gazetteer's boundaries and the four `neighbourhood_scores` kinds.

## Still placeholder

- Photos are blocked out — no Regina imagery yet.
- Score values (78 / 84 / 91 / 72) are illustrative. Real ones come from
  Regina Transit GTFS and City of Regina open data.
- "Owner active 2 days ago" needs a last-seen field that does not exist.
- The gallery is four thumbnails; no lightbox is designed.
