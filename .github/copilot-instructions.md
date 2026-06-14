# Beeline Toolkit — Copilot instructions

A **backend-free**, framework-free browser SPA (vanilla TypeScript + DOM) that drives the
**Beeline Velo 2** Android app over **WebUSB ADB** to batch-upload rides to **Strava**.
Everything runs in the browser: it reads the phone's screen (uiautomator XML), taps
buttons, and persists ride status in `LocalStorage`. There is no server and no API.

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
filter, chart, record, and rollup in this app is downstream of one thing: turning the strings
we scrape off the phone screen into correct numbers. A single mis-parsed value silently
corrupts every aggregate that touches it, and the user has no way to tell. We already shipped
this exact bug once: a phone in a comma-decimal locale shows `13,5km`, a blind `replace(/,/g,"")`
turned that into `135` km, and every distance/speed stat from that device was inflated 10×.
Treat ingestion correctness as non-negotiable, not a nicety.

Hard rules:

- **One canonical parser, no copies.** Locale-aware numeric parsing lives in exactly one place
  ([src/parsing.ts](../src/parsing.ts)) — `parseLocaleNumber` and its `parseKm`/`parseMeters`/`parseKmh`
  wrappers. Never write a second `parseFloat`/`replace`-based number parse anywhere else; import
  the canonical one. Two parsers means two behaviours means a bug.
- **Never blind-strip separators.** `,` and `.` are locale-dependent: one device's decimal point
  is another's thousands group. Detect the decimal separator (`parseLocaleNumber` already does);
  never assume, never `replace(/,/g, "")`.
- **Normalize once, at the boundary.** Parse phone strings into numbers as they enter app state
  (the `RideView` numeric fields), then compute and display from those numbers. Downstream code
  must consume normalized numbers, not re-parse raw strings ad hoc.
- **Every numeric path is tested in both locales.** Any change touching parsing/aggregation must
  keep both comma-decimal (`13,5km`, `20,0km/h`) and period-decimal (`13.5km`, `20.0km/h`)
  coverage green, using the real captured fixtures (e.g. `tests/fixtures/recon/2*_yal.xml`).
  A parsing change without a both-separators test is incomplete.

## Tech stack & commands

