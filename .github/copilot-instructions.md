# GPX Toolkit — Copilot instructions

A **backend-free**, framework-free browser SPA (vanilla TypeScript + DOM) to explore, map,
analyze and export bike rides from multiple **sources**, and batch-upload **Beeline Velo 2**
rides to **Strava**. Sources sit behind a `RideSource` seam ([src/source.ts](../src/source.ts))
and their rides **coexist in one unified store**:

- **Beeline account** ([src/beeline-api.ts](../src/beeline-api.ts) +
  [src/beeline-source.ts](../src/beeline-source.ts)) — talks to Beeline's own Firebase cloud
  backend over `fetch`: one request returns the **whole** history (routes, stats, Strava
  status); uploads run server-side and **concurrently**. CORS-friendly, no proxy.
  `capabilities = { upload: true, import: false }`.
- **GPX files** ([src/gpx-source.ts](../src/gpx-source.ts)) — imports user-supplied `.gpx`
  files and `.zip` bundles (drag-and-drop or picker) as rides, deriving metrics from the
  recorded track locally. No account, no upload. `capabilities = { upload: false, import: true }`.

The Beeline source has a demo ([src/beeline-demo.ts](../src/beeline-demo.ts)) for exploring
without an account. Everything runs in the browser; ride state is cached in **one unified**,
**versioned** IndexedDB blob (`gpx-toolkit-state:all`, `schema` + `migrate()` in
[src/store.ts](../src/store.ts)), each ride tagged by `source`. There is no server.

**Data vs cache (Android-style):** full-GPX blobs live in two physically separate
[`GpxCache`](../src/gpxcache.ts) stores — a re-fetchable **cache** (`cache` prefix: Beeline
downloads, safe to flush) and a primary **data vault** (`data` prefix: imported GPX
originals, the only copy). The Controller routes every per-ride GPX read/write through
`blobFor(uid)` (gpx-source rides → data vault, else → cache); `flushGpxCache()` clears the
cache ONLY, so an imported GPX's bytes can never be destroyed by a cache flush (only by
deleting the ride or a full `reset()`). Don't store re-derivable data in the data vault, or
irreplaceable data in the cache.

**Multi-source identity:** a ride's cross-source identity is the uid `${source}::${identity}`
([`rideUid`/`splitUid`](../src/parsing.ts)). For **Beeline** the identity is the ride's
`${datetime}` (its start instant genuinely IS its identity); for **GPX** it is a **content hash**
of the file bytes (`gpx::sha256:<128-bit>`, minted in [`GpxRideSource`](../src/gpx-source.ts) —
`contentId`), so two distinct files that share a start minute stay distinct rides and re-importing
the same bytes is idempotent. Either way a record's own `key` stays the bare **datetime** (carried
explicitly on the card via `RideCard.identity` vs `RideCard.key`, and set through `Store.upsert`'s
`key` field) so all date/month bucketing is unchanged. The Store, GPX cache and UI `data-key` work
in uids; **never reconstruct a uid as `rideUid(source, datetime)`** (true only for Beeline) — read
the real Store Map key (`controller.state()` iterates `rides.entries()`). The `RideSource` seam
speaks each source's **own key** in its namespace (datetime for Beeline, content hash for GPX); the
Controller translates uid↔key at the boundary and dispatches each ride's action to that ride's
source (grouping by `splitUid(uid).source`). Source-dependent actions are gated per ride by
`capabilities` (e.g. Upload to Strava shows only on Beeline rides; a bulk upload over a mixed
selection acts on the upload-capable subset and reports the rest as skipped). Storage-key strings
and internal `beeline-*` module names are kept stable (persistence ids) despite the "GPX Toolkit"
product framing.

**No source "mode".** The app is ONE library over the unified store; there is no per-source
mode. It boots straight into the library (`openApp()`); a first-ever launch shows the **Sources**
dialog (`showSources({welcome:true})`, once, gated by `WELCOMED_KEY`) with an onboarding intro,
and the same dialog is re-openable any time from the header **Sources** button to connect/manage
sources. All Beeline/Strava chrome is driven off **real signals**, never a mode flag: connection
state + "Pull from Beeline" show when Beeline is in use (`usesBeeline` = connected/demo/has-
Beeline-rides/remembered-profile); upload chrome + Strava-status filter show when any ride is
`can_upload`; the Destination/Named filter chips show only when Beeline rides exist. Don't
reintroduce a `currentSource`/`beelineMode` switch — gate UI on capabilities/connection instead.

### Beeline credentials — never store the password

The Beeline password is used **once** at sign-in to get a short-lived in-memory token; it is
**never persisted** (and neither is the token — it's gone on reload). Only the email + "last
used Beeline" flag are remembered. On reload the app enters an **offline, cached-rides** mode
and only re-prompts for the password when an action actually needs the account (Re-sync,
upload) — so the user's **password manager** injects it on demand (`withBeelineAccess` defers
the action behind a focused re-auth picker; the deferred action runs once sign-in succeeds).
Preserve this: don't add password persistence, and keep cloud actions gated through
`withBeelineAccess`.

## Review & challenge the request

Don't implement blindly. Before acting, review the request critically and surface obviously
suboptimal or self-contradictory decisions instead of silently complying.

