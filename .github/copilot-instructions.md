# Beeline Toolkit — Copilot instructions

A **backend-free**, framework-free browser SPA (vanilla TypeScript + DOM) that batch-uploads
**Beeline Velo 2** rides to **Strava**. It reads rides from the **Beeline account** source
behind a `RideSource` seam ([src/source.ts](../src/source.ts)):

- **Beeline account** — talks to Beeline's own Firebase cloud backend over `fetch`
  ([src/beeline-api.ts](../src/beeline-api.ts) + [src/beeline-source.ts](../src/beeline-source.ts)):
  one request returns the **whole** history (routes, stats, Strava status); uploads run
  server-side and **concurrently**. CORS-friendly, no proxy, any modern browser.

The source has a demo ([src/beeline-demo.ts](../src/beeline-demo.ts)) for exploring without an
account. Everything runs in the browser; ride state is cached **per source** in IndexedDB (a
separate `Store` key per profile). There is no server. The `RideSource` seam is kept so a
second source could be added later, but Beeline is the only implementation today.

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
  helper and have both call it (e.g. the `parseLocaleNumber` parser, the `AreaSelect` gesture
  controller shared by the Map and heatmap, `renderMatchedCards()` shared by both ride lists).
  Two copies means two behaviours means a bug; duplication is a smell, not a shortcut.
- **One unified design language.** The app should look and behave like one product, not a pile of
  screens. Reuse the established visual vocabulary — the dark desaturated basemap treatment,
  the `.ms-matched`/`.ms-item` ride cards, the segmented `.seg` toggles, the shared range slider,
  accent colours and spacing — rather than inventing a one-off style. The same interaction
  (selecting, filtering, listing rides) should work the same way everywhere it appears. When you
  add a surface, first ask which existing component or class already expresses it; introduce new
  styling only when nothing fits, and then make it reusable.

## Data ingestion integrity (read this first)

**This is the foundation — if numbers come in wrong, nothing else matters.** Every total,
filter, chart, record, and rollup in this app is downstream of one thing: turning any external
strings we ingest into correct numbers. A single mis-parsed value silently corrupts every
aggregate that touches it, and the user has no way to tell. We already shipped this exact bug
once: a comma-decimal locale renders `13,5km`, a blind `replace(/,/g,"")` turned that into
`135` km, and every distance/speed stat from that source was inflated 10×. Treat ingestion
correctness as non-negotiable, not a nicety.

Hard rules:

- **One canonical parser, no copies.** Locale-aware numeric parsing lives in exactly one place
  ([src/parsing.ts](../src/parsing.ts)) — `parseLocaleNumber` and its `parseKm`/`parseMeters`/`parseKmh`
  wrappers. Never write a second `parseFloat`/`replace`-based number parse anywhere else; import
  the canonical one. Two parsers means two behaviours means a bug.
- **Never blind-strip separators.** `,` and `.` are locale-dependent: one locale's decimal point
  is another's thousands group. Detect the decimal separator (`parseLocaleNumber` already does);
  never assume, never `replace(/,/g, "")`.
- **Normalize once, at the boundary.** Parse external strings into numbers as they enter app
  state (the `RideView` numeric fields), then compute and display from those numbers. Downstream
  code must consume normalized numbers, not re-parse raw strings ad hoc.
- **Every numeric path is tested in both locales.** Any change touching parsing/aggregation must
  keep both comma-decimal (`13,5km`, `20,0km/h`) and period-decimal (`13.5km`, `20.0km/h`)
  coverage green.
  A parsing change without a both-separators test is incomplete.

## Tech stack & commands

- **TypeScript 5.6** (strict), **Vite 6** (`base: "./"`, `target: "esnext"`), **Vitest 2** + **jsdom**, **leaflet** for maps.
- Beeline-account source: plain `fetch` to Beeline's Firebase backend (CORS-friendly, no proxy).
- `npm run dev` — Vite dev server (boots into the source picker; the source has a demo).
- `npm run build` — `tsc --noEmit` type-check **then** `vite build`. Always type-check before considering a change done.
- `npm test` / `npm run test:watch` — Vitest.

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

## Committing

When a logical change is finished and its acceptance checks pass (`npm run build` + `npm test`
green, CHANGELOG updated), **offer to commit it yourself** rather than leaving it to the user.

- **Match the established commit style** (see `git log`): a single concise, lowercase,
  imperative subject line, no trailing period, no body, no Conventional-Commits prefix
  (e.g. `compact state & selection actions into menus`, `more resilient error handling`).
- **One commit per logical change.** Stage the related files and commit; don't bundle
  unrelated work.
- **Commit, don't push.** Pushing is a shared/irreversible action — leave `git push` to the
  user unless they explicitly ask.

## Architecture / module map

UI → Controller → RideSource → BeelineApi ; + JobQueue · Store.
The Controller is source-agnostic: it drives a `RideSource` (scan/check/upload/GPX) and
never touches a concrete backend. `main.ts` wires the source (Beeline account / demo).

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [index.html](../index.html) | App shell, markup, styles, source picker | — |
| [src/main.ts](../src/main.ts) | UI entry: render + wiring, source picker, re-auth gating | `activate()`, `goBeeline()`, `goBeelineOffline()`, `goDemoBeeline()`, `withBeelineAccess()`, `showPicker()` |
| [src/controller.ts](../src/controller.ts) | Orchestration + app state; scan/check/upload/cancel | `Controller`, `state()`, `onChange()`, `runTask()` |
| [src/source.ts](../src/source.ts) | `RideSource` seam + shared GPX/catalog types | `RideSource`, `SourceFactory`, `GpxFile`, `CatalogResult`, `gpxFilename()` |
| [src/beeline-api.ts](../src/beeline-api.ts) | Beeline cloud backend client + ride mapping | `signIn()`, `fetchRides()`, `uploadRideToStrava()`, `mapBeelineRide()`, `BeelineSession` |
| [src/beeline-source.ts](../src/beeline-source.ts) | Account `RideSource` over the API (concurrent uploads) | `BeelineRideSource`, `BeelineApi`, `runPool()` |
| [src/beeline-demo.ts](../src/beeline-demo.ts) | Simulated Beeline backend for the account demo | `demoBeelineDeps()`, `DEMO_BEELINE_EMAIL` |
| [src/parsing.ts](../src/parsing.ts) | Normalized metrics + ride-key/date helpers | `metricsFromStatStrings()`, `rideDatetime()`, `beelineRideKey()`, `bucketRide()` |
| [src/jobs.ts](../src/jobs.ts) | Single-worker background queue with coalescing | `JobQueue`, `Task`, `TaskSnapshot` |
| [src/store.ts](../src/store.ts) | Per-source IndexedDB cache | `Store` (keyed per profile), `RideRecord` (`source`/`source_id`), `upsert()` |
| [src/track.ts](../src/track.ts) | GPS track decode/simplify/render | `extractTrack()`, `simplify()` (Douglas–Peucker), encoded polylines |
| [src/mapview.ts](../src/mapview.ts) | Map-view geometry: pick drawable tracks + hover/overlap hit-testing | `ridesWithTracks()`, `nearestRides()`, `RideTrack`, `ProjectedTrack` |

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
- **Ride keys** are human dates like `"Sat Jun 13 2026 at 14:22"`; months are `"2026-06"` / `"June 2026"`. `beelineRideKey(startMs)` builds one from a Beeline ride's start instant; `rideDatetime()` is its inverse.
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
