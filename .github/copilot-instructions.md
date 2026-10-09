# GPX Toolkit: instructions for coding agents

This is the canonical instruction file for every coding agent in this repository;
[AGENTS.md](../AGENTS.md) only points here. Keep durable guidance in this file. The
human-facing docs are [README.md](../README.md) and
[docs/architecture.md](../docs/architecture.md).

## How to work

### Review and challenge the request

Don't implement blindly. Before acting, review the request critically and surface obviously
suboptimal or self-contradictory decisions instead of silently complying.

- **Push back when it's warranted.** If an instruction is unworkable, contradicts itself,
  fights the existing architecture, or there's a clearly better approach, say so and
  explain why.
- **Ask, don't guess.** When a request is ambiguous or a decision looks wrong, ask a
  focused question before writing code. A short clarification beats a confident wrong
  implementation.
- **Be direct, not contrarian.** Only challenge real problems; once aligned, commit fully.
  The goal is the best outcome, not deferring to whatever was asked first.

### Core values

Every change is judged against these. Prefer them over cleverness, and call out when a
request pushes against them.

- **Simplicity first.** The smallest change that fully solves the problem wins. Don't add
  features, layers, options or abstractions that weren't asked for and aren't needed yet.
  No speculative generality: solve the case in front of you, not an imagined future one. A
  short, obvious implementation beats a flexible but intricate one; if a helper or config
  knob earns its keep only once, inline it.
- **Reuse before you write.** Before adding code, look for an existing function, type, CSS
  class or pattern that already does the job and use (or lift) it. One canonical
  implementation per concern: when the same logic would live in two places, extract a
  shared, rendering-agnostic helper and have both call it (e.g. the `bucketRide` date
  bucketer, the `AreaSelect` gesture controller shared by the Map and heatmap,
  `renderMatchedCards()` shared by both ride lists). Two copies means two behaviours means
  a bug.
- **One unified design language.** The app should look and behave like one product, not a
  pile of screens. Reuse the established vocabulary (the dark desaturated basemap, the
  `.ms-matched`/`.ms-item` ride cards, the click-through `.fchip` filters, the shared range
  slider, accent colours and spacing) instead of inventing a one-off style, and make the
  same interaction (selecting, filtering, listing rides) work the same way everywhere. When
  you add a surface, first ask which existing component already expresses it; add new
  styling only when nothing fits, and then make it reusable. If you're unsure whether
  something fits, ask before inventing.
- **Keep the UI aligned with itself.** Consistency is an active duty. When you touch one
  surface, bring its siblings along: if one filter becomes a click-through chip, the rest
  become chips too (the Strava and Source filters were converted from `.seg` controls to
  match the chip row); if one button loses its label or gains an icon, its row-mates
  match. When a fix or convention has obvious siblings (the other selection actions, the
  other filter chips, the Map vs heatmap pair, the two basemap filter rules), apply it to
  all of them in the same change or ask whether it should span. Never leave a half-migrated
  bar. If you agree a broader rule with the user, record it in this file.
- **No redundancy.** Say each thing once. Don't show the same information twice (the
  selection count lives in one place, not a header chip *and* a dropdown label), don't
  offer the same action by two routes (one "Sources" entry point, not a duplicate "Add GPX
  files" button), and don't stack competing calls to action (one primary action visible at
  a time). A label that only repeats what a filter, badge or icon already says is clutter.
- **Simplify by consolidating, never by amputating.** Removing chrome must not remove
  capability. When you drop a control, make the same outcome reachable a cleaner way: the
  per-row Strava badge went away but the Strava-status *filter* still surfaces it; the
  per-group "Push pending" buttons went away but selecting the group and the bulk push
  still do it; the header buttons collapsed into one `⋯` menu but every action is still
  there. If a simplification would lose a capability, call it out.
- **Show only what applies, gated on real signals.** Surface a control only when it can act
  on the rides in front of the user, and gate it on a real signal, never a mode flag.
  Beeline-only filters (Strava status, route/full-GPX presence, destination, named,
  deleted) hide in a GPX-only library; the Source chip appears only when more than one
  source coexists; the per-ride source marker shows only in a mixed library; "Push to
  Strava" shows only on upload-capable rides. This covers **behaviour and copy** too: a
  GPX ride's delete must not mention "your Beeline account" or demand a Beeline sign-in
  (gate per ride with `withRideAccess(source, …)`, not a blanket `withBeelineAccess`). A
  control that is shown but inapplicable, or worded for the wrong source, is a bug.
- **Guide without overwhelming.** A first-time or empty state orients the user (what
  sources are, the two ways in, a demo) in a few quiet lines, not a wall of text or a nag.
  Lead to the next step, then get out of the way. Density is for the working surfaces.
  A view with nothing to show is one `.pane-empty` (centred both ways in the pane) whose
  body is an `.onb` (optional `.onb-title`, `.onb-lede`, `.onb-cta` buttons), never a
  left-aligned box; every empty view (Explore, Stats, Wind vs speed, Timeline, Routes)
  uses it.