- **Push back when it's warranted**: if an instruction is unworkable, contradicts itself, fights
  the existing architecture, or there's a clearly better approach, say so and explain why.
- **Ask, don't guess**: when a request is ambiguous or a decision looks wrong, ask a focused
  question before writing code — a short clarification beats a confident wrong implementation.
- **Be direct, not contrarian**: only challenge real problems; once aligned, commit fully. The
  goal is the best outcome, not deferring to whatever was asked first.

## Core values

These are the defaults every change is judged against — prefer them over cleverness, and call
out when a request pushes against them (see *Review & challenge the request*).

- **Simplicity first.** The smallest change that fully solves the problem wins. Don't add
  features, layers, options, or abstractions that weren't asked for and aren't needed yet. No
  speculative generality — solve the case in front of you, not an imagined future one. A short,
  obvious implementation beats a flexible-but-intricate one; if a helper or config knob earns
  its keep only once, inline it.
- **Reuse before you write.** Before adding code, look for an existing function, type, CSS class,
  or pattern that already does the job and use (or lift) it. One canonical implementation per
  concern — when the same logic would live in two places, extract a shared, rendering-agnostic
  helper and have both call it (e.g. the `bucketRide` date bucketer, the `AreaSelect` gesture
  controller shared by the Map and heatmap, `renderMatchedCards()` shared by both ride lists).
  Two copies means two behaviours means a bug; duplication is a smell, not a shortcut.
- **One unified design language.** The app should look and behave like one product, not a pile of
  screens. Reuse the established visual vocabulary — the dark desaturated basemap treatment,
  the `.ms-matched`/`.ms-item` ride cards, the click-through `.fchip` filters, the shared range
  slider, accent colours and spacing — rather than inventing a one-off style. The same
  interaction (selecting, filtering, listing rides) should work the same way everywhere it
  appears. When you add a surface, first ask which existing component or class already expresses
  it; introduce new styling only when nothing fits, and then make it reusable. **Size shared
  controls from ONE place** — buttons, chips, segmented controls and fields inherit their
  height / padding / radius / font from the `--ctrl-*` design tokens (`--ctrl-pad-y/x`,
  `--ctrl-font`, `--ctrl-radius`, the `-sm` compact variants, `--tap-min`) via the canonical
  recipes (`button` / `button.small`, `.fchip`, `.seg`, `.custom`, the `--tap-min` header
  icon-square), never ad-hoc per-element px. A one-off button size is exactly how visual
  drift starts; if you catch yourself writing a literal height/padding/radius on a control,
  reach for (or extend) the `--ctrl-*` token or its shared class instead, and bring its
  siblings along.
- **Proactively keep the UI aligned with itself.** Consistency is an active duty, not a one-off.
  When you touch one surface, look at its siblings and bring them along: if one filter becomes a
  click-through chip, the rest should be chips too (the Strava + Source filters were converted
  from segmented `.seg` controls to match the chip row); if one button loses its label or gains
  an icon, its row-mates should match. Don't leave a half-migrated bar where one control is the
  odd one out. When you're unsure whether a change fits the established language, ask before
  inventing — a quick question beats a one-off that someone later has to reconcile.
- **No redundancy.** Say each thing once. Don't show the same information twice (the selection
  count lives in one place, not a header chip *and* a dropdown label), don't offer the same
  action by two routes (one "Sources" entry point, not a duplicate "Add GPX files" button), and
  don't stack competing CTAs (one primary action visible at a time). A label that merely repeats
  what a filter, badge, or icon already conveys is clutter — cut it. Two affordances for one
  outcome is a smell, just like two copies of one function.
- **Simplify by consolidating, never by amputating.** Removing chrome must not remove capability.
  When you drop a control, make sure the same outcome is still reachable a cleaner way: the
  per-row Strava-status badge went away but the Strava-status *filter* still surfaces it; the
  per-group "Push pending" buttons went away but selecting the group + the bulk push still does
  it; the header buttons collapsed into one `⋯` menu but every action is still there. Lighter UI,
  identical power. If a simplification would actually lose a capability, call it out instead of
  silently dropping it.
- **Show only what applies (context-aware, gated on real signals).** Surface a control only when
  it can act on the rides in front of the user, and gate it on a real signal — never a mode flag.
  Beeline-only filters (Strava status, route/full-GPX presence, destination, named, deleted) hide
  in a GPX-only library; the Source chip appears only when >1 source coexists; the per-ride source
  marker shows only when the library mixes sources; "Push to Strava" shows only on upload-capable
  rides. Critically, this extends to **behaviour and copy**, not just visibility: a per-ride action
  must do the right thing *and say the right thing* for that ride's source — a GPX ride's delete
  must not claim to touch "your Beeline account" or demand a Beeline sign-in (gate per-ride via
  `withRideAccess(source, …)`, not a blanket `withBeelineAccess`). A control that's shown but
  inapplicable, or whose wording assumes the wrong source, is a bug.
- **Guide without overwhelming.** A first-time / empty state should orient the user (what sources
  are, the two ways in, a demo) in a few quiet lines — not a wall of text or a nag. Lead them to
  the next step, then get out of the way. Density is for the working surfaces, not the welcome.