- **TypeScript 5.6** (strict), **Vite 6** (`base: "./"`, `target: "esnext"`), **Vitest 2** + **jsdom**, **leaflet** for maps.
- ADB transport: [`@yume-chan/adb`](https://github.com/yume-chan/ya-webadb) (Tango) — Chromium-only, secure-context only.
- `npm run dev` — Vite dev server (boots in demo mode with sample rides).
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

UI → Controller → (JobQueue · Store · BeelineApp) → Parsing → AdbDevice (real or demo).

| File | Responsibility | Key symbols |
|------|----------------|-------------|
| [index.html](../index.html) | App shell, markup, styles | — |
| [src/main.ts](../src/main.ts) | UI entry: DOM render + event wiring, demo ↔ real mode switch | `activate()`, `goDemo()`, `goReal()`, `applyState()` |
| [src/controller.ts](../src/controller.ts) | Orchestration + app state; scan/check/upload/cancel | `Controller`, `state()`, `onChange()`, `runTask()` |
| [src/beeline.ts](../src/beeline.ts) | Beeline app automation (the "what to tap") | `BeelineApp`, `Geometry`, `PROFILES` |
| [src/parsing.ts](../src/parsing.ts) | uiautomator XML → ride data | `parseJourneysList()`, `parseRideDetail()` |
| [src/jobs.ts](../src/jobs.ts) | Single-worker background queue with coalescing | `JobQueue`, `Task`, `TaskSnapshot` |
| [src/store.ts](../src/store.ts) | LocalStorage status cache (Python `rides.json`-compatible) | `Store`, `RideRecord`, `upsert()` |
| [src/track.ts](../src/track.ts) | GPS track decode/simplify/render | `extractTrack()`, `simplify()` (Douglas–Peucker), encoded polylines |
| [src/mapview.ts](../src/mapview.ts) | Map-view geometry: pick drawable tracks + hover/overlap hit-testing | `ridesWithTracks()`, `nearestRides()`, `RideTrack`, `ProjectedTrack` |
| [src/adb/types.ts](../src/adb/types.ts) | Transport-agnostic device contract | `AdbDevice`, `AdbError`, `shellQuote()` |
| [src/adb/webusb.ts](../src/adb/webusb.ts) | Real transport via Tango | `WebUsbAdb` |
| [src/adb/demo.ts](../src/adb/demo.ts) | Stateful fake device (no phone needed) | `DemoAdb` |

## Conventions

- **Strict TS**: full null-safety, `noUnusedLocals`/`noUnusedParameters` are on — no dead vars/params, no implicit `any`.
- **Naming**: `camelCase` functions (verb-prefixed: `parse…`, `upload…`), `PascalCase` classes/interfaces, `snake_case` string constants for storage keys.
- **Types**: `interface` for public contracts (`AdbDevice`, `RideRecord`); type aliases / discriminated unions for state (e.g. `TaskStatus = "queued" | "running" | …`).
- **Comments**: module-level docstrings explain purpose & design; `// -- section ----` headers group blocks; inline comments explain **why**, not what.
- **Async-first**: everything is `async/await` (WebUSB is async). Never block.
- **Subscriptions**: `onChange(fn)` returns an unsubscribe function — always store and call it on teardown.
- **Immutable-ish state**: mutate the `Store` only via `store.upsert(key, partial)`; let the Controller emit a change event to re-render.
- **No hardcoded screen coordinates**: derive every tap/swipe from `Geometry` (computed from `screenSize()`), so it works on any device resolution.
- **Transport abstraction**: code against the `AdbDevice` interface, never `WebUsbAdb`/`DemoAdb` directly — this is what keeps demo mode and tests working.
- **Minimal device round-trips**: every `uiDump`/tap/swipe is a real over-the-wire ADB call and the slowest thing we do (~10 s/ride already), so keep phone interaction quick — never add reads/gestures to the per-gesture happy path. Verify device state (foreground app via `currentFocus()`, current screen via `parseJourneysList`/`isRideDetail`) only at rare, high-stakes decision points — above all before marking a ride **deleted**, since one stray tap can drift us to another app/screen and an empty parse would otherwise look like "all rides gone". The guard `BeelineApp.onJourneysList()` is the canonical gate; `enumerateCatalog` returns a `complete` flag and `sweepTargets` pauses without deleting when that gate fails.
- **Unified map look & feel**: both Leaflet basemaps — the Explore per-ride mini-maps (`.rmap`) and the all-rides Map view (`#allRidesMap`) — share one dark, desaturated tile treatment (`.leaflet-tile-pane { filter: grayscale(85%) brightness(.6) contrast(1.1) }` over a `#05070a` container) so colored tracks pop consistently. Keep the two filter rules in sync; mini-maps draw a single ride with a white casing + solid orange line for legibility, while the Map view uses translucent overlapping lines as a heatmap.
- **Aligned group-header indicators**: in the year/month group headers (`.yhead`/`.mhead`), the title column (`.ytitle`/`.mtitle`) is fixed-width (`flex: 0 0 auto; min-width; white-space: nowrap`) so the progress bar (`.bars`, itself a fixed 90px) and the meta text start at the same x across every sibling row. Variable-length labels ("May 2026" vs "September 2026") must NOT push the bars/meta around or wrap — ragged indicators read as heavy and add cognitive parsing load. When adding columns to these headers keep them fixed-width so the row reads as aligned columns.
- **Status/progress messages**: say exactly WHAT is happening and WHY, verbosely if needed — never vague counts. When acting on a specific ride, name it with the params we know (e.g. `rideShortLabel(key)` → "Jun 13 14:22"), not "1 ride". Prefer "scrolling down to find Jun 13 14:22…" over "scrolling down — looking for 1 ride…". When several rides are involved, name the first couple and append "(+N more)".
- **Error handling**: throw/catch `AdbError` for device issues; wrap `localStorage` access in `try/catch` (private mode can throw — non-fatal); surface failures to the user via `toast(message, isError)` and fall back to demo mode rather than crashing.

## Domain notes

- **Expected data volume**: design and review every aggregate/render path for a power user's
  lifetime — **several thousand rides** and **tens of thousands of km** ridden. This is the
  target scale, not an edge case: totals, filters, stats, the map and the route-frequency
  heatmap must stay responsive at that size. Concretely — never materialise per-metre points
  for the whole dataset at once (the heatmap densifies only the visible viewport for exactly
  this reason), keep per-ride work O(1)-ish, and prefer culling/caching over recomputing the
  full set on every interaction. When adding a feature that scans all rides, sanity-check its
  cost against thousands of tracks before considering it done.
- **Ride keys** are human dates like `"Sat Jun 13 2026 at 14:22"`; months are `"2026-06"` / `"June 2026"`.
- **Timing profiles** (`PROFILES`: `safe`/`normal`/`fast`/`turbo`) trade robustness for speed; `turbo` skips upload-verification reads (optimistic) and is reconciled by a later Check.
- **Job coalescing**: consecutive `upload`/`status`/`download-gpx` tasks merge into one sweep — preserve this when touching `JobQueue`.
- Only the **Strava** upload path is automated (komoot is detected but left alone).

## Testing

- Tests live in `tests/**/*.test.ts` (Vitest + jsdom).
- **Parser tests** run against real captured Beeline screens in [tests/fixtures/recon/](../tests/fixtures/recon/) — reuse these dumps rather than hand-writing XML.
- **Integration tests** drive a full `Controller` + `DemoAdb` (no phone). Wait for async work with `await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false))`.
- Use the in-test `memStorage()` helper and a `makeController()` factory with an instant sleep — don't touch real `localStorage` or wall-clock delays in tests.
- **Demo GPX downloads never trigger a browser "Save As"**: `saveGpxFile()` in [src/main.ts](../src/main.ts) short-circuits when `isDemo` (demo bytes are synthetic; the route is still drawn on the map from the stored track). This keeps the browser-driven demo/test flow prompt-free — Chromium's "ask where to save each file" would otherwise pop a dialog per ride. Only real-device GPX is written to disk. Preserve this guard when touching the GPX save path.

## Gotchas

- UI automation is inherently brittle (~10 s/ride) and breaks if Beeline changes its layout — update coordinates/labels in [src/beeline.ts](../src/beeline.ts) and [src/parsing.ts](../src/parsing.ts) when that happens, and add a fresh fixture under `tests/fixtures/recon/`.
- WebUSB requires Chromium (Chrome/Edge) and a secure context (`localhost` or HTTPS); it is unavailable in Firefox/Safari.
- Keep new code dependency-light — this app intentionally has no backend and a tiny dependency set.