- **Mobile is non-negotiable.** This is a phone-first PWA: a feature that works on a wide
  desktop but breaks on a narrow viewport is not done. Verify every new surface at a phone
  width (see [Mobile](#mobile)); if you can't, say so.

### Before you call a change done

1. `npm run verify` passes (type-check, Biome lint and format check, tests; exactly what
   CI runs), and so does `npm run build`.
2. Layout or CSS changes are checked at a phone width and in both themes.
3. The [module map](#module-map) is updated if you added, split, renamed or removed a
   module or changed what one is responsible for.
4. The change has a [CHANGELOG](#changelog) entry and a
   [version bump](#versioning-and-the-lockfile), with the lockfile regenerated.
5. Then stop and summarize. Commit or push only when asked (see [Commits](#commits-and-pushes)).

### Scratch workspace

- Put every temporary artifact (previews, screenshots, experiments, generated diagnostics,
  disposable downloads) under `.tmp/YYYYMMDD-topic/`, with the current date and a short
  kebab-case topic, e.g. `.tmp/20260920-forecast-marker/`.
- `.tmp/` is gitignored. Never put scratch material in `.codex/`, the repository root,
  source directories, ad hoc `work/` or `tmp/` directories, or documentation directories
  where it would look like a product change.
- Keep one dated directory per task with all related artifacts together. Keep these
  directories as local history; delete one only when the user asks. Files that ship belong
  in their normal tracked location, not `.tmp/`.

### Changelog

[CHANGELOG.md](../CHANGELOG.md) is an **internal** intent log, not public release notes.
Humans and agents read it as a compressed history of decisions and values, so the "why"
matters more than the "what". Add an entry when a logical change is finished and its gates
pass.

- **One entry per logical change**, newest at the top. Fold `fixup!`-style follow-ups into
  the entry they belong to.
- **Capture intent**, not just the diff: the motivation, the decision, the trade-off, the
  context the terse commit message omits. Ground it in what the change actually did.
- **Format:**
  ```
  ## <short title>
  - **What:** one line: what changed.
  - **Why:** 1–2 lines: the motivation, decision or value behind it.
  ```

### Versioning and the lockfile

Bump `version` in [package.json](../package.json) (semver) in the same change, so the build
hash shown in the UI tracks a real version. One bump per logical change, committed with the
code and the CHANGELOG entry.

- **Patch** (`0.11.0` → `0.11.1`): bug fixes and small UI or layout corrections. Do this
  automatically for any fix; no need to ask.
- **Minor** (`0.11.1` → `0.12.0`): a new feature or user-visible capability.
- **Major**: breaking reworks only; confirm with the user first.

**Never hand-edit `package-lock.json`, and never leave it stale.** Its name, version,
dependency tree and integrity hashes must stay consistent, so **any** change to
`package.json` (the routine version bump, a rename, a dependency change) needs the
lockfile regenerated **in the same change**: run `npm install --package-lock-only` (leaves
`node_modules` alone) or `npm install`, review the diff, and check the lockfile's `version`
matches. A hand edit or a forgotten regeneration leaves a lockfile that `npm ci` rejects.

### Commits and pushes

- **Commit only when asked.** Committing and amending are the user's call. Make the edits,
  run the gates, then stop and summarize. Run `git commit` or `--amend` only on an explicit
  request ("commit this", "make a commit"). The rules below describe *how* to commit once
  asked; they are not a licence to commit unprompted.
- **Push only when asked.** Pushing is shared and hard to undo; leave `git push` to the
  user unless they explicitly request it.
- **One commit per logical change.** Stage the related files together; don't bundle
  unrelated work.
- **Short, lower-case subject that names the intent**, e.g.
  `compact state & selection actions into menus` or
  `unify single-thumb sliders onto one styled .uslider component`. Keep inherently cased
  words as they are: proper nouns, acronyms, identifiers, filenames and code (`Strava`,
  `GPX`, `IndexedDB`, `RideSource`, `.uslider`).

## How the app works

### Overview

A **backend-free**, framework-free single-page app (vanilla TypeScript and the DOM) to
explore, map, analyze and export bike rides from several **sources**, and to batch-upload
**Beeline Velo 2** rides to **Strava**. Everything runs in the browser; there is no server.
Sources sit behind the `RideSource` seam ([src/source.ts](../src/source.ts)):

- **Beeline account** ([src/beeline-api.ts](../src/beeline-api.ts),
  [src/beeline-source.ts](../src/beeline-source.ts)) talks to Beeline's Firebase backend
  over `fetch` (CORS-friendly, no proxy). One request returns the **whole** history
  (routes, stats, Strava status); uploads run server-side and concurrently.
  `capabilities = { upload: true, import: false }`. A simulated backend
  ([src/beeline-demo.ts](../src/beeline-demo.ts)) powers the demo.
- **GPX files** ([src/gpx-source.ts](../src/gpx-source.ts)) imports `.gpx` files and `.zip`
  bundles (drag-and-drop or picker) and derives metrics from the recorded track locally.
  No account, no upload. `capabilities = { upload: false, import: true }`.

The Controller is source-agnostic: it holds a `Map<SourceKind, RideSource>`, sends each
ride's action to that ride's source, and never touches a concrete backend. `main.ts` builds
one shared controller (GPX always registered, Beeline on sign-in). If you add a source,
code to the `RideSource` interface.

### One library, no source mode

Rides from every source live in **one unified store**, each tagged with its `source`.
There is no per-source mode. The app boots straight into the library (`openApp()`); the
first-ever launch shows the **Sources** dialog with an onboarding intro
(`showSources({welcome:true})`, once, gated by `WELCOMED_KEY`), and the same dialog is
always reachable from the sidebar footer's **Sources** entry (inside the **More** sheet on
a phone).

All Beeline and Strava chrome follows **real signals**: the connection state and "Pull
from Beeline" show when Beeline is in use (`usesBeeline`: connected, demo, has Beeline
rides, or a remembered profile); upload chrome and the Strava-status filter show when any
ride is `can_upload`; the Destination and Named chips show only when Beeline rides exist.
Source-dependent actions are gated per ride by `capabilities`: a bulk upload over a mixed
selection acts on the upload-capable subset and reports the rest as skipped. Don't
reintroduce a `currentSource`/`beelineMode` switch.

### Ride identity, dates and labels

- **Identity is the uid** `${source}::${identity}` (`rideUid`/`splitUid` in
  [src/parsing.ts](../src/parsing.ts)). For Beeline the identity is the ride's start
  datetime; for GPX it is a **content hash** of the file (`gpx::sha256:<128-bit>`, minted by
  `GpxRideSource.contentId`), so two files that start in the same minute stay separate and
  re-importing the same bytes is a no-op.
- The Store, the GPX cache and the UI's `data-key` all work in uids. **Never reconstruct a
  uid as `rideUid(source, datetime)`** (that only holds for Beeline); read the real Store
  key (`controller.state()` iterates `rides.entries()`). The `RideSource` seam speaks each
  source's **own key** (datetime for Beeline, content hash for GPX); the Controller
  translates uid ↔ key at the boundary and groups actions by `splitUid(uid).source`.
- **The reference date is the only axis for ordering, bucketing and filtering.** A ride's
  `key` (`RideRecord.key`, `RideView.date_key`) is its display datetime, a human date like
  `"Sat Jun 13 2026 at 14:22"`; months are `"2026-06"` / `"June 2026"`. `RideCard.identity`
  vs `RideCard.key` keeps the two apart, and `Store.upsert`'s `key` field sets it. Every
  sort, month or period bucket, date-range filter, granularity pick and date label reads
  the reference date; never parse a date out of a uid (a GPX uid yields `null`, which once
  sorted imports after every Beeline ride and printed raw hashes as labels).
- **Where the reference date comes from.** Beeline: the server's start instant
  (`beelineRideKey(startMs)` builds the key, `rideDatetime()` is its inverse). GPX: the
  track's first `<time>`, else a `YYYY-MM-DD` filename prefix, else the **upload instant**,
  stamped once on first import and stable across re-imports (`Store.upsert` only sets `key`
  on a new record).
- **User-facing labels are name-driven, never the uid.** Use `rideLabel(name, dateKey)`
  (parsing) or the controller's `uidLabel(uid)`: they return "Name (Jun 13, 2026, 14:22)"
  and degrade to name, date or "ride", but never show a `gpx::sha256:…` identity. A GPX
  ride's name comes from `<name>`, then the filename, then the time of day, and is
  user-editable.
- Storage-key strings and the internal `beeline-*` module names stay as they are
  (persistence ids), despite the "GPX Toolkit" product name.

### Data ingestion integrity

**This is the foundation.** Every total, filter, chart, record and rollup is downstream of
turning each source's raw figures into correct normalized numbers. One mis-read value
silently corrupts every aggregate that touches it, and the user can't tell.

Both sources hand over **structured numbers**, never localized display strings: the
Beeline API returns SI fields (`totalDistance` in metres, `averageSpeed`/`topSpeed` in m/s,
`movingTime`/`duration` in ms; see [`mapBeelineRide`](../src/beeline-api.ts)), and a GPX ride
derives its metrics from the track geometry. An earlier build screen-scraped the Beeline
app and parsed localized strings like `13,5km`; that code is gone, so don't reintroduce
string-to-number parsing on the ingestion path.

- **Normalize once, at the boundary.** Convert a raw figure into the app's unit
  (`RideMetrics`: km, seconds, km/h, metres) where the ride enters app state (the source
  mapper). Downstream code uses those numbers and never re-derives a metric from a raw
  field.
- **`null` means unknown, not zero.** An unreported metric stays `null` (`blankMetrics`).
  Only overwrite a stored metric when the incoming figure is known, so a partial update
  never clears a richer value.
- **Convert units explicitly in the mapper.** Every conversion (m → km, m/s → km/h,
  ms → s) is spelled out there, so constants and directions are auditable in one place.
- **Test the mapper with fields present and absent.** A change to a mapper or an
  aggregation keeps coverage for a fully populated ride and one missing fields (so `null`
  propagates instead of a spurious `0`).

### Storage: data vs cache

- Ride state is **one versioned IndexedDB blob** (`gpx-toolkit-state:all`, with `schema` and
  `migrate()` in [src/store.ts](../src/store.ts)). Mutate the `Store` only through
  `store.upsert(key, partial)` and let the Controller emit a change event to re-render.
- Full GPX files live in two physically separate [`GpxCache`](../src/gpxcache.ts) stores,
  Android-style: a re-fetchable **cache** (`cache` prefix: Beeline downloads, safe to
  flush) and a **data vault** (`data` prefix: imported GPX originals, the only copy). The
  Controller routes every per-ride GPX read and write through `blobFor(uid)` (GPX rides to
  the vault, everything else to the cache). `flushGpxCache()` clears the cache **only**, so
  an imported file is lost only by deleting its ride or a full `reset()`. Never put
  re-derivable data in the vault, or irreplaceable data in the cache.

### Beeline credentials: never store the password

The password is used **once** at sign-in to get a short-lived token kept in memory. It is
**never persisted**, and neither is the token (it's gone on reload). Only the email and a
"last used Beeline" flag are remembered. After a reload the app shows the cached rides
offline and asks for the password only when an action needs the account (re-sync,
upload), so the user's **password manager** can fill it: `withBeelineAccess` defers the
action behind a focused re-auth picker and runs it once sign-in succeeds. Don't add
password persistence, and keep every cloud action behind `withBeelineAccess`.

### Other domain rules

- **Deletions need a complete scan.** A ride known locally but missing from a freshly
  fetched history is marked **deleted** only when the scan ran to completion
  (`enumerateCatalog` returns a `complete` flag). A cancelled or partial scan never
  reconciles deletions.
- **Job coalescing.** Consecutive `upload`/`status`/`download-gpx` tasks merge into one
  sweep; keep this when touching `JobQueue`.
- Only the **Strava** upload path is automated (komoot is detected but left alone).

## Tech stack and commands

- **TypeScript 5.6** (strict), **Vite 6** (`base: "./"`, `target: "esnext"`), **Vitest 2**
  with **jsdom**, **Leaflet** for maps, **Biome 2** for lint and format.
- `npm run dev`: Vite dev server. It boots into the library; the first launch explains the
  sources, and the Beeline source has a demo.
- `npm run build`: `tsc --noEmit`, then `vite build`.
- `npm test` / `npm run test:watch`: Vitest.
- `npm run verify`: type-check, `biome check` and Vitest; exactly what CI runs.
  `npm run check:fix` applies Biome's safe fixes and formatting.

## Code conventions

- **Strict TS**: full null-safety; `noUnusedLocals`/`noUnusedParameters` are on, so no dead
  variables or parameters and no implicit `any`.
- **Naming**: `camelCase` functions with a verb prefix (`parse…`, `upload…`), `PascalCase`
  classes and interfaces, `snake_case` string constants for storage keys.
- **Types**: `interface` for public contracts (`RideSource`, `RideRecord`); type aliases and
  discriminated unions for state (e.g. `TaskStatus = "queued" | "running" | …`).
- **Comments**: a module-level docstring explains purpose and design; `// -- section ----`
  headers group blocks; inline comments explain **why**, not what.
- **Async-first**: everything is `async`/`await` (`fetch` is async). Never block.
- **Subscriptions**: `onChange(fn)` returns an unsubscribe function; store it and call it on
  teardown.
- **Errors**: surface failures with `toast(message, isError)` / `pushError()` and the
  persistent error card instead of crashing. Wrap `localStorage` access in `try/catch`
  (private mode can throw; that's non-fatal).
- **Dependencies**: keep them minimal. The app deliberately has no backend and a tiny
  dependency set.

## UI rules

### Design system

- **Two themes, one token sheet.** Every colour in [style.css](../src/style.css) is a
  `:root` token; the light theme is the single `:root[data-theme="light"]` override block
  (`--tile-filter` swaps the basemap treatment). Status chrome has semantic families
  (`--ok-*`, `--info-*`, `--err-*`, `--accent-soft-*`, `--accent-wash*`, `--job-*`,
  `--src-*`). Never type a hex literal into a rule; if no token fits, add one to **both**
  blocks. Check every screen in both themes.
- **No literal white or black on a themed surface.** A hover, cursor, ring or wash drawn
  with `#fff` / `rgba(255,255,255,…)` vanishes in the light theme; use `var(--text)`,
  `var(--surface-hover)`, `var(--line)` or
  `color-mix(in srgb, var(--text) N%, transparent)`. Literal white is right only on an
  accent or blue fill.
- **Canvas reads tokens at draw time.** Charts read colours through `getComputedStyle`
  when they draw (`--fc-*`, `--fc-now`) and redraw on the `themechange` event; never cache
  colours across frames.
- **No Tailwind.** One hand-written stylesheet over one token sheet; a utility layer would
  be a second styling system that bypasses the tokens.
- **Size shared controls from one place.** Buttons, chips, segmented controls and fields
  take height, padding, radius and font from the `--ctrl-*` tokens (`--ctrl-pad-y/x`,
  `--ctrl-font`, `--ctrl-radius`, the `-sm` variants, `--tap-min`) through the canonical
  recipes (`button` / `button.small`, `.fchip`, `.seg`, `.custom`, the `--tap-min` header
  icon square). Never write a literal height, padding or radius on a control; extend the
  token or the shared class, and bring the siblings along.
- **Text fields are one family.** Every text-like input (`text`, `email`, `password`,
  `search`, `number`, `textarea`, `select`, `.field`) gets its look from the shared rule and
  the `--field-*` tokens. Add sizing and layout only; never restyle a field's border,
  background or focus ring. The underlined `.custom input` range fields in the filter bar
  are the one exception.
- **A segmented control is a `.seg` with `button.active`**, nothing else: the sliding thumb
  ([seg.ts](../src/seg.ts)) finds it by that shape. Toggle `.active`; never set a
  background on the active button (the thumb carries the fill), and never make a `.seg`
  `position: static` (its thumb is placed relative to it; `seg.ts` guards this).
- **Button glyphs come from one registry.** A button that wants an icon takes it from
  [icons.ts](../src/icons.ts): `${icon("name")}` in a template, or `data-icon="name"` on
  static markup (injected by `decorateIcons()` at boot). Never paste an SVG or use a
  Unicode character; add a missing glyph to the registry. A button that starts with the
  `.bi` glyph lays out as icon plus label (`button:has(> .bi)`); an icon-only button keeps
  its meaning in `aria-label`/`title`.
- **Loading has one form: the thread.** A 2px hairline (`.thread`: its `<i>` fills to the
  progress; `.indet` runs an accent segment along it) edges the job strip and its
  minimized top-bar chip (`jobs-view.setThread`), runs under a ride a job is working on
  (`.rring.working`; `.rring.queued` is its static dotted twin), sits under the pane-loader
  chip (`ui.paneLoader`) and under a map banner while it reports loading
  (`.map-banner.busy`). No spinners, no veils over content, no thick rings; only
  icon-scale inline states (a refresh button turning) may rotate.
- **No thick borders on curved shapes.** Chips are flat tints with 5px corners; avoid
  outlined pills; a 1px hairline on a 9–10px radius is the most border-plus-curve a surface
  gets. Buttons on a tinted surface (the selection toolbar) have transparent borders.
- **Big panels fold away.** A panel that costs more than a line of screen (the Explore
  chart, the Stats totals band, the Forecast legend, the ride map's toolbar stack) carries
  a `.collapse-btn` chevron wired through `ui.initCollapse` (remembered under
  `gpx_toolkit.collapse.<panel>`); collapsed, it keeps a one-line summary where one exists.
- **Stretched SVGs carry no text or styled strokes.** An SVG with
  `preserveAspectRatio: none` puts its labels in HTML beside it, and its strokes use
  `vector-effect: non-scaling-stroke`.

### Mobile

- The shell adapts at ≤768px (desktop sidebar → phone bottom nav plus the **More** sheet),
  and the top-bar action buttons become equal 32×32 icon squares at ≤819px.
- Overlays and menus must be reachable and dismissable with a thumb. On phones prefer a
  full-width bottom sheet (scrim, grabber, visible close, sticky header,
  `env(safe-area-inset-bottom)` padding) over a small anchored dropdown; the global filter
  panel is the model (desktop dropdown, phone bottom sheet).
- Touch targets stay at least ~32px. When you touch layout or CSS, re-check the ≤768px and
  ≤560px media blocks.

### Maps

- **One basemap look.** The Explore per-ride mini-maps (`.rmap`) and the all-rides Map view
  (`#allRidesMap`) share one dark, desaturated tile treatment
  (`.leaflet-tile-pane { filter: var(--tile-filter) }` over a `var(--map-bg)` container) so
  coloured tracks pop. Keep the two filter rules in sync. Mini-maps draw one ride with a
  white casing and a solid orange line; the Map view draws translucent overlapping lines as
  a heatmap.
- **Floating controls are icon-only inline SVG, never Unicode glyphs.** The Map view and
  the Stats heatmap carry the same three floating square buttons (`.map-expand` full-screen
  toggle, `.map-select` area select, `.map-locate` locate-me toggle): 34px square, centred
  17px SVG, `stroke: currentColor`, meaning in `aria-label`/`title`. Icons **swap by state
  in CSS**, never by rewriting the button: `.map-expand` flips from maximize to minimize on
  `[aria-pressed="true"]`; `.map-select` flips from a dashed marquee to an X on `.active`.
  `createAreaSelect` ([areaselect.ts](../src/areaselect.ts)) owns only the button's
  `.active`/`aria-pressed`/`aria-label`. Raw Unicode symbols (`⤢ ⤡ ▢ ✕ ▸ ▾` …) render
  inconsistently and are banned; add an SVG glyph or reuse the CSS-border chevrons of split
  buttons and disclosures.
- **One full-screen pattern.** A CSS pseudo-fullscreen (no `requestFullscreen`): the
  container goes `position: fixed; inset: 0; z-index: 60` under a body class
  (`body.map-expanded .map-wrap` for the Map view, `body.heat-expanded .freq-wrap` for the
  heatmap). Each toggle (`setMapExpanded` in [map-view.ts](../src/map-view.ts),
  `setHeatExpanded` in [stats-view.ts](../src/stats-view.ts)) flips the body class, sets
  the button's `aria-pressed` and calls `invalidateSize()` so Leaflet re-measures. Both
  exit on **Esc** and when leaving their view (`applyView`).
- **One column layout; controls never cover the basemap.** The Map view's `.map-main` and
  the heatmap's `.freq-main` are flex columns whose Leaflet container (`#allRidesMap` /
  `#freqHeatMap`) is `flex: 1; min-height: 0`; every control sits **below** it in normal
  flow. That keeps Leaflet's zoom (top left) and attribution (bottom right) in place and
  the "© OpenStreetMap contributors" credit uncovered. Both date filters use the same
  `.basemap-filter` class beneath their map (`#mapFilter`, `#statsFilter`); the Stats one
  still scopes the whole Stats body (totals, records and heatmap). Only the icon buttons
  and the rubber-band selection rectangle float over a basemap.
- **Keep the Map view and the heatmap in lockstep.** A control or behaviour added to one
  goes into the other the same way.

### Explore list and selection

- **Aligned group headers.** In the year and month headers (`.yhead`/`.mhead`) the title
  column (`.ytitle`/`.mtitle`) is fixed-width
  (`flex: 0 0 auto; min-width; white-space: nowrap`), so the 90px volume bar (`.bars`) and
  the meta text start at the same x on every row. "May 2026" and "September 2026" must not
  push them around or wrap. New header columns are fixed-width too.
- **The list never moves under the user.** A rebuild captures the month at the reading line
  and its pixel offset (`captureListAnchor`), builds that month first, and restores it
  (`restoreListAnchor`); leaving a view captures it too, so coming back lands where you
  were. Unbuilt months carry honest heights (`contain-intrinsic-size` and `min-height` from
  a row measured in the viewport: `measureRowHeights` / `applyPlaceholderHeights`), so a
  slice landing shifts nothing. Pending builds are keyed (`pendingBuilds` /
  `buildMonthNow`): a scroll-to builds only its target month. Opening a ride's details
  patches its row (`toggleRowDetails`). The tree's scroll-spy never scrolls the tree while
  the pointer is in it. Anything that moves the page without the user asking is a bug.
- **Selection is the user's work.** Only the user clears it (`selClear`, dropping deleted
  rides, or keys that no longer exist once the library has loaded). It is persisted
  (`gpx_toolkit.selection`) and restored before the library loads; never prune it against
  an empty ride list. Shift+click extends from the last-clicked anchor in list order
  (`selectRange` over `listOrderKeys`), Ctrl/⌘+click toggles one row, a plain click opens
  details. Batch actions and group checkboxes are additive to this model.
- **Selection actions show their applicable subset.** In the selection toolbar (`#selBar`,
  [main.ts](../src/main.ts)) an action that can act on only part of the selection puts that
  count in its label and **hides when the count is zero** ("Push N rides to Strava",
  "Fetch full GPX for N rides", "Resolve wind for N rides", "Delete N rides": natural,
  parallel phrasing with the count mid-sentence). An action that always acts on all N stays
  label-only ("N selected" already says N). Never show a batch action that would be a
  no-op. Derive every subset once from a single `selRides` array with cheap ride-view
  flags (`can_upload`/`status`, `gpx_cached`, `hasResolvedWind`, `deleted`) through
  `setSelAction(id, count, label)`; no per-button `find` loops.
- **Batch actions are never a strip of look-alike icons.** Where labels fit (≥1700px) the
  toolbar shows labelled buttons inline; below that the same buttons fold into the
  labelled Actions menu (`#selMore` → `.selbar-acts`). A new batch action goes into
  `.selbar-acts` with an icon **and** a label.

### Charts

- **Direction is drawn, not plotted.** Wind direction is an arrow (north up, pointing where
  the wind blows to: `windTravelDeg`), never a value on a numeric axis. The spread across
  models is a fan behind the arrow (`drawDirectionFan`); per-model detail is each model's
  own arrow.
- **Nothing floats over a chart's data.** Hover details go beside the chart (the Forecast
  legend values and readout line), never in a card over the lanes being read.

### Status messages

Say exactly **what** is happening and **why**, verbosely if needed, never with vague
counts. Name a specific ride by what we know (`rideShortLabel(key)` → "Jun 13 14:22"), not
"1 ride": "scrolling down to find Jun 13 14:22…", not "scrolling down, looking for 1
ride…". For several rides, name the first couple and add "(+N more)".

### Performance

- **Target scale: several thousand rides and tens of thousands of km.** That is the normal
  case, not an edge case: totals, filters, stats, the map and the heatmap stay responsive
  at that size. Never materialise per-metre points for the whole dataset (the heatmap
  densifies only the visible viewport), keep per-ride work roughly O(1), and prefer
  culling and caching to recomputing everything on each interaction.
- **The UI never freezes.** Anything that scales with the ride count does one of three
  things: **patch in place** (`applySelection`, `applyJobUpdate`, `applyWeatherUpdate`,
  `syncOpenMenu` in [main.ts](../src/main.ts) touch only the rows that changed),
  **slice through idle time** (`runInSlices` in [idle.ts](../src/idle.ts): the Explore pane
  after its first screenful, the Map's track draw, the heatmap densify), or **show a loader
  first** (`ui.paneLoader`, then slice). The full `render()` is for structural change only
  (membership, grouping, filters, layout, selection); a ride's own field changes patch its
  row (`rowSigs` → `applyRowUpdates`). Never put bulky per-ride fields (the `track`
  polyline) in a render signature, and never build DOM that isn't shown (closed months on
  phones, a row's ⋯ menu until it opens).
- **Measure it.** Use the long-task harness (`.tmp/…/big.mjs`: export → multiply → import,
  long tasks per interaction; the paint path has `ui:*` User Timing marks). A feature that
  adds a long task of 50ms or more on a 2,000-ride library is not done.
- **Animated indicators are persistent elements whose class flips.** A CSS animation
  restarts when its element is re-created or its `innerHTML`/`className` is re-set, so a
  ride's status thread (`.rring`) and the pane loader are created once and only toggled
  (`applyJobUpdate` compares the class before setting it), and
  `ui.paneLoader(host, null)` hides after a short grace so a build that follows reuses the
  element. If an indicator visibly restarts, fix the re-render; never mask it.
- **Live controls never stall the page.** A range input's `input` tick does only cheap,
  local, visual work (relabel, redraw the one chart or layer it affects: `liveTrim` +
  `renderStats`, `setHeatRadiusPreview`, the wind-rose window's in-memory re-aggregate). It
  never writes the store, calls `notify()` or triggers the full `render()`; persist and do
  heavy work once on `change`. `applyState` already coalesces store notifications into one
  paint per frame; don't bypass it with direct `render()` calls from a drag.

## Testing

- Tests live in `tests/**/*.test.ts` (Vitest with jsdom).
- Source tests drive `BeelineRideSource` against an in-memory fake `BeelineApi` (no
  network) and a captured backend response in [tests/fixtures/beeline/](../tests/fixtures/beeline/).
- Inject an instant `sleep` and a `memoryBackend()` store; don't touch real `localStorage`
  or wall-clock delays. Wait for async work with
  `await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false))`.
- **Demo GPX downloads never open a "Save As".** `saveGpxFile()` in
  [src/main.ts](../src/main.ts) returns early when `isDemo` (the bytes are synthetic; the
  route is still drawn from the stored track), which keeps browser-driven demo and test
  flows prompt-free. Keep this guard when touching the GPX save path.

## Gotchas

- **`position: fixed` breaks inside the header.** `<header>` has `backdrop-filter: blur()`,
  which (like `transform`, `filter` or `will-change`) makes it the containing block for
  `position: fixed` descendants: a fixed element inside it is positioned against the
  header box, not the viewport, so a phone bottom sheet authored there pins to the top.
  Render viewport-anchored overlays at `<body>` level (the global filter panel is moved to
  `<body>` at runtime by `initFilterPanel`, anchored under its button on desktop and pinned
  to the viewport bottom on phones). Never assume `position: fixed` is viewport-relative
  without checking for a transformed or filtered ancestor.

## Module map

UI → Controller → RideSource registry → Beeline API / local GPX, plus the JobQueue and the
Store. **Keep this map current:** when you add, split, rename or remove a `src/*.ts`
module, or change what one is responsible for, update its row in the same change. A stale
map is worse than none. Rows are grouped by concern; put a new module in its group.

*Core: UI · orchestration · source seam*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [index.html](../index.html) | App shell markup (grouped sidebar: Rides · Plan · Weather · Research · per-view top bar · phone bottom nav + More sheet), every view's static markup, the Sources + Settings dialogs, the pre-paint theme boot script | |
| [src/seg.ts](../src/seg.ts) | Sliding segmented controls: gives every `.seg` a thumb that glides to `button.active`, driven by a MutationObserver (class flips, rebuilt segs) + ResizeObserver, so the code that toggles `.active` never changes | `initSegSliding()` |
| [src/router.ts](../src/router.ts) | Hash router: `#/<view>` (incl. `#/routes`), plus `?lat=&lon=` for Forecast and Wind rose so a URL shares the picked point; parse / format / validate, and push vs replace history entries | `parseRoute()`, `formatRoute()`, `writeRoute()`, `validRoutePoint()`, `Route` |
| [src/shell.ts](../src/shell.ts) | App-shell behaviour: reflect the active view onto every `.navlink[data-view]` + the top-bar title, the sidebar rail toggle, the phone More sheet, and re-parenting the Plan and Research groups + footer into that sheet on the phone media query (one set of nav nodes, never two) | `initShell()`, `syncShell()`, `setViewSubtitle()`, `lastWeatherView()`, `VIEW_TITLES` |
| [src/main.ts](../src/main.ts) | UI entry: render + wiring, re-auth gating, GPX import, Location-History import/drop, the Explore view and selection toolbar; mounts the per-view modules (Map, Stats, Wind vs speed, Forecast, Wind rose, Timeline, Routes); owns the route store and carries it in Export All / Import / Reset. Explore from 1100px is a contents tree (`#months`, sticky, flat rows; a scroll-spy marks the month in view) beside a continuous ruled list of every ride (`#rideList`, sticky month headings, heavier year headings; tree clicks scroll the list; note `<body>` is the page's scroll container); narrower screens keep rows inside the (open) month box. The chart's Auto granularity is density-driven (`chartBuckets()` from the chart width) and quiet periods are filled (`fillEmptyBuckets`) | `activate()`, `getRealController()`, `openApp()`, `goBeeline()`, `goGpx()`, `pullFromBeeline()`, `importGpxFiles()`, `importLocationHistory()`, `dropLocationHistory()`, `withBeelineAccess()` |
| [src/sources-view.ts](../src/sources-view.ts) | Sources & Settings dialogs (show/hide/repaint) behind a `SourcesViewDeps` seam; auth-flow wiring stays in main | `initSourcesView()`, `showSources()`, `hideSources()`, `showSettings()`, `renderSources()`, `setBeelineError()` |
| [src/tag-modal.ts](../src/tag-modal.ts) | Bulk tag-assignment modal (tri-state chips) behind a `TagModalDeps` seam; commits via injected `setRideTags` | `initTagModal()`, `openTagModal()`, `cycleTagChip()`, `addTagModalTag()`, `saveTagModal()`, `closeTagModal()` |
| [src/jobs-view.ts](../src/jobs-view.ts) | Live activity tile (a fixed strip along the bottom of the main pane, following the sidebar width; above the bottom nav on phones) / its minimized form, a chip at the head of the top bar's actions (in flow, never over a view; verb + done/total, the count alone on phones) / "Up next" queue + the persistent error stack; owns its own UI state, reads job state via `getJobs` | `initJobsView()`, `renderJob()`, `renderError()`, `pushError()`, `toggleQueue()`, `hideJob()`, `dismissError()` |
| [src/explore-view.ts](../src/explore-view.ts) | Shared ride-display helpers + the "Selected rides" card list (Map side panel / Stats heatmap); pure `(ride) => string` builders over `getRides` | `initExploreView()`, `renderMatchedCards()`, `rideWhen()`, `rideTimesTitle()` |
| [src/range-view.ts](../src/range-view.ts) | The shared dual-thumb date-range slider (Map/Stats/Wind-Speed windows), parameterized by `RangeView`; bounds/selection state + reconcile + drag/preset handlers, behind a `RangeViewDeps` seam (rides in, remount + persist out) | `initRangeView()`, `refreshRange()`, `syncRangeControl()`, `ridesInRange()`, `rangeOf()`, `resetRange()`, `applyRangePreset()`, `onRangeInput()`, `onWindowDrag()`, `rangeWindowLabel()` |
| [src/ridemap.ts](../src/ridemap.ts) | Full-screen single-ride map (`#rideMapModal`): a title bar (title · live hover readout · Close) over a toolbar of labelled groups: "Colour route by" (Route / Height / Speed / Wind; Height + Speed need the full track, Wind resolves on first use), "Weather" (the `Rain & wind` toggle: the Forecast map's `WeatherFx` overlay + a corner readout of wind / rain / temperature at the hovered point, the ride's midpoint when idle; wind cached before weather variables existed is re-resolved once), "Graph" (Profile toggle, Elevation / Speed, By distance / By time, Skip stops) and "Track" (Fetch full track); toggles carry a ticked box (`.rmb-toggle`), labels never flip; the row folds to icons when it overflows. Behind a `RideMapDeps` seam | `initRideMap()`, `openRideMap()`, `closeRideMap()`, `refreshOpenRideMapWind()` |
| [src/controller.ts](../src/controller.ts) | Orchestration + app state; source registry; per-ride dispatch; full-track cache; point wind climatology; weather along a planned route (archive cell-days via the wind cache, forecast cell-days in memory only, so a stale forecast never passes for a day's weather; optionally several named forecast models fetched one by one and merged with `consensusCellDays`) | `Controller`, `registerSource()`, `state()`, `runTask()`, `importGpx()`, `onImported()`, `getFullTrack()`, `getPointWind()`, `cachedWindYears()`, `routeWeather()` |
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
| [src/filter-state.ts](../src/filter-state.ts) | The live `filters` singleton + persistence, the filter bar/chips/date-pickers/tag-popover, and the global filter panel chrome; predicates stay in `./filter`. Behind a `FilterStateDeps` seam | `initFilterState()`, `filters`, `syncFilterBar()`, `saveFilters()`, `clearFilters()`, `cycleChip()`, `setFilterPanel()`, `openIngestionPicker()`, `openRidePicker()` |
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
| [src/weather.ts](../src/weather.ts) | Open-Meteo wind client: dataset selection, grid quantization, per-point sampling (along + cross-track components); the forecast dataset reaches forward to the newest wanted day (`forecast_days`, ≤ `FORECAST_HORIZON_DAYS`) for planned routes, and can name one model (`forecastModelDataset`); `consensusCellDays` merges several models per hour (median wind vector, median rain / temperature); ride resolves also fetch rain / temperature / cloud (`WEATHER_VARS`, `weatherAtMs`, per-point `rainMm`/`tempC`/`cloudPct`, `wx` marks an entry fetched with them) | `pickDatasets()`, `datasetById()`, `sampleGridCells()`, `quantizeCell()`, `alongTrackComponentKmh()`, `crossTrackComponentKmh()`, `Dataset`, `CellDayWind`, `PointWind`, `RideWind` |
| [src/windspeed.ts](../src/windspeed.ts) | Wind-vs-speed analytics: ride segmentation (along + cross-track wind), regression, speed capping, wind colour ramps (crosswind magnitude + diverging head/tailwind) | `segmentRide()` (segments carry `startIdx`/`endIdx`), `linearRegression()`, `speedCapIndices()`, `crossColor()`, `alongColor()`, `WindSeg` |
| [src/windchart.ts](../src/windchart.ts) | Wind-vs-speed scatter plot (canvas render; the X axis is caller-chosen via `ChartOpts.xValue`/`xSigned`/`xCaption`: signed head/tailwind with tinted halves, or a one-sided magnitude; optional per-dot tint via `ChartOpts.dotColor`). Returns a hit-test layout so the view can map a pointer back to a dot + ring it on an overlay | `drawWindSpeedChart()`, `nearestDot()`, `drawDotHighlights()`, `makeScale()`, `niceTicks()`, `ChartOpts`, `ChartLayout`, `ChartDot` |
| [src/windspeed-view.ts](../src/windspeed-view.ts) | Wind/Speed view (`#analyticsView`): a confirm-to-run gate (centred card naming how many rides the window will analyse, live as the slider moves), the window-scoped per-ride segment sweep (cached, keyed on the segment-geometry tuning), distance-weighted regression, the scatter + KPI cards (labels adapt to the X axis) + empty/blocked states, the X-axis picker (head/tailwind ↔ crosswind) + generic colour-by picker (off / head-tailwind / crosswind, the X dimension auto-hidden) + legend + the unified min/max band filters (grade / speed / length / crosswind / headwind / tailwind, all cheap synchronous post-filters via the shared `readBand`/`bandLabel`), the end-user segment-tuning knobs (look-ahead / turn tolerance + Reset), and dot→ride discovery (hover tooltip on precise pointers; tap/click pins a dot → rings all of that ride's segments + a card below the chart that opens the ride in Explore); a head/tailwind fit over ≥ 20 segments is saved as the route simulator's speed model (`saveSpeedFit`). Behind a `WindSpeedDeps` seam | `initWindSpeedView()`, `mountWindSpeedView()`, `windSpeedVisibleRides()`, `syncColorByGating()`, `SEG_TUNE_DEFAULTS`, `WindSpeedDeps` |
| [src/segment-demo.ts](../src/segment-demo.ts) | The Wind vs speed segmentation explainer: a deterministic synthetic ride chopped by the real `segmentRide()` with the live knobs and drawn as an inline SVG (pure, no DOM) | `segmentDemo()`, `demoTrack()` |
| [src/forecast.ts](../src/forecast.ts) | Provider-neutral live-forecast domain (points, hourly series, models, metrics, units) + the Open-Meteo adapter (multi-model fetch, geocoding); each model carries its regional domain (`coverage` box) and `family`, and `recommendForecastModels()` picks the auto set per point: covering regionals finest-first (≤ 1 per family, ≤ 2 per provider), then ECMWF IFS, hourly ≤ 15 km "home" globals, the rest by cadence/grid; 5–10 models; the view swaps out ids that came back empty | `HourlyForecast`, `ForecastPoint`, `ForecastModel`, `ForecastMetric`, `DEFAULT_FORECAST_METRICS`, `ForecastProviderAdapter` |
| [src/forecast-store.ts](../src/forecast-store.ts) | Separate, gzipped IndexedDB store for live forecasts, recent/pinned locations and the view's prefs (range, models, presentation, units, metrics); included in full backup/restore | `ForecastStore`, `ForecastPrefs` |
| [src/forecast-chart.ts](../src/forecast-chart.ts) | Hand-rolled canvas forecast charts: per-model lane rows and the combined consensus chart (median + min–max bands, direction arrows, cloud wash, lane captions), shared timeline/scales, hit-testing, the cursor readout card; every colour read from `--fc-*` tokens at draw time | `drawForecastRow()`, `drawForecastComparison()`, `sharedForecastTimeline()`, `sharedForecastScales()`, `forecastLaneAtY()`, `hourTimeAtX()`, `forecastComparisonDetails()` |
| [src/forecast-view.ts](../src/forecast-view.ts) | Forecast view (`#forecastView`): map picker (search / locate / pins / drag), range + presentation toolbar, model + metric legends, Combined / Per model / Table presentations, hover + touch + keyboard selection, auto-refresh; on ≥1400px a full-height map pane beside the chart pane with a persisted, keyboard-friendly drag splitter (`--fc-split`), else stacked with a collapsible map (location strip); the hovered hour mirrors onto the map via `forecast-fx` and a corner readout pill. Behind a `ForecastViewDeps` seam | `initForecastView()`, `mountForecastView()`, `leaveForecastView()`, `setForecastRoutePoint()`, `forecastPoint()`, `resetForecastViewData()` |
| [src/forecast-fx.ts](../src/forecast-fx.ts) | Forecast map weather effects: a canvas overlay of wind streaks, in-air rain and raindrops-on-the-glass (beads that sit, evaporate and trickle; scaled by the hour's mm) driven by the hovered hour's consensus snapshot (reduced-motion aware) | `WeatherFx`, `WeatherSnapshot` |
| [src/windrose.ts](../src/windrose.ts) | Wind-rose climatology compute (pure): flatten cached cell-days → 16-sector × speed-bin rose, monthly breakdown, vector-mean; local-time-from-longitude | `flattenSamples()`, `roseFromSamples()`, `monthlyRoses()`, `sectorFractions()`, `WindRose`, `WindSample` |
| [src/climate-view.ts](../src/climate-view.ts) | Windalytics ("Wind rose" tab): isolated map view: click a point, pull a year-window of ERA5 wind via the `ClimateDeps` seam, render the rose, monthly small-multiples, month×direction heatmap + mean-wind arrow; dual-thumb year window (paints cached/in-memory year bands, re-aggregates live while dragging over loaded years, warms other cached years in the background) + hour/month controls re-aggregate in memory; "Pin to compare" freezes a snapshot (rose, monthly roses, place, window, hour, month; persisted) that survives a point change, ghosts over the live rose + mini-roses in the `--cmp` colour, renders a pinned-vs-now comparison card with deltas and a Swap, and marks the pinned place on the map | `initClimateView()`, `mountClimateView()`, `leaveClimateView()`, `ClimateDeps` |

*Routes: planned routes + ride simulation*

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [src/routing.ts](../src/routing.ts) | Bike routing for one planner leg via the public BRouter server (CORS, no key); profiles Bike paths / Quiet / Fast (`trekking` / `safety` / `fastbike`) and a no-network Straight line | `routeLeg()`, `straightLeg()`, `parseBrouterGeojson()`, `ROUTE_PROFILES`, `RouteProfile`, `RoutedLeg` |
| [src/routes.ts](../src/routes.ts) | The route model (waypoints joined by routed legs; an imported GPX is one fixed leg), joined track, climb, GPX in/out, and the routes' own versioned blob (`gpx-toolkit-routes:all`, polyline-encoded legs) with merge-on-import | `PlannedRoute`, `RouteStore`, `routeTrack()`, `routeStats()`, `routeToGpx()`, `routeFromGpx()`, `climbM()` |
| [src/route-sim.ts](../src/route-sim.ts) | Pure ride simulation: the route cut into ~250 m steps (each with its net grade), wind read where and when the rider gets there, speed = still-air speed + tailwind factor × along-track wind (clamped), then — with Hills on — the same effort replayed on the step's grade (`hillSpeed`: rider + bike mass, a touring drag/rolling model, a little more effort uphill, descents capped); still-air and flat baselines for the wind/hills effects; whole-day departure sweep; the rider's speed prefs and the Wind vs speed fit | `buildCourse()`, `weatherFromCells()`, `simulate()`, `sweepDepartures()`, `speedFor()`, `hillSpeed()`, `effectiveSpeedModel()`, `readSpeedFit()`, `saveSpeedFit()`, `readSpeedPrefs()` |
| [src/routes-view.ts](../src/routes-view.ts) | Routes view (`#routesView`): route cards (drawn shape, distance, climb) + New route / Import GPX; an open route is a map beside a side panel: place search, click to add / drag (dashed preview) / drag the line by its hover handle (or tap it) to insert / right-click or × to drop waypoints, drag a list row (its grip; the whole row with a mouse) or ↑ / ↓ on the grip to reorder them — rows slide aside and relabel live, the row's point lights up on the map, legs re-routed only when their ends move, autosave; departure day + time slider at the start's local time, head/tailwind-coloured line + a rain halo + wind badges (arrow + km/h, ~110 px apart, skipped next to a waypoint) + hover readout; under the map a foldable profile on one distance axis: a clock ruler (when you'd pass each point), the elevation (the shared `.profile-strip`, climbs tinted from 4% / 8%) and a rain lane (bars on a fixed 4 mm/h scale, each wet stretch's peak mm/h labelled), hover-synced with the map; the day's ride-time-by-departure strip (rain dots on wet departures), result cards (ride time, wind effect, hills effect, …), a forecast-source disclosure (best match, or a consensus of chosen models that cover the start), and the still-air speed / tailwind factor / terrain / rider + bike fields. Behind a `RoutesViewDeps` seam | `initRoutesView()`, `mountRoutesView()`, `leaveRoutesView()`, `resetRoutesView()`, `RoutesViewDeps` |

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
| [src/theme.ts](../src/theme.ts) | Colour theme preference (dark / light / system): persisted, resolved via `prefers-color-scheme`, stamped as `html[data-theme]`, Settings control sync, `themechange` event for canvas redraws | `initTheme()`, `applyTheme()`, `setThemePref()`, `readThemePref()`, `resolveTheme()` |
| [src/reactive.ts](../src/reactive.ts) | Tiny reactive core: fine-grained signals + effects (~50 lines, no deps); replaces hand-rolled `lastSig` dirty-checking | `signal()`, `effect()`, `computed()` |
| [src/app-state.ts](../src/app-state.ts) | Shared app state as signals (the seam for decomposing `main.ts` into per-view modules); a view imports the shared state it needs | `activeView`, `setActiveView()`, `ViewName` |
| [src/confirm.ts](../src/confirm.ts) | Self-contained styled confirm / prompt / consent dialogs (promise-based, own DOM listeners via `initConfirm`); reuses the `.scrim`/`.modal-card` vocabulary | `confirmDialog()`, `promptDialog()`, `consentDialog()`, `initConfirm()` |
| [src/icons.ts](../src/icons.ts) | The shared button icon set: one registry of inline-SVG glyphs; `icon(name)` for templates, `decorateIcons()` injects into static `data-icon` markup at boot | `icon()`, `decorateIcons()`, `IconName` |
| [src/idle.ts](../src/idle.ts) | Idle-time slicing: run a list of work in ~12ms `requestIdleCallback` slices (cancellable, `onDone`), the one way heavy per-ride loops touch the main thread | `runInSlices()`, `chunked()` |
| [src/ui.ts](../src/ui.ts) | Render-layer design vocabulary: pure `(opts) => string` builders for shared components (one canonical markup + classes each); centralised HTML escaping; the pane loader shown while sliced work runs | `escHtml()`, `statNum()`, `paneLoader()`, `initCollapse()` |
| [src/tz.ts](../src/tz.ts) | Ride-local time: lat/lon → IANA zone (lazy `tz-lookup`, code-split), and a start INSTANT → ride-local wall-clock key / hour / DST-correct offset via `Intl`; offset + city display helpers | `loadTz()`, `zoneForPoint()`, `localTime()`, `offsetMinutes()`, `formatOffset()`, `zoneCity()`, `browserZone()` |
| [src/slider.ts](../src/slider.ts) | Unified single-thumb range slider behaviour: drive the `.uslider` accent left-fill (`--fill`) from each input's value, so every single-thumb slider matches the dual-thumb `.rf-*` look | `setSliderFill()`, `initSliderFills()` |
| [src/format.ts](../src/format.ts) | Pure number → string display formatters (distance, speed, duration, elevation, byte sizes); no state, no DOM | `fmtKm()`, `fmtSpeed()`, `fmtDuration()`, `fmtDurationExact()`, `fmtElevation()`, `fmtBytes()` |
| [src/datepicker.ts](../src/datepicker.ts) | The one styled date-picker popover (a month calendar, one open at a time) for the Timeline's jump-to-day and the Explore ingestion-date filters; days are `"YYYY-MM-DD"` | `openDatePicker()`, `closeDatePicker()`, `DatePickerOptions` |
| [src/analytics.ts](../src/analytics.ts) | Fail-soft GoatCounter seam: cookieless synthetic view paths and event names only (never ride data, GPS, emails or tokens); no-ops until the counter script loads | `trackView()`, `trackEvent()` |
| [src/zip.ts](../src/zip.ts) | Dependency-free ZIP build + read | `buildZip()`, `unzip()` |
| [src/gzip.ts](../src/gzip.ts) | Gzip compress/decompress (CompressionStream) | `gzip()`, `gunzip()` |
| [src/varint.ts](../src/varint.ts) | Variable-length int encode/decode (for compact caches) | `ByteWriter`, `ByteReader`, `zigzag()`, `unzigzag()` |
| [src/env.d.ts](../src/env.d.ts) | Vite env / asset type stubs | |