- **Mobile-friendliness is non-negotiable — preserve it across every change.** This is a
  phone-first PWA; a feature that works on a wide desktop but is broken or unusable on a narrow
  viewport is NOT done. Every new surface must be verified at a phone width too. The header already
  collapses its action buttons to equal 32×32 icon squares (≤560px); overlays/menus must be
  reachable and dismissable with a thumb — prefer a full-width bottom sheet (with a scrim, a
  grabber, a visible close, sticky header and `env(safe-area-inset-bottom)` padding) over a tiny
  anchored dropdown on phones (see the global filter panel: desktop dropdown → mobile bottom
  sheet). Touch targets stay ≥ ~32px. When you touch layout/CSS, re-check the ≤768px and ≤560px
  media blocks so nothing regresses; if you can't verify a phone width, say so.

## Data ingestion integrity (read this first)

**This is the foundation — if numbers come in wrong, nothing else matters.** Every total,
filter, chart, record, and rollup in this app is downstream of one thing: turning each source's
raw figures into correct normalized numbers. A single mis-read value silently corrupts every
aggregate that touches it, and the user has no way to tell. Treat ingestion correctness as
non-negotiable, not a nicety.

Both sources hand us **structured numbers**, never localized display strings: the Beeline cloud
API returns SI fields (`totalDistance` in metres, `averageSpeed`/`topSpeed` in m/s, `movingTime`/
`duration` in ms — see [`mapBeelineRide`](../src/beeline-api.ts)), and a GPX ride derives its
metrics from the recorded track geometry. (An earlier build screen-scraped the Beeline app and
had to parse localized strings like `13,5km`; that source and its locale-aware string parsers are
gone — don't reintroduce string-to-number parsing on the ingestion path.)

Hard rules:

- **Normalize once, at the boundary.** Convert a source's raw figure into the app's canonical
  unit (`RideMetrics`: km, seconds, km/h, metres) exactly where the ride enters app state (the
  source mapper), then compute and display from those numbers. Downstream code consumes the
  normalized numbers — it must never re-derive a metric from a raw source field ad hoc.
- **`null` means unknown, not zero.** A metric that a source didn't report stays `null`
  (`blankMetrics`), distinct from a real `0`; only overwrite a stored metric when the incoming
  figure is actually known, so a partial update never clears a richer value.
- **Convert units explicitly at the mapper.** Every unit conversion (m→km, m/s→km/h, ms→s) lives
  in the source mapper, spelled out, so the constant and direction are auditable in one place.
- **Test the mapper, both present and absent.** Any change touching a source mapper or aggregation
  must keep coverage green for both a fully-populated ride and one missing fields (so `null`
  propagates, never a spurious `0`).

## Tech stack & commands

- **TypeScript 5.6** (strict), **Vite 6** (`base: "./"`, `target: "esnext"`), **Vitest 2** + **jsdom**, **leaflet** for maps.
- Beeline-account source: plain `fetch` to Beeline's Firebase backend (CORS-friendly, no proxy).
- `npm run dev` — Vite dev server (boots straight into the library; a first-launch welcome explains sources, and the Beeline source has a demo).
- `npm run build` — `tsc --noEmit` type-check **then** `vite build`. Always type-check before considering a change done.
- `npm test` / `npm run test:watch` — Vitest.
- **Never hand-edit `package-lock.json`.** It's a generated artifact (name, version, dependency
  tree and integrity hashes must stay mutually consistent). Whenever it needs to change — after a
  `package.json` `name`/`version` bump or any dependency change — regenerate it with npm:
  `npm install` (or `npm install --package-lock-only` to refresh the lockfile without touching
  `node_modules`), then review the diff. A manual edit risks a partial/inconsistent lockfile that
  `npm ci` will reject.

## Changelog

Maintain [CHANGELOG.md](../CHANGELOG.md) — an **internal** intent log (not public release notes).
Whenever you finish a logical change and its acceptance checks pass (`npm run build` + `npm test`
green), add an entry. This file is read by humans **and** the assistant as a compressed history of
decisions and values, so the "why" matters more than the "what".

- **One entry per logical change**, newest at the top. Squash `fixup!`-style follow-ups into the
  entry they belong to rather than adding a new one.
- **Capture intent**, not just the diff: the motivation, the decision, the trade-off — the context
  the terse commit message omits. Ground it in what the change actually did.
- **Format:**
  ```
  ## <short title>
  - **What:** one line — what changed.
  - **Why:** 1–2 lines — the motivation / decision / value behind it.
  ```

## Versioning

Bump the `version` in [package.json](../package.json) (semver `major.minor.patch`) as part of
the same change, so the build hash shown in the UI tracks a real version.

- **Patch** (`0.11.0` → `0.11.1`): bug fixes and small UI/layout corrections — do this
  **automatically** whenever the logical change is a fix, no need to ask.
- **Minor** (`0.11.1` → `0.12.0`): a new feature or user-visible capability.
- **Major**: reserved for breaking reworks — confirm with the user first.
- One bump per logical change, committed alongside the code + CHANGELOG entry.

  (e.g. `compact state & selection actions into menus`, `more resilient error handling`).
- **One commit per logical change.** Stage the related files and commit; don't bundle
  unrelated work.
- **Lower-case commit messages.** Write the commit subject in all lower case (e.g.
  `unify single-thumb sliders onto one styled .uslider component`), not Sentence/Title case.
  Only deviate for things that are inherently cased — proper nouns, acronyms, identifiers,
  filenames or code (`Strava`, `GPX`, `IndexedDB`, `RideSource`, `.uslider`). When the agent
  makes a commit, match this style.
- **Never push unless explicitly asked.** Pushing is a shared/irreversible action — always
  leave `git push` to the user unless they explicitly request it.
- **Don't commit unless explicitly asked.** Committing (and amending) is the user's call, not
  the agent's. Make the edits, run the gates (`npm run build` + `npm test`), then STOP and
  summarize — let the user review and decide. Only run `git commit`/`--amend` when the user
  explicitly asks ("commit this", "make a commit"). The guidance above about *how* to commit
  (one per logical change, lower-case message, version + CHANGELOG alongside) applies **when**
  the user has asked for a commit — it is not a licence to commit unprompted.

## Architecture / module map

UI → Controller → RideSource (registry) → BeelineApi / local GPX ; + JobQueue · Store.
The Controller is source-agnostic: it holds a `Map<SourceKind, RideSource>`, dispatches each
ride's action to that ride's source (via `splitUid`), and never touches a concrete backend.
`main.ts` builds one shared multi-source controller (GPX always registered; Beeline on sign-in).

**Maintain this table.** It is the canonical map of the codebase — when you add, split, rename,
or remove a `src/*.ts` module (or change what one is fundamentally responsible for), update the
relevant row in the **same change** (alongside the CHANGELOG entry). A stale map is worse than
none. The table is grouped by concern; keep new modules in the group they belong to.

*Core: UI · orchestration · source seam*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [index.html](../index.html) | App shell, markup, styles, Sources dialog (Beeline + GPX) | — |
| [src/main.ts](../src/main.ts) | UI entry: render + wiring, Sources dialog, re-auth gating, GPX import, Location-History import/drop, all views (Explore/Map/Stats/Wind-Speed/Wind-rose/Timeline) | `activate()`, `getRealController()`, `openApp()`, `goBeeline()`, `goGpx()`, `pullFromBeeline()`, `importGpxFiles()`, `importLocationHistory()`, `dropLocationHistory()`, `mountTimelineView()`, `mountClimateView()`, `withBeelineAccess()`, `showSources()` |
| [src/ridemap.ts](../src/ridemap.ts) | Full-screen single-ride route map: route colouring (height/speed/wind), elevation/speed profile, hover readout + wind dial. Depends on the app only via an injected `RideMapDeps` seam | `initRideMap()`, `openRideMap()`, `closeRideMap()`, `refreshOpenRideMapWind()` |
| [src/controller.ts](../src/controller.ts) | Orchestration + app state; source registry; per-ride dispatch; full-track cache; point wind climatology | `Controller`, `registerSource()`, `state()`, `runTask()`, `importGpx()`, `onImported()`, `getFullTrack()`, `getPointWind()` |
| [src/source.ts](../src/source.ts) | `RideSource` seam + capabilities + shared GPX/catalog types | `RideSource`, `SourceCapabilities`, `SourceKind`, `GpxFile`, `ImportResult`, `gpxFilename()` |

*Sources: Beeline account · local GPX*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/gpx-source.ts](../src/gpx-source.ts) | Pure-GPX `RideSource`: import `.gpx`/`.zip`, local metrics/export, **content-addressed identity** (`contentId` = SHA-256 of bytes) | `GpxRideSource`, `importFiles()`, `contentId()`, `parseGpxFilename()`, `extractGpxName()` |
| [src/beeline-api.ts](../src/beeline-api.ts) | Beeline cloud backend client + ride mapping | `signIn()`, `refreshSession()`, `fetchRides()`, `uploadRideToStrava()`, `mapBeelineRide()`, `BeelineSession` |
| [src/beeline-source.ts](../src/beeline-source.ts) | Account `RideSource` over the API (concurrent uploads) | `BeelineRideSource`, `BeelineApi`, `runPool()` |
| [src/beeline-demo.ts](../src/beeline-demo.ts) | Simulated Beeline backend for the account demo | `demoBeelineDeps()`, `DEMO_BEELINE_EMAIL` |

*Storage · caches · jobs*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/store.ts](../src/store.ts) | Unified, versioned IndexedDB blob, keyed by ride uid | `Store`, `SCHEMA_VERSION`/`migrate()`, `SETTINGS_SPEC`, `RideRecord` (incl. `tags`), `upsert()` (uid-normalized), `setTags()` |
| [src/gpxcache.ts](../src/gpxcache.ts) | Full-GPX blob store (re-fetchable `cache` vs. primary `data` vault) | `GpxCache` |
| [src/windcache.ts](../src/windcache.ts) | Compressed per-cell-day wind cache (IndexedDB blobs) | `WindCache`, `encodeCellDay()`, `decodeCellDay()`, `WIND_ENTRY_VERSION` |
| [src/kv.ts](../src/kv.ts) | Key/value + blob store seams (in-memory for tests, IndexedDB in prod) | `KeyValueStore`, `BlobStore`, `memoryBackend()`, `idbBackend()`, `idbBlobBackend()` |
| [src/jobs.ts](../src/jobs.ts) | Single-worker background queue with coalescing | `JobQueue`, `Task`, `TaskSnapshot` |

*Parsing · stats · filtering*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/parsing.ts](../src/parsing.ts) | Normalized metrics + ride-key/date + uid helpers | `blankMetrics()`, `rideDatetime()`, `beelineRideKey()`, `rideUid()`/`splitUid()`, `bucketRide()` |
| [src/stats.ts](../src/stats.ts) | Lifetime aggregation: totals, per-period records, biggest rides | `computeStats()`, `RideStats`, `PeriodRecord`, `StatsRide` |
| [src/filter.ts](../src/filter.ts) | Explore-list filters (incl. `source` + `tags` OR dimension) | `matchesFilters()`, `emptyFilters()`, `Filters` |
| [src/tags.ts](../src/tags.ts) | Canonical ride-tag normalization + case-insensitive comparison key + catalog | `normalizeTag()`, `tagKey()`, `collectTags()`, `addTag()`/`removeTag()`, `hasTag()` |

*Tracks · maps · geometry*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/track.ts](../src/track.ts) | GPS track decode/simplify/render (namespace-robust GPX parse) | `extractTrack()`, `extractFullTrack()`, `fullTrackSummary()`, `simplify()` |
| [src/mapview.ts](../src/mapview.ts) | Map-view geometry: pick drawable tracks + hover/overlap hit-testing | `ridesWithTracks()`, `nearestRides()`, `RideTrack`, `ProjectedTrack` |
| [src/heatmap.ts](../src/heatmap.ts) | Route-frequency heatmap geometry: viewport densify + heat points | `buildHeatPoints()`, `densifyTrack()`, `spacingForZoom()`, `HeatPoint` |
| [src/areaselect.ts](../src/areaselect.ts) | Rubber-band area-select gesture controller (shared by Map + heatmap) | `createAreaSelect()`, `AreaSelect`, `AreaSelectOptions` |
| [src/map-core.ts](../src/map-core.ts) | Shared interactive-basemap core: the canonical OSM credit, the dark-OSM big-map factory, the pseudo-fullscreen expand-toggle builder, and the shared track-hit/highlight constants (Map view + Stats heatmap) | `OSM_ATTRIBUTION`, `createInteractiveMap()`, `makeExpandToggle()`, `CLICK_PX`, `HOT_TRACK` |
| [src/map-view.ts](../src/map-view.ts) | Map view (`#mapView`): the all-rides translucent-track basemap, side panel, click/area selection + hover emphasis, locate, expand. Behind a `MapViewDeps` seam | `initMapView()`, `mountMapView()`, `setHot()`, `setSelected()`, `setMapExpanded`, `mapAreaSelect`, `mapLocate` |
| [src/stats-view.ts](../src/stats-view.ts) | Stats view (`#statsView`): lifetime totals + records (`computeStats`) and the route-frequency heatmap (viewport-densified, pan/zoom-cached `leaflet.heat` layer) + its area-select/locate/expand and "Selected" list. Behind a `StatsViewDeps` seam | `initStatsView()`, `mountStatsView()`, `setHeatExpanded`, `heatAreaSelect`, `heatLocate`, `showHeatHover()`, `renderHeatMatched()`, `clearHeatSelection()` |

*Wind / weather*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/weather.ts](../src/weather.ts) | Open-Meteo wind client: dataset selection, grid quantization, per-point sampling (along + cross-track components) | `pickDatasets()`, `datasetById()`, `sampleGridCells()`, `quantizeCell()`, `alongTrackComponentKmh()`, `crossTrackComponentKmh()`, `Dataset`, `CellDayWind`, `PointWind`, `RideWind` |
| [src/windspeed.ts](../src/windspeed.ts) | Wind-vs-speed analytics: ride segmentation (along + cross-track wind), regression, speed capping, wind colour ramps (crosswind magnitude + diverging head/tailwind) | `segmentRide()`, `linearRegression()`, `speedCapIndices()`, `crossColor()`, `alongColor()`, `WindSeg` |
| [src/windchart.ts](../src/windchart.ts) | Wind-vs-speed scatter plot (canvas render; the X axis is caller-chosen via `ChartOpts.xValue`/`xSigned`/`xCaption` — signed head/tailwind with tinted halves, or a one-sided magnitude; optional per-dot tint via `ChartOpts.dotColor`). Returns a hit-test layout so the view can map a pointer back to a dot + ring it on an overlay | `drawWindSpeedChart()`, `nearestDot()`, `drawDotHighlights()`, `makeScale()`, `niceTicks()`, `ChartOpts`, `ChartLayout`, `ChartDot` |
| [src/windspeed-view.ts](../src/windspeed-view.ts) | Wind/Speed view (`#analyticsView`): a confirm-to-run gate (centred card naming how many rides the window will analyse, live as the slider moves), the window-scoped per-ride segment sweep (cached, keyed on the segment-geometry tuning), distance-weighted regression, the scatter + KPI cards (labels adapt to the X axis) + empty/blocked states, the X-axis picker (head/tailwind ↔ crosswind) + generic colour-by picker (off / head-tailwind / crosswind, the X dimension auto-hidden) + legend + the unified min/max band filters (grade / speed / length / crosswind / headwind / tailwind, all cheap synchronous post-filters via the shared `readBand`/`bandLabel`), the end-user segment-tuning knobs (look-ahead / turn tolerance + Reset), and dot→ride discovery (hover tooltip on precise pointers; tap/click pins a dot → rings all of that ride's segments + a card below the chart that opens the ride in Explore). Behind a `WindSpeedDeps` seam | `initWindSpeedView()`, `mountWindSpeedView()`, `windSpeedVisibleRides()`, `syncColorByGating()`, `SEG_TUNE_DEFAULTS`, `WindSpeedDeps` |
| [src/windrose.ts](../src/windrose.ts) | Wind-rose climatology compute (pure): flatten cached cell-days → 16-sector × speed-bin rose, monthly breakdown, vector-mean; local-time-from-longitude | `flattenSamples()`, `roseFromSamples()`, `monthlyRoses()`, `sectorFractions()`, `WindRose`, `WindSample` |
| [src/climate-view.ts](../src/climate-view.ts) | Windalytics ("Wind rose" tab): isolated map view — click a point, pull a year-window of ERA5 wind via the `ClimateDeps` seam, render the rose, monthly small-multiples, month×direction heatmap + mean-wind arrow; dual-thumb year window + hour/month controls re-aggregate in memory | `initClimateView()`, `mountClimateView()`, `leaveClimateView()`, `ClimateDeps` |

*Location history (Timeline import)*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/locate.ts](../src/locate.ts) | Reverse-geocode helper (place names for tracks) | `createLocate()`, `Locate`, `LocateOptions` |
| [src/loc-model.ts](../src/loc-model.ts) | Location-history model: one normalized `LocRecord` per Google source + rich `LocSourceDef` provenance + precomputed profile | `LocRecord`, `LocKind`, `AccClass`, `LocSourceDef`, `LocProfile`, `LocImport` |
| [src/loc-parse.ts](../src/loc-parse.ts) | Parse a Google export into a `LocImport` (on-device Timeline implemented; legacy formats detected + rejected). Drops wifiScan MACs | `parseLocationHistory()`, `parseOnDevice()`, `parseLatLng()`, `detectFormat()` |
| [src/loc-codec.ts](../src/loc-codec.ts) | Columnar delta+zig-zag+varint codec for a month of records; lossless E7 coords; observable JSON header | `encodeChunk()`, `decodeChunk()`, `decodeHeader()`, `ChunkHeader` |
| [src/loc-store.ts](../src/loc-store.ts) | Month-chunked, gzipped persistence in its OWN `location-history` IDB store (separately droppable); in-memory catalog (extent, sources, per-month headers) | `LocationHistoryStore`, `LocCatalog`, `MonthSummary`, `monthKey()` |
| [src/timeline-view.ts](../src/timeline-view.ts) | Isolated Timeline map experience: dwell heatmap (with a draggable date-range window reusing the shared `.rf-*` slider), area-select "when was I here", day replay with a time slider. Injected `TimelineDeps` seam | `initTimelineView()`, `mountTimelineView()`, `leaveTimelineView()`, `resetTimelineData()`, `rangeSliderHtml()` |
| [src/timeline-geo.ts](../src/timeline-geo.ts) | Pure day-replay maths: time-sorted day samples + position interpolation for the scrubber | `buildDaySamples()`, `posAt()`, `dayKeyOf()` |

*Low-level utilities*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/reactive.ts](../src/reactive.ts) | Tiny reactive core: fine-grained signals + effects (~50 lines, no deps); replaces hand-rolled `lastSig` dirty-checking | `signal()`, `effect()`, `computed()` |
| [src/app-state.ts](../src/app-state.ts) | Shared app state as signals (the seam for decomposing `main.ts` into per-view modules); a view imports the shared state it needs | `activeView`, `setActiveView()`, `ViewName` |
| [src/confirm.ts](../src/confirm.ts) | Self-contained styled confirm / prompt / consent dialogs (promise-based, own DOM listeners via `initConfirm`); reuses the `.scrim`/`.modal-card` vocabulary | `confirmDialog()`, `promptDialog()`, `consentDialog()`, `initConfirm()` |
| [src/ui.ts](../src/ui.ts) | Render-layer design vocabulary: pure `(opts) => string` builders for shared components (one canonical markup + classes each); centralised HTML escaping | `escHtml()`, `statNum()` |
| [src/tz.ts](../src/tz.ts) | Ride-local time: lat/lon → IANA zone (lazy `tz-lookup`, code-split), and a start INSTANT → ride-local wall-clock key / hour / DST-correct offset via `Intl`; offset + city display helpers | `loadTz()`, `zoneForPoint()`, `localTime()`, `offsetMinutes()`, `formatOffset()`, `zoneCity()`, `browserZone()` |
| [src/slider.ts](../src/slider.ts) | Unified single-thumb range slider behaviour: drive the `.uslider` accent left-fill (`--fill`) from each input's value, so every single-thumb slider matches the dual-thumb `.rf-*` look | `setSliderFill()`, `initSliderFills()` |
| [src/zip.ts](../src/zip.ts) | Dependency-free ZIP build + read | `buildZip()`, `unzip()` |
| [src/gzip.ts](../src/gzip.ts) | Gzip compress/decompress (CompressionStream) | `gzip()`, `gunzip()` |
| [src/varint.ts](../src/varint.ts) | Variable-length int encode/decode (for compact caches) | `ByteWriter`, `ByteReader`, `zigzag()`, `unzigzag()` |
| [src/env.d.ts](../src/env.d.ts) | Vite env / asset type stubs | — |

## Conventions

- **Strict TS**: full null-safety, `noUnusedLocals`/`noUnusedParameters` are on — no dead vars/params, no implicit `any`.
- **Naming**: `camelCase` functions (verb-prefixed: `parse…`, `upload…`), `PascalCase` classes/interfaces, `snake_case` string constants for storage keys.
- **Types**: `interface` for public contracts (`RideSource`, `RideRecord`); type aliases / discriminated unions for state (e.g. `TaskStatus = "queued" | "running" | …`).
- **Comments**: module-level docstrings explain purpose & design; `// -- section ----` headers group blocks; inline comments explain **why**, not what.
- **Async-first**: everything is `async/await` (`fetch` is async). Never block.
- **Subscriptions**: `onChange(fn)` returns an unsubscribe function — always store and call it on teardown.
- **Immutable-ish state**: mutate the `Store` only via `store.upsert(key, partial)`; let the Controller emit a change event to re-render.
- **Deletion reconciliation is gated on a complete scan**: a ride known locally but absent from a freshly fetched history is only marked **deleted** when the scan ran to completion (`enumerateCatalog` returns a `complete` flag); a cancelled/partial scan never reconciles deletions.
- **Unified map look & feel**: both Leaflet basemaps — the Explore per-ride mini-maps (`.rmap`) and the all-rides Map view (`#allRidesMap`) — share one dark, desaturated tile treatment (`.leaflet-tile-pane { filter: grayscale(85%) brightness(.6) contrast(1.1) }` over a `#05070a` container) so colored tracks pop consistently. Keep the two filter rules in sync; mini-maps draw a single ride with a white casing + solid orange line for legibility, while the Map view uses translucent overlapping lines as a heatmap.
- **Floating map/heatmap controls are icon-only, drawn with inline SVG — never Unicode glyphs**: the Map view and the Stats route-frequency heatmap each carry the same two floating square buttons (`.map-expand` full-screen toggle + `.map-select` area-select), so they look and behave identically. Buttons are icon-only (34px square, centred 17px SVG, `stroke: currentColor`); the meaning lives in `aria-label`/`title`, not visible text. Icons **swap by state via CSS**, never by rewriting button content: `.map-expand` shows the maximize frame and flips to minimize on `[aria-pressed="true"]`; `.map-select` shows the dashed marquee and flips to an X on `.active`. Raw Unicode symbols (`⤢ ⤡ ▢ ✕ ▸ ▾` …) render inconsistently across fonts/DPI and are banned here — add a new SVG glyph (or reuse the CSS-border chevrons used by split buttons/disclosures) instead. `createAreaSelect` (in [areaselect.ts](../src/areaselect.ts)) owns only the button's `.active`/`aria-pressed`/`aria-label`, leaving the glyph swap to CSS so the icon-only markup survives.
- **Map and heatmap share one full-screen pattern**: a CSS pseudo-fullscreen (no `requestFullscreen` API) where the container goes `position: fixed; inset: 0; z-index: 60` under a body class — `body.map-expanded .map-wrap` for the Map view, `body.heat-expanded .freq-wrap` for the heatmap. Each toggle (`setMapExpanded`/`setHeatExpanded` in [main.ts](../src/main.ts)) flips the body class, sets the button's `aria-pressed`, and calls `invalidateSize()` so Leaflet re-measures. Both exit on **Esc** and when switching away from their view (in `applyView`). Keep the two in lockstep when touching either.
- **Map and heatmap share one column layout — controls live in flow, never overlaying the basemap**: the Map view's `.map-main` and the heatmap's `.freq-main` are both **flex columns** (`display: flex; flex-direction: column`) whose Leaflet container (`#allRidesMap` / `#freqHeatMap`) is `flex: 1; min-height: 0` so it fills the space, and any control sits **below** it in normal flow rather than as an `position: absolute` overlay. This keeps Leaflet's own controls in their defaults (zoom top-left, attribution bottom-right) and guarantees the required "© OpenStreetMap contributors" credit is never covered. Both date filters use the **same** `.basemap-filter` class and sit in flow beneath their map — `#mapFilter` under `#allRidesMap`, `#statsFilter` under `#freqHeatMap` — never a floating bar. (The Stats filter still scopes the *whole* stats body — totals, records and the heatmap — even though it now lives below the heatmap to match the Map view.) The only things that *do* float over the basemap are the two icon-only buttons (`.map-expand`/`.map-select`, top-right) and the rubber-band selection rect. Keep the two `-main` containers in lockstep: a control added below one map should drop into the other identically.
- **Aligned group-header indicators**: in the year/month group headers (`.yhead`/`.mhead`), the title column (`.ytitle`/`.mtitle`) is fixed-width (`flex: 0 0 auto; min-width; white-space: nowrap`) so the progress bar (`.bars`, itself a fixed 90px) and the meta text start at the same x across every sibling row. Variable-length labels ("May 2026" vs "September 2026") must NOT push the bars/meta around or wrap — ragged indicators read as heavy and add cognitive parsing load. When adding columns to these headers keep them fixed-width so the row reads as aligned columns.
- **Status/progress messages**: say exactly WHAT is happening and WHY, verbosely if needed — never vague counts. When acting on a specific ride, name it with the params we know (e.g. `rideShortLabel(key)` → "Jun 13 14:22"), not "1 ride". Prefer "scrolling down to find Jun 13 14:22…" over "scrolling down — looking for 1 ride…". When several rides are involved, name the first couple and append "(+N more)".
- **Error handling**: surface failures to the user via `toast(message, isError)` / `pushError()` and a persistent error card rather than crashing; wrap `localStorage` access in `try/catch` (private mode can throw — non-fatal).

## Domain notes

- **Expected data volume**: design and review every aggregate/render path for a power user's
  lifetime — **several thousand rides** and **tens of thousands of km** ridden. This is the
  target scale, not an edge case: totals, filters, stats, the map and the route-frequency
  heatmap must stay responsive at that size. Concretely — never materialise per-metre points
  for the whole dataset at once (the heatmap densifies only the visible viewport for exactly
  this reason), keep per-ride work O(1)-ish, and prefer culling/caching over recomputing the
  full set on every interaction. When adding a feature that scans all rides, sanity-check its
  cost against thousands of tracks before considering it done.
- **Ride keys** are human dates like `"Sat Jun 13 2026 at 14:22"`; months are `"2026-06"` / `"June 2026"`. `beelineRideKey(startMs)` builds one from a Beeline ride's start instant; `rideDatetime()` is its inverse. A ride's `key` is its **display datetime** for all bucketing — distinct from its storage **uid** (`${source}::${identity}`): Beeline's identity is the datetime, but a GPX ride's is a content hash, so for GPX `key` ≠ the uid suffix.
- **Reference date is the ONLY axis for ordering/bucketing/filtering — never the uid.** A ride's
  **reference date** is its display datetime (`RideView.date_key`, `RideRecord.key`); the uid/`RideView.key`
  is **identity only**. Every sort, month/period bucket, date-range filter, granularity pick and date
  label MUST read the reference date — never parse a date out of a uid (a GPX uid is a content hash and
  yields `null`, which is exactly what sorted imports after all Beeline rides and printed raw hashes as
  labels). Sources of the reference date: **Beeline** → the server start instant; **GPX** → the track's
  first `<time>`, else a `YYYY-MM-DD` filename prefix, else the **upload instant** — stamped once on first
  import and stable across idempotent re-imports (`Store.upsert` only sets `key` when the record is new).
- **User-facing ride labels are name-driven, never the uid.** Use `rideLabel(name, dateKey)` (parsing) or
  the controller's `uidLabel(uid)` — they return "Name (Jun 13, 2026, 14:22)" and degrade to name / date /
  "ride", but NEVER surface a `gpx::sha256:…` identity. For GPX the name comes from `<name>` → filename →
  time-of-day and is user-editable.
- **Job coalescing**: consecutive `upload`/`status`/`download-gpx` tasks merge into one sweep — preserve this when touching `JobQueue`.
- Only the **Strava** upload path is automated (komoot is detected but left alone).

## Testing

- Tests live in `tests/**/*.test.ts` (Vitest + jsdom).
- **Source tests** drive `BeelineRideSource` against an in-memory fake `BeelineApi` (no network), and a captured backend response in [tests/fixtures/beeline/](../tests/fixtures/beeline/).
- Inject an instant `sleep` and a `memoryBackend()` store — don't touch real `localStorage` or wall-clock delays in tests. Wait for async work with `await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false))`.
- **Demo GPX downloads never trigger a browser "Save As"**: `saveGpxFile()` in [src/main.ts](../src/main.ts) short-circuits when `isDemo` (demo bytes are synthetic; the route is still drawn on the map from the stored track). This keeps the browser-driven demo/test flow prompt-free. Preserve this guard when touching the GPX save path.

## Gotchas

- Keep new code dependency-light — this app intentionally has no backend and a tiny dependency set.
- The `RideSource` seam is kept deliberately even though Beeline is the only implementation; if you add a source, code to the interface and never let the Controller touch a concrete backend.
- **`position: fixed` breaks inside the header.** `<header>` has `backdrop-filter: blur()`, which (like `transform`/`filter`/`will-change`) makes it the *containing block* for `position: fixed` descendants — a fixed element inside it is positioned relative to the HEADER box (top strip of the page), NOT the viewport. A mobile bottom sheet authored inside the header pins to the top and overlaps content. Fix: render full-screen/viewport-anchored overlays at `<body>` level (the global filter panel is moved to `<body>` at runtime by `initFilterPanel`, then JS-anchored under its button on desktop and CSS-pinned to the viewport bottom on mobile). Never assume `position: fixed` is viewport-relative without checking for a transformed/filtered ancestor.
