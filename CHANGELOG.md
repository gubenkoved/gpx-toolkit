# Changelog (internal)

Internal intent log — **not** public release notes. One entry per *logical change*
(a feature/fix, with any `fixup!`-style follow-ups squashed into it). Each entry captures
the **intent** behind the change — the "why" that the terse commit messages omit — so both
humans and the assistant can read this file as a compressed history of decisions and values.

- **Newest first.** Add new entries at the top.
- **Format** per entry:
  ```
  ## <short title>
  - **What:** one line — what changed.
  - **Why:** 1–2 lines — the motivation / decision / value behind it.
  ```
- Keep it brief. Ground the "Why" in what the diff actually did, not speculation.
- See [.github/copilot-instructions.md](.github/copilot-instructions.md) → *Changelog* for when to update this.

---

## Drop the per-card "gps" badge in Beeline mode
- **What:** The `gps` ride-card badge is now hidden when the source is the Beeline
  account; the ADB path keeps it. The GPS filter chip is left untouched.
- **Why:** Beeline rides always arrive with their full track, so the badge was on
  nearly every card and carried no signal. The filter stays so the rare track-less
  one-offs are still findable on demand.

## Beeline account as a new ride source (v0.2.0)
- **What:** Added a **Beeline cloud account** source alongside the legacy ADB phone, behind a
  new `RideSource` seam ([source.ts](src/source.ts)) the Controller drives instead of talking to
  `BeelineApp` directly — implementations `AdbRideSource` (wraps the unchanged phone automation),
  `BeelineRideSource` ([beeline-source.ts](src/beeline-source.ts)) over a reverse-engineered
  Firebase backend client ([beeline-api.ts](src/beeline-api.ts)), and per-source demos. A startup
  **source picker** chooses the account (email/password), the phone, or a demo of either; each
  profile gets its own IndexedDB namespace, and the chosen one is remembered. Bumped to 0.2.0.

  The account source pulls the **entire** history — routes, stats, Strava status — in one request;
  uploads run server-side through a bounded concurrency pool. Everything that follows is a
  consequence of that mode:
  - **Rides & titles:** Beeline rides derive their key from `start`, keep the **full** inline
    polyline as their track (no simplification), and take their title from the user's own ride
    `name` when set, else a synthesized "Morning/Afternoon/Evening/Night ride", with the routed
    destination appended as a muted location suffix.
  - **Credentials:** the password is used once to get a short-lived in-memory token and is **never
    stored**; on reload the app shows cached rides offline and re-prompts (so a password manager
    can inject it) only when an action needs the account. Re-sync reconciles against the server —
    updating changed rides and soft-deleting removed ones while keeping their track/data.
  - **Streamlined chrome:** in Beeline mode the phone-only controls are hidden (interaction speed,
    scan presets, Check, per-phone Source filter, track-detail density) and "Scan" becomes
    "Re-sync"; GPX export is a single "Save .gpx" synthesized from the cached track (works offline).
    Added Beeline-only **Destination** and **Named** filter chips.
  - **Explore extras:** a full-screen single-ride route map with an along-track hover readout
    (distance + an **estimated** time/clock, clearly flagged since Beeline tracks carry no
    per-point timestamps).
  - **UX/fixes along the way:** clearer "Strava status" filter label, a "Change source" switcher,
    an escapable source picker, a dismissable/auto-fading error toast, and de-PII'd test/demo data.
- **Why:** The ADB path drives the phone UI ~10 s/ride; the Beeline backend returns the whole
  history at once and uploads server-side, so the account source is dramatically faster and is now
  the primary path. Keeping ADB behind the same `RideSource` interface left it as a faithful,
  unchanged legacy fallback.

## Favicon: a route-squiggle brand mark
- **What:** Added `public/favicon.svg` — a Strava-orange (`#fc5200`) winding ride
  track on the app's dark rounded tile, with an endpoint dot echoing the header
  brand `.dot` — and linked it from the `<head>`.
- **Why:** The app had no favicon (blank/default tab icon). The route-line motif
  reuses the existing visual vocabulary (map/heatmap tracks, accent colour) so the
  tab icon reads as the same product; an SVG keeps it crisp at any DPI and adds no
  dependency or build tooling.

## Toolbar & navigation cohesion: group controls and clarify the view tabs
- **What:** Grouped the controls in the header, scan bar and filter bar so each
  label stays attached to its control and related controls wrap as one block
  instead of as loose items, and replaced the push-apart spacer with a simpler
  right-alignment. Restyled the Explore/Map/Stats switcher as a proper tab bar
  (shared underline rail, accent-underlined active tab) instead of three separate
  pill buttons. Added a mid-range breakpoint that compacts the toolbars before
  they get cramped.
- **Why:** The toolbars were flat wrapping rows of many peer items, so a wrap
  could land anywhere — orphaning a label from its control or a lone button onto
  its own line — and the view tabs read as unrelated buttons with no sense that
  they switch sections. Grouping keeps related controls together as units and the
  tab styling makes the navigation obvious.

## Keep the Map/heatmap viewpoint stable across background data updates
- **What:** The all-rides Map and the Stats route-frequency heatmap no longer re-fit
  their bounds when a background job updates ride data while the view is open. Added
  `mapFitted`/`heatFitted` flags and made the mounts' `fit` tri-state (force on `true`,
  auto-fit only on the first draw, never on a background refresh); track lines / heat
  layer still rebuild so new data appears, the date-range Reset still reframes.
- **Why:** A job ticker firing `applyState → render → mount*` re-ran `fitBounds`, yanking
  the user's pan/zoom back to frame everything mid-interaction — disruptive and disorienting.
  Now new data shows up in place without stealing the viewport.

## Replace Unicode glyph button icons with inline SVG / CSS chevrons
- **What:** Swept the remaining raw Unicode glyphs off real buttons. The Scan button's
  `⟳` ([index.html](index.html)) and the mobile overflow `⋯` toggles plus the
  "N selected ✕" clear chip ([src/main.ts](src/main.ts)) now render crisp inline SVGs
  (refresh, kebab, X) styled `stroke: currentColor` like the existing job-bar/map icons;
  the year/month disclosure carets stopped swapping `▾`/`▸` text and instead draw the
  house-style two-border chevron via CSS, rotated by an `.open` state class. The new
  disclosure rule is scoped to `span.caret` so it can't collide with the
  `.split > button.caret` dropdown trigger (an unscoped `height` first shrank that button
  to a detached floating chevron). Filter-chip `✓`/`✕` were left as text (they read as
  state words inside the label, not standalone icons).
- **Why:** Font glyphs render off-baseline/blurry and inconsistently across fonts and DPI —
  exactly the "ugly icon" the Scan button showed — so every pictographic button now uses a
  pixel-snapped SVG (or the established CSS chevron) that inherits color and scales cleanly,
  matching the one unified icon language already used elsewhere.

## Persist Explore filters across reloads
- **What:** The Explore-list filter set (`const filters` in [src/main.ts](src/main.ts)) now
  round-trips through `localStorage` under a new `FILTERS_KEY`, just like the chosen
  view/mode/serial already do. Added `loadFilters()` — which seeds from `emptyFilters()`
  and **sanitizes every field** against its allowed values (status/gps/details/deleted
  enums, device passthrough, distance bounds via `sanitizeBound`) so stale or malformed
  storage falls back to neutral instead of corrupting the bar — and `saveFilters()`
  (try/catch, non-fatal in private mode). `saveFilters()` is called at the five mutation
  sites (status, chip cycle, clear, device, distance), leaving the pure `cycleChip`/
  `clearFilters` helpers untouched.
- **Why:** Filters reset on every refresh while view/mode/serial persisted, so a power user
  re-applied the same "pending + missing GPS" narrowing constantly. Persisting them (with
  strict load-time sanitization so bad data can never poison the list) lets the user resume
  exactly where they left off.

## Surface the ride selection in the header
- **What:** Made a multi-ride selection legible at a glance in [src/main.ts](src/main.ts):
  the batch-action buttons (`btnStatusSel` + its split caret, `btnGpxSel`, `btnGpxSaveSel`,
  `btnUploadSel`) are now `disabled` when nothing is selected (reusing the existing
  `button:disabled` styling) and carry a live count in their label (`Check selected (3)`);
  selected rows get a `.rrow.sel` class (accent inset stripe + faint tint, matching the
  `.fchip.on` accent); and the header totals' "N selected" turned into a clickable
  `.selchip` accent pill that clears the selection. The existing `if (!selected.size)
  return toast(…)` guards stay as defensive backups.
- **Why:** The selected count was buried in the muted totals line and the batch buttons
  looked identical whether or not anything was selected — clicking one just toasted "Select
  some rides first." Disabling/labelling them makes "nothing to do here" obvious, the row
  highlight shows *what* is selected, and the chip gives a one-click way out — all by
  enhancing the existing controls rather than adding a parallel selection bar.

## Unify the Source filter dropdown with the bar's design language
- **What:** Restyled the Explore-list `Source` device `<select>`: stripped the native OS arrow (`appearance: none`) and drew a CSS chevron via `.fdevice::after` reusing the `.menubtn` two-border recipe, and gave the pill the shared accent `.on` state (toggled in `syncFilterBar` when a non-"All" device is picked).
- **Why:** The native select arrow/popup rendered off-baseline and alien next to the chips and segments, and an active device filter never turned accent-orange like the GPS/Details/Deleted chips — so it both looked ugly and read as inactive. Now it matches the rest of the filter row.

## Icon-only map/heatmap controls + heatmap full screen
- **What:** Replaced the Map/heatmap floating buttons' visible Unicode glyphs
  (`⤢ Expand` / `▢ Select area` / `✕ Cancel`) with icon-only square buttons drawn
  from crisp inline SVG, swapping glyphs via CSS on `aria-pressed`/`.active`; gave
  the Stats heatmap its own Expand button mirroring the Map view's pseudo-fullscreen
  (`body.heat-expanded .freq-wrap`, Esc/view-switch exit). `createAreaSelect` now
  drives `aria-pressed`/`aria-label` instead of overwriting the button's content.
- **Why:** Raw Unicode glyphs render inconsistently across fonts/DPI and looked off;
  icon-only SVG buttons keep one unified control vocabulary across both maps, and the
  heatmap deserved the same full-screen affordance the Map view already had.

## Declutter the job/queue status bar
- **What:** Collapsed the secondary "Clear queue" and "Hide" controls into square
  icon buttons, let the live message wrap to two lines (instead of a one-line
  ellipsis), tightened the head-row gap, and red-tinted the "Stop" button.
- **Why:** The verbose progress message — which names the exact ride/step we're on,
  by design — was competing with three text-labelled buttons in one flex row and
  got ellipsized, hiding the very detail the user watches for. Freeing the row's
  width and allowing a 2-line wrap keeps that detail visible, while Stop stays a
  labelled, destructive-looking button so it's easy to find and hard to misfire.

## Dark-theme the native checkboxes
- **What:** Added `color-scheme: dark` to `:root` so the native ride/select-all checkboxes
  (and other form controls) render against the dark UI instead of the browser's light theme.
- **Why:** Unchecked checkboxes were drawn as bright white boxes because `accent-color` only
  tints the *checked* fill; the unchecked control kept its default light rendering and stood
  out against the dark app. One line fixes every native control at once and keeps the checked
  state Strava-orange and the select-all indeterminate dash intact.

## Selection actions folded into one "Check selected" split + clearer route wording
- **What:** Collapsed the four selection-scoped header buttons (Check selected / Preview
  selected / Save .gpx files / Upload selected to Strava) into one `.split`: "Check
  selected" is the default action, the caret reveals Preview routes / Save .gpx files /
  Upload selected to Strava. "Upload all pending to Strava" stays a separate primary
  button (it's not selection-scoped). Renamed the ambiguous "Preview" actions to name what
  they produce — "Preview routes" in the selection menu and "Preview route" per ride — and
  the tooltips now say a rough **GPS route** preview shown on the map (no file saved). The
  stale `data-gpxmenu` caret was rewired to the standard `data-splitmenu="sel"` toggle, and
  menu dismissal generalized to both static header menus (`#stateMenu`, `#selMenu`).
- **Why:** A row of five loose buttons crowded the header and buried the everyday action.
  Grouping the selection actions under their most-common entry ("Check selected") mirrors
  the new Data menu and reads as one tidy control, while leaving the headline "Upload all
  pending" prominent. "Preview" alone read as a generic UI preview; tying the word to the
  GPS route it downloads removes the ambiguity.

## Compact "Data" menu for state actions + local-size hint
- **What:** Folded the three header buttons (Import / Export / Reset) into one compact
  "Data" dropdown (reusing the `.split`/`.splitmenu` pattern), and added an
  always-visible pill next to the ride totals showing the local state size (e.g. "6 KB",
  "1.3 MB"). `Store` now tracks the serialized payload's byte size, refreshed only on the
  rare costly events (load, write, import, clear) and on construction, so `byteSize()` /
  `Controller.stateBytes()` stay O(1) per render. The trigger's chevron is drawn from CSS
  borders (matching `.caret`), not a `▾` font glyph — the glyph renders off-baseline/blurry
  across fonts, the exact "ugly arrow" the codebase already avoids for `.job-toggle`.
- **Why:** Three loose buttons cluttered the header; grouping them under one labelled
  trigger reads as one tidy control while keeping every existing handler/ID intact. The
  size hint gives the user honest feedback on how much they've accumulated locally
  (export to back up, reset to reclaim) without re-serializing on every frame — important
  at the thousands-of-rides scale this app targets.

## Denser default track preview + clearer inline number fields
- **What:** Default rough-track density bumped 10 → 20 pts/km; inline `.custom` number
  inputs (`last [n] days`, `Distance [min]–[max] km`, `pts/km`) now carry a subtle
  underline that goes accent on hover/focus.
- **Why:** 20 pts/km gives a noticeably truer route preview out of the box. The bare
  placeholders (`n`, `min`, `max`) read as static label text — an underline signals the
  blanks are editable without disturbing the compact inline layout. Persisted user
  densities are untouched; only the fresh/cleared default changes.

## Errors persist until acknowledged, and one bad ride no longer stops the batch
- **What:** Two robustness fixes. (1) Per-ride isolation: `sweepTargets()` in [src/beeline.ts](src/beeline.ts) now wraps each ride's `visit()` in try/catch with an `onError(key, reason)` channel — a throw is recorded, the list is recovered (`openJourneys`), and the sweep continues to the next ride instead of aborting; if even the recovery fails it pauses without marking anything deleted. `processTargets()` threads `onError` through, `downloadGpx()` reuses its existing `onFail` for navigation throws too, and `doTargets()` in [src/controller.ts](src/controller.ts) collects the failures and throws one aggregated, per-ride error at the end (mirroring the GPX-download pattern). (2) Persistent, stacked errors: [index.html](index.html) now renders an `#errstack` of one card per unacknowledged error; [src/main.ts](src/main.ts) `renderError()` merges failed jobs **and** standalone errors (connection/import/storage/action — now routed through a new `pushError()`), newest-first, each dismissed individually and never auto-cleared. Added [tests/upload-error.test.ts](tests/upload-error.test.ts).
- **Why:** A failure on a single ride used to bubble out of the sweep and abandon every later ride in the batch, and standalone errors only flashed a toast that the next status message silently overwrote. Both violated the core promise that progress is resilient and that an error is never lost without the user seeing and acknowledging it.

## Diagnostics: log full context when a ride import fails
- **What:** `importRides()` in [src/main.ts](src/main.ts) now `console.error`s the whole error (with stack) plus context — error name/message, whether a controller was wired up yet, demo mode, the file name/size/type, and the read length — and added a `reader.onerror` handler so a failed file *read* (not just a parse) is logged and surfaced too. The failure toast now leads with `err.name`.
- **Why:** A transient report of "Import failed: Cannot read properties of undefined (reading 'importJson')" carried no detail to troubleshoot from. This change is diagnostics-only — no root-cause fix or validation — so the next occurrence leaves enough breadcrumbs (state + stack) to pinpoint the cause.

## Mobile layout: responsive ≤768px with "⋯" action menus
- **What:** Added a `@media (max-width: 768px)` block plus a per-cluster "⋯" overflow toggle so the rides list, top toolbars, and Map view stop wrapping into many lines on phones. Group headers drop their fixed-width title columns + progress bar and float the secondary meta onto its own line; each per-year / per-month / per-ride action cluster (Check / Preview / Upload, incl. the nested split buttons) collapses behind a single "⋯" that opens a stacked floating menu; the Map view stacks its side list under the map. The header + scanbar are compacted too — smaller button padding/labels, hidden build-hash version, neutralised flex spacer — so the dense bulk-action rows pack tightly instead of stacking tall. Reuses the existing `openMenu` flag — the new `.ovr` toggle and `.ovr-items` wrapper are inert on desktop (`display: none` / `display: contents`).
- **Why:** The whole sheet was hard-coded for ~1000px desktop with zero mobile breakpoints, so fixed widths (64/132px titles, 90px bars) and three packed action buttons per row forced 2–4 line wrapping and felt bloated on a 375px screen. Collapsing actions behind one disclosure and decluttering the headers makes the daily-driver rides list read as one clean line per row on mobile while leaving the desktop layout untouched.

## Bring the Map's area-select to the Stats heatmap, with a matching ride list
- **What:** Extracted the Map view's rubber-band "Select area" gesture into a reusable, rendering-agnostic `createAreaSelect` controller (`src/areaselect.ts`) and mounted a second instance on the route-frequency heatmap. Drag a box (or click near a route) on the heatmap to select every ride crossing it; the matches render full-width below the map (`#heatMatched`), reusing the Map side panel's `.ms-matched` card styling. Refactored the Map view onto the same controller and extracted the shared `renderMatchedCards()` so both views render identical "Selected" cards; added `tests/areaselect.test.ts`.
- **Why:** The heatmap could only be filtered by date, so there was no way to ask "which rides go through *here*" — the question the heatmap most invites. Sharing one gesture controller and one card renderer keeps the two views' interaction identical and avoids duplicating ~120 lines of brittle drag/projection logic, honouring the repo's one-implementation rule. Heatmap selection is intentionally independent of the Map view's (separate state) and prunes keys whose track is no longer drawn after a rescan.

## Widen the Map and Stats views beyond main's 940px column
- **What:** Added a `@media (min-width: 1000px)` breakout so `#mapView` and `#statsView` grow to `min(96vw, 1200px)` (centred via `margin-left` math), while `main` and the view tabs stay at 940px. Full-screen Expand is explicitly reset back to normal flow.
- **Why:** Inside main's 940px column the all-rides map column shrank to ~648px and even basemap labels were cropped; the Explore list is fine at 940px so only the two map-heavy views break out. Centring uses margin (not `transform: translateX`) so no transformed ancestor hijacks the containing block of the full-screen map's `position: fixed` `.map-wrap`.

## Add Biome (format + lint) and a CI gate that runs type-check + lint + tests

- **What:** Adopted Biome 2.5 as the formatter and linter (`biome.json`), reformatted the
  whole codebase once, and added `lint`/`format`/`check`/`check:fix`/`verify` npm scripts.
  Enabled the type-aware async-safety rules `noFloatingPromises` and `noMisusedPromises` as
  errors (verified the scanner actually flags an unawaited Promise); kept the recommended
  set but turned off rules that fight this app's deliberate, safe patterns
  (`noNonNullAssertion` for the DOM `!` style, `useButtonType` since the SPA has no `<form>`,
  `noDescendingSpecificity` for the hand-authored cascade) and downgraded the noisy
  `useIterableCallbackReturn` to a warning. Fixed the one real `noVoidTypeReturn` and added
  two narrowly-scoped `biome-ignore`s (deliberate control-char filename sanitizer; nullable
  init-lock presence check). New `.github/workflows/ci.yml` runs `npm run verify` on PRs and
  non-`main` pushes; the existing Pages deploy workflow is unchanged.
- **Why:** LLM-driven edits need a safety net the type-checker can't give — above all
  catching a dropped `await` on a `uiDump`/tap that would silently break a sweep — and the
  repo previously ran no linter, no formatter, and never ran tests in CI (build ran only on
  push to `main`). This makes correctness checks enforceable and gates them on every PR.

## Disable per-ride "Upload to Strava" when already uploaded

- **What:** The per-ride Upload to Strava button is now rendered `disabled` (with an
  "Already uploaded to Strava" tooltip) when the ride's status is `uploaded`, and the
  `upload-one` click handler short-circuits with a toast as a defensive guard.
  `Controller.upload()` now also filters out already-uploaded keys at the single choke
  point every caller funnels through, so no path (per-ride, selection, month, year,
  all-pending) can submit a duplicate upload; the "Upload selected" button toasts when the
  whole selection is already on Strava.
- **Why:** Re-uploading a ride that's already on Strava is a no-op at best and a
  duplicate-risk at worst; greying out the button makes "nothing to do here" obvious and
  removes a foot-gun, while the controller-level skip guarantees correctness regardless of
  which UI entry point is used. Reuses the existing `button:disabled` styling.

## Aligned year/month group-header indicators

- **What:** Gave the year/month header title columns (`.ytitle`/`.mtitle`) a
  fixed width (`flex: 0 0 auto; min-width; white-space: nowrap`) in
  [src/style.css](src/style.css) so the progress bar (`.bars`) and meta text now
  start at the same x across every sibling row.
- **Why:** Variable-length month labels ("May 2026" vs "September 2026") pushed the
  bars/meta around and wrapped long names, making the list read as ragged and
  heavy to scan. Reserving the column turns each header into aligned columns,
  cutting the cognitive parsing load. Codified as a convention in the instructions.

## Zoom-adaptive route-frequency heatmap (no more beads)

- **What:** The Stats heatmap resampled tracks at a fixed 30 m, but `L.heatLayer`'s
  radius/blur are in pixels — so zooming in spread the points past the glow and they
  broke into visible dots. Spacing is now keyed to the current zoom/latitude/glow
  radius via `metresPerPixel`/`spacingForZoom` ([src/heatmap.ts](src/heatmap.ts)),
  clamped 1–30 m. To afford the 1 m floor without densifying every off-screen
  kilometre, `buildHeatPoints` gained viewport culling (`HeatBounds` +
  `segIntersectsBounds`, bbox overlap so crossing segments still count), and each
  sample's weight is scaled by `spacing/30` so a finer resample deposits the same
  glow energy per metre (no over-saturation). [src/main.ts](src/main.ts) feeds the
  padded map bounds + scaled weight and rebuilds on `moveend` (pan *and* zoom);
  the cache splits into a track-set key (re-scan/re-fit) and a view key (relayer).
- **Why:** Heat-point spacing must track on-screen scale, not stay fixed in metres,
  and the only way to keep that affordable at high zoom is to render just the
  visible slice — so the corridor glow stays continuous at every zoom, with the
  frequency gradient and performance intact.

---


- **What:** Removed the duplicate, buggy `parseKm` in [src/filter.ts](src/filter.ts) that
  blind-stripped commas (`"13,5km"` → `135`) and routed the whole app through the single
  locale-aware parser now living in [src/parsing.ts](src/parsing.ts) (`parseLocaleNumber` +
  `parseKm`/`parseKmh`/`parseMeters`; `stats.ts` re-exports them). `RideView` gained
  normalized numeric fields (`distance_km`, `avg_speed_kmh`, `max_speed_kmh`, `moving_sec`,
  `elapsed_sec`, `elevation_gain_m`, `elevation_loss_m`) computed **once** in
  `controller.state()`; filters, month/year rollups, speed chart, and all displays read those
  numbers instead of re-parsing raw strings. Display now formats every locale-sensitive figure
  canonically (`13.5 km`, `20.0 km/h`) regardless of the source phone's locale. Added a strong
  "Data ingestion integrity" section to the Copilot instructions, fixed the test that enshrined
  the bug, and added comma-vs-period coverage (filter band + controller boundary).
- **Why:** Two parsers meant two behaviours: stats were correct but the Explore list, distance
  filters and rollups inflated every comma-decimal device's distance/speed 10×, so totals were
  silently wrong with no way for the user to tell. Ingestion correctness is the foundation —
  if numbers come in wrong, nothing downstream matters — so the fix is one canonical parser,
  normalized at the boundary into app state, and tested in both locales.

## Map: area-select replaces per-frame hover
- **What:** dropped the Map view's mousemove hover hit-test (which, on every rAF frame,
  scanned all tracks × all points) in favour of a "Select area" toggle: drag a rectangle
  and a single `ridesInLatLngBox` filter selects every ride crossing it. Single-click
  still selects the nearest track (projected on-the-fly per click), and hovering a
  side-panel row still highlights its track. Removed the cached `projectedTracks` /
  `reprojectTracks` machinery and its `moveend/zoomend` rebuild; selection geometry now
  works directly in lat/lng (Liang–Barsky segment-vs-box test). Renamed the "pinned" set
  to "selected"; the side panel's block is now "Selected · N rides".
- **Why:** at 2000+ tracks the hover scan was O(tracks × points) per frame and made the
  map sluggish. A draw-a-box gesture runs the filter once on release, so cost is
  independent of frame rate and stays smooth at thousands of tracks — and doing the
  test in lat/lng also let us delete the per-pan/zoom pixel reprojection entirely.

## Map side panel: show the year in ride dates
- **What:** `rideShortLabel` now includes the year (e.g. `Jun 13, 2026, 14:22`).
- **Why:** the map side panel, stats "biggest ride" card, and Beeline progress messages
  all dropped the year, which was ambiguous once rides span multiple years.

## Heatmap thickness slider
- **What:** added a persisted "Thickness" slider above the Stats view's route-frequency
  heatmap that drives the `L.heatLayer` glow radius/blur (`heatRadius` in `Settings`,
  clamped 6–30 px, default 12). Dragging it updates the existing layer in place via
  `setOptions().redraw()` — no point rebuild or bounds re-fit.
- **Why:** the heat glow width was hardcoded (`radius 12 / blur 14`), so dense urban
  routes blobbed together while rural ones stayed wispy. Letting the user tune track
  thickness makes the frequency read legible at any zoom/area, and persisting it (like
  the trim / points-per-km sliders) keeps their preferred look across sessions.

## Filter the Explore ride list
- **What:** Added an always-visible filter bar above the ride list that narrows the cached rides (no phone I/O) by Strava status (All/Pending/Uploaded/Other), route-preview presence, checked-details presence, deletion, source device, and a distance min/max band — all AND-combined. GPS/Details/Deleted are one-tap tri-state chips; Source is a dropdown built from the devices actually present (plus "(no device)"); a Clear button and a "N of M rides" totals hint appear while filtering, and the empty state distinguishes "no rides" from "filters hid everything". The pure predicates live in a new `src/filter.ts` (unit-tested); `RideView` now carries `device_model` (already stored per-ride) so "source" had real data to filter on.
- **Why:** Once the cache holds many rides, finding the ones that still need work (e.g. pending + no preview, or a specific phone) meant scrolling. The filters reuse data already in `RideView`, so they stay instant and backend-free; extracting the predicates into their own module keeps `main.ts` the impure UI shell while making the matching logic testable like `parsing`/`track`/`mapview`.

## Let the live job pill be hidden and brought back
- **What:** Added a **Hide** button to the status/queue pill that collapses it to a small spinner+count handle (bottom-centre, same elevated surface); clicking the handle restores the full pill. A `jobHidden` flag holds the state across the ticker's re-renders and auto-resets when work ends so the next batch reappears on its own.
- **Why:** The pill is pinned over the content while work runs (~10 s/ride, often a long batch) and could sit in the way with no way to dismiss it. Hiding never pauses work — the handle keeps the spinner + ride count visible as a one-click affordance to bring it back, so the escape hatch stays laconic and reversible.

## Stop the Map date filter from covering the status pill
- **What:** In the Map view the floating status/queue pill (`.job`) now lifts above the bottom date filter (`.map-filter`) whenever that filter is visible — `body:has(#mapFilter:not(.hidden)) .job` raises its `bottom` and `z-index` so it clears and stacks above the bar. Fixed the stale `.map-filter` comment that claimed it already cleared the pill.
- **Why:** Both controls live in the bottom-centre slot and the full-width filter had the higher `z-index` (500 vs 50), so while a job ran the filter painted over the pill — hiding live progress and its Stop/Clear buttons. Lifting the pill (rather than only swapping z-index) keeps the slider *and* the pill usable, since they no longer overlap. Scoped to the inline Map view; full-screen Map intentionally stays map-over-everything.

## Read the ride title from the resting detail sheet, not the scrolled one
- **What:** `BeelineApp.readDetail()` now dumps the bottom-sheet at its resting position first (title/datetime/stats), then reveals the upload buttons only to read the Strava status, merging the two. The demo's `renderDetail` now hides the heading + datetime once revealed, mirroring a short screen — making the existing controller/GPX tests real regression guards.
- **Why:** The Check/GPX flow swipes the sheet up to expose the Strava button; on a short screen (YAL-L21) that scrolls the heading off the top, so the only title left was the list card's short name — the ", City" suffix the detail uniquely provides was lost. The unit tests passed because they fed the *resting* fixture directly and the demo unrealistically kept the heading visible when revealed, so neither exercised the scrolled flow the real Check uses. Reading the resting sheet is uniformly correct across screen sizes (one extra dump on tall screens where the heading would have survived).

## Never persist a stat value as a ride title (Check on a short screen)
- **What:** `parseRideDetail` now refuses stat-shaped text (`looksLikeStat`: distance/speed/duration/elevation values + stat labels) and action-button labels as the title, and the store scrubs such titles on load. Added a real scrolled-detail fixture (`22_detail_scrolled_yal.xml`) + parsing/store tests.
- **Why:** The Check flow swipes the detail sheet up to reveal the Strava button; on the YAL-L21 that pushes the heading *and* datetime off the top, so the top-most remaining text is a stat value (`20,0km/h`). The old title fallback persisted that as the ride title. Now the title stays empty when the heading is off-screen (the store keeps the scan-seeded "Morning ride"), and previously-corrupted titles self-heal on the next load.

## Stamp the source phone on each ride
- **What:** Added `serial()` to the `AdbDevice` contract (WebUsbAdb returns its USB serial — the private field was renamed `serial`→`serialNumber` to free the method name; DemoAdb returns `demo-serial`). `RideRecord` gained `device_model`/`device_serial` (blank by default, string-coerced on load for legacy records, optional in `UpsertFields`). The Controller caches the model + serial on `connect()` and a new `deviceFields()` helper stamps them onto every ride it writes — scan, detail Check, and GPX track. Added store round-trip/legacy-default tests and a controller test asserting the demo identity lands on scanned + checked rides.
- **Why:** The cache recorded *when* a ride was read but never *which phone* it came from. With more than one device in play (e.g. the YAL-L21 alongside a Pixel), per-ride device attribution lets us later tell rides apart by source phone. Per-ride (not global) keeps the attribution precise and backfills naturally on the next scan/check.

## Locale-resilient distance/elevation parsing (comma decimal separator)
- **What:** `parseKm`/`parseMeters` now route through a new `parseLocaleNumber` that detects the decimal separator instead of stripping every comma. `parseRideDetail` now anchors the title to the datetime line (node directly above it, same column) instead of taking the top-most text, and `textNodes` drops invisible `[0,0][0,0]` ghost nodes globally. Added real new-device fixtures (`20_journeys_yal.xml`, `21_detail_yal.xml`) plus tests.
- **Why:** A second Android device (YAL-L21, comma-decimal locale) exposed two parser bugs feeding the Check job. (1) `replace(/,/g, "")` turned `13,5km` into `135` — inflating distances ~10× across KPIs/records/charts; detecting the separator keeps both `20,834.6km` and `13,5km` correct. (2) The detail sheet renders a `Rate this route:` prompt and off-screen `Elevation` ghost nodes above the heading, so the old "top-most text" title scan picked `Elevation` as the ride title; anchoring to the datetime and dropping zero-area nodes makes title/stat detection device-independent.

## Date-range filter for the Map and Stats views
- **What:** added a dual-handle date slider to both the all-rides **Map** view (filters the
  drawn tracks + the side-panel list, with an "N hidden by the date filter" note) and the
  **Stats** view (filters the whole view — lifetime totals, records *and* the route-frequency
  heatmap). New pure, unit-tested helpers in [src/mapview.ts](src/mapview.ts) — `dateRange()`
  (day-snapped span of all dated rides) and `filterRidesByRange()` (inclusive window; rides
  with an unparseable date are never hidden). The UI layer ([src/main.ts](src/main.ts)) holds
  the slider as a session-only day-INDEX control: each view has its own independent range, the
  end handle covers its whole day (`ridesInRange` expands `to` to end-of-day), and day math
  goes through the calendar so it stays DST-safe. Filtering happens before `ridesWithTracks`
  so the existing track-signature redraw and pin-pruning fire for free; live drags skip the
  map re-fit (only `Reset`/view-switch re-frame). Slider floats top-centre over the map to
  clear the bottom-centre job pill.
- **Why:** with many rides the Map and heatmap turn into an unreadable tangle. A time window
  is the natural way to "narrow down" — and the same mechanics belong on the heatmap, so both
  share one tested filter. Kept it in the UI layer (controller stays unfiltered, like the
  Stats/Explore controls) and session-only to stay simple; undated rides are preserved so the
  slider can never silently drop data.

## Draw the "Up next" disclosure arrow with CSS instead of a font glyph
- **What:** Replaced the `.job-toggle::before` content from the Unicode `▸` (`\25B8`,
  "small right-pointing triangle") glyph with a CSS border-drawn triangle (0×0 box +
  solid borders); kept the rotate-90°-on-expand behavior driven by `aria-expanded`.
- **Why:** The `\25B8` "small triangle" variant renders inconsistently across fonts and
  collapsed into a tiny blue dot/blob rather than a clear chevron. Drawing it with borders
  removes the font dependency entirely, so the arrow is always crisp and points right when
  collapsed, down when expanded.

## Move the ride cache from LocalStorage to IndexedDB
- **What:** added a small async `KeyValueStore` backend (`src/kv.ts`: hand-written
  `idbBackend()` for production, `memoryBackend()` for demo/tests) and reworked `Store`
  to persist its single serialized blob through it — `Store.load()` is now async, while
  `save()`/`clear()` keep sync signatures and fire write-back writes (with a
  `QuotaExceededError`-aware toast). `save()` is **debounced** (coalesces a burst of
  mutations — slider drags, scan pages — into one write and serializes only once);
  `Store.flush()`/`Controller.flush()` force the pending write out, wired to
  `visibilitychange`/`pagehide` so the last mutation isn't lost on tab close. `Controller`
  now requires an injected store; `main.ts` awaits `Store.load(idbBackend())`, drops all
  LocalStorage code, and best-effort calls `navigator.storage.persist()` at boot.
- **Why:** the cache (rough GPS tracks included) had already passed 1 MB, heading for
  LocalStorage's ~5 MB per-origin ceiling. IndexedDB shares the much larger disk quota, so
  growth is effectively unbounded. Clean break, no auto-migration — the in-memory `Map` stays
  the source of truth, so only the persistence seam went async; users carry data across the
  boundary with the existing JSON export/import (kept untouched, still Python `rides.json`-compatible).

---

## Turbo far-scroll: predictive near-zone so clustered targets stop overshooting
- **What:** `sweepTargets()` now estimates how far the next target is *before* moving,
  using the visible page's own date span as a local "one screenful" yardstick, and drops
  from a momentum fling to a controlled drag once the target is within `NEAR_PAGES` (1.5)
  of that span. Applies to all fling-capable profiles (fast + turbo); safe/normal are
  unaffected. Added a turbo regression test for targets clustered just below the page.
- **Why:** In turbo the coarse phase chained up to 4 blind flings that each coast ~several
  screens, so closely-spaced rides got shot past and the *reactive* overshoot refinement
  only corrected after bouncing — "lightning fast but unusable". Slowing down predictively
  when we're already near the target keeps the speed for genuinely far jumps while landing
  cleanly on clusters, instead of overshooting and oscillating back.

## Stats view: lifetime totals, distance records and a route-frequency heatmap
- **What:** Added a third top-level tab ("Stats") next to Explore and Map. It shows
  lifetime totals (distance, moving time, elevation gain, ride count), distance-based
  records (biggest ride, best day/week/month), and a dedicated route-frequency heatmap.
  New pure modules `src/stats.ts` (`computeStats`) and `src/heatmap.ts` (`densifyTrack`/
  `buildHeatPoints`) carry the logic, with `leaflet.heat` rendering the map; covered by
  `tests/stats.test.ts` and `tests/heatmap.test.ts`.
- **Why:** The Map view's translucent overlapping lines only hint at how often a stretch is
  ridden. Resampling every track to evenly-spaced points feeds a true heat layer, so a daily
  commute glows while a one-off stays faint — answering "where, and how frequently" at a
  glance. Totals/records reuse the cheap per-ride scalars we already parse (no track decode),
  keeping the page fast and the new compute trivially unit-testable.

## Fix the "Up next" disclosure arrow alignment
- **What:** The queue toggle no longer swaps two different inline triangle glyphs
  (`▸`/`▾`); it now renders the plain "Up next (N)" label with a single `::before`
  arrow centered via flexbox and rotated 90° on expand, driven by `aria-expanded`.
- **Why:** The two glyphs sat at different baselines, so the arrow floated misaligned
  next to the label. Reusing the proven `details.help` summary-arrow pattern keeps it
  vertically centered and gives a smooth rotate instead of a baseline jump.

## Map view: clicking a route pins matched rides instead of jumping away
- **What:** A click on the map no longer redirects straight to Explore. It now pins the
  matched ride(s) into a "Matched" block at the top of the side panel — each with quick
  stats (date · distance · avg speed) and a persistent track highlight — plus a Clear
  button; a *second* click on a matched entry is what opens that ride in Explore. Clicking
  empty map clears the pin.
- **Why:** The old one-click jump lost map context and never showed *which* ride(s) you hit
  (overlapping tracks were ambiguous). A two-step pin → open flow keeps you oriented, makes
  overlaps explicit, and surfaces the key stats inline before you commit to leaving the map.

## Make the work queue legible: ride-accurate counts + an "Up next" panel

- **What:** Reworked the floating job pill into a small queue panel. The queued-count badge now counts **rides** (running + waiting, deduped via `active_keys`) instead of *tasks*, so a 12-ride month Check reads "12 rides queued" rather than the misleading "1 queued"; scans still count as one item. The running task shows an accurate, live **"Checking 3 of 12 rides"** title (backed by a new `progress {done,total}` field on `Task`/`TaskSnapshot`, incremented per ride in `doTargets`/`doDownloadGpx`) over the existing message line that names the specific ride/step, plus a thin determinate progress bar. An expandable **"Up next"** list reveals every still-queued task with a per-item remove (×) that calls `controller.cancel(id)`.
- **Why:** A month/year operation is a single coalesced task carrying many ride keys, so the old "N queued" (task count) badge undercounted the real work and the queue was otherwise invisible — you couldn't see what was running, how far along it was, or what was lined up behind it. Surfacing ride-level counts, per-task progress, and the pending list gives honest, at-a-glance visibility into the whole pipeline without breaking the single-worker coalescing model.

## Make demo mode obvious to enter and exit
- **What:** Added an explicit **Exit demo** control (reusing the header disconnect slot) that drops back to offline; made the **Demo** button a prominent accent button when no phone is connected; show a toast when entering demo; stopped the status pill from flashing "demo" on load (it now boots showing "not connected"); and corrected the Reset copy that wrongly claimed it returns to "demo mode" (it goes offline).
- **Why:** Demo mode was confusing — there was no clear way out, entry was silent, and the UI/copy implied the app booted in demo when it actually boots offline. These changes make the demo ↔ offline transition discoverable and the messaging honest.

## Tidy ride-card button row & fuse the split controls
- **What:** Fused the GPX "Preview ▾" split button into one segmented control (shared border,
  single internal divider, outer-radius only, per-segment hover) instead of a caret floating as
  a separate bordered pill; promoted per-ride **Upload to Strava** to a new softer `.accent`
  variant so it reads as the row's primary action without a wall of orange; renamed the
  month/year **"Get previews"** buttons to **"Preview routes"** (with a tooltip) to match the
  per-ride *Preview* action and *gps* badge; and collapsed the month/year **Check / Check all +
  Check new** pair into the same segmented split — **Check new** is now the primary (rides never
  detailed) with **Check all** tucked under the caret. Generalized the single open-menu state
  (`openGpxMenu`→`openMenu`, `data-gpxmenu`→`data-splitmenu`) and added a `checkSplit()` helper
  so both splits share one toggle / outside-click / Escape mechanism. The caret's `▾` glyph is
  hidden (kept only for the accessible name) and replaced with a crisp CSS border-drawn chevron
  so it's pixel-snapped and consistent instead of a tiny, dim, font-dependent triangle.
- **Why:** The standalone caret pill looked broken, the row had no clear primary, and the two
  Check buttons wasted space; "Get previews" didn't convey that it fetches GPS routes. Mostly CSS
  plus a small markup refactor — the per-ride and selection-toolbar split instances and all
  action handlers keep working.

## Improve deletion reliability
- **What:** Added foreground/screen guards (and demo coverage) before a ride is marked deleted.
- **Why:** Deletion is the one irreversible action — a single stray tap can drift to another
  app/screen where an empty parse looks like "all rides gone". Verify state at this high-stakes
  point so we pause instead of deleting on a false read.

## Smarter batch processing order
- **What:** The sweep now commits to one direction (nearer end first, then straight across to
  the far end) and holds it until that side is spent, instead of re-deciding per target.
- **Why:** Per-target "closest next" hopping made the processing order feel random and caused
  needless back-and-forth scrolling; a single monotonic pass is faster and predictable.

## Split GPX preview vs. file-save into two modes
- **What:** GPX flow gained an explicit preview-only mode (store rough track for the mini-map)
  vs. save mode (also hand the full GPX to the UI to write to disk); the two no longer coalesce.
- **Why:** Only saves emit a file, so merging previews and saves in one sweep would drop or add
  downloads — keeping them distinct preserves correct per-task behavior.

## Desaturate the Explore mini-maps too
- **What:** Applied the dark/desaturated tile treatment to the Explore per-ride mini-maps.
- **Why:** Unify the map look across the all-rides Map view and the mini-maps so colored tracks
  pop consistently against one dark basemap.

## Fast-scroll fling reliability
- **What:** Modeled "fling-deaf" devices (a fling that's counted but produces no movement) and
  tuned `fling_ms` so momentum flings register reliably on-device.
- **Why:** A missed/ignored fling was breaking the fast-scroll path; treat it explicitly and give
  the fling enough duration to land on real hardware.

## Access stored state without a phone connected
- **What:** Allowed viewing persisted ride state in the UI when no device is attached.
- **Why:** Reviewing previously-scanned rides shouldn't require a live phone connection.

## Tweak GPX filename format
- **What:** Adjusted the naming format used when saving GPX files.
- **Why:** Produce clearer, more consistent on-disk filenames.

## More reliable GPX download (reveal Options)
- **What:** Reading a ride detail swipes the sheet up to expose action buttons, which hides the
  top-right "Options" header; `revealOptions` now scrolls it back into view before export.
- **Why:** That hidden header was the exact condition that made export fail with "could not find
  Options" — restoring it makes the full export succeed.

## Map mode
- **What:** Added an all-rides Map view (`src/mapview.ts`): pick drawable tracks, render them as a
  translucent overlapping heatmap, with hover/overlap hit-testing; iterated on its visuals.
- **Why:** Give a single spatial overview of all rides, complementing the per-ride Explore maps.

## Improve smart scrolling algorithm
- **What:** Direction is now decided authoritatively from the list's newest→oldest order vs.
  remaining target dates; added a one-stall-retry / two-stall-confirm rule before accepting an end.
- **Why:** A single missed swipe used to end the sweep and wander off (or scroll down forever);
  treat one stall as a transient miss and stop only on a confirmed end.

## Fix map overlapping the status bar
- **What:** Adjusted map container styling so it no longer overlays the status bar.
- **Why:** Visual/layout correctness.

## Record ride detail while grabbing GPX
- **What:** A GPX export now reads and persists the ride's detail (title/stats/Strava status)
  even for a ride we never explicitly opened — just like a Check would.
- **Why:** Avoid leaving GPX-downloaded rides with missing metadata.

## Faster scrolls via momentum flings
- **What:** Introduced quick flicks whose reach scales with travel for the coarse phase, while the
  slow controlled drag keeps its fixed 5-row step.
- **Why:** A fling coasts several rows further than a slow drag, so reaching far-down rides is much
  faster without disturbing existing fine-step behavior.

## Show decimal point on the avg-speed chart
- **What:** Avg-speed chart values now show one decimal.
- **Why:** More precise readout.

## Optimize navigation for GPX download
- **What:** Restructured the detail-walk so a batch streams down through rides without bouncing
  back to the top between downloads; persists each ride's status immediately.
- **Why:** Eliminate the top-reset round trips — the second download of a nearby ride now needs
  almost no extra scrolling.

## Backfill missing summary data from checked detail
- **What:** When the list scan never captured a ride's distance/duration, Check now backfills those
  summary fields from the freshly read detail.
- **Why:** So the summary, distance chart and KPIs show real numbers instead of "?" and stay
  consistent with the expanded detail.

## Better user feedback during automation
- **What:** More specific status/progress messages about what the device automation is doing.
- **Why:** Surface exactly what's happening (and why) given each gesture is a slow over-the-wire
  round trip; vague counts aren't actionable.

## Filter outliers from avg-speed calculation
- **What:** Average-speed computation now trims outliers before averaging (with tests).
- **Why:** GPS noise / stops skew a naive mean; trimming yields a representative average speed.

## Simplify empty-state visual
- **What:** Streamlined the empty-details state styling/markup.
- **Why:** Cleaner, simpler empty state.

## Better GPX preview extraction approach
- **What:** Reworked rough-track extraction/storage so a downloaded GPX yields a preview track for
  the mini-map, threaded through the store and track modules.
- **Why:** Provide a lightweight route preview without a full save, with clearer separation of the
  preview path.

## Explore visuals polish
- **What:** Enhanced chart visuals, the empty-details presentation, and overall map visibility.
- **Why:** Readability and polish of the Explore view.

## Add "check without details" button
- **What:** Added a button to check the listed rides without expanding each detail.
- **Why:** Offer a faster, lighter check that skips the per-ride detail reads.

## Average-speed chart
- **What:** Added an average-speed chart (with supporting parsing and beeline changes).
- **Why:** Give riders an at-a-glance speed summary across rides.

## Reliable GPX download (diff-based detection)
- **What:** Detect the freshly-written GPX by diffing the Download folder before/after, with an
  independent `ls` cross-check and a dedup suffix for repeated filenames; plus added debuggability.
- **Why:** Beeline's SAF "Save" dialog reopens at the last-used folder and names files
  unpredictably, so we can't assume a path — diffing reliably finds the new file and the `ls`
  cross-check makes failure messages conclusive.

## Move styles into style.css
- **What:** Extracted inline styles from `index.html` into `src/style.css`.
- **Why:** Centralize styling in one stylesheet rather than scattering it in markup.

## Add reset button
- **What:** Added a button (and store support) to reset persisted state.
- **Why:** Let the user clear cached ride status and start clean.

## Fix ride-name rendering
- **What:** Fixed label rendering, including underscores in ride names being mis-rendered.
- **Why:** Ride titles must display verbatim, not be mangled by markup/formatting.

## Android-exclusivity notice + disclaimer
- **What:** Documented that the Beeline app must not be open elsewhere (Android exclusivity) and
  added a README disclaimer.
- **Why:** Set correct expectations and warn about the single-active-session constraint.

## Surface track-extraction failures
- **What:** Added a test pinning that a GPX we pulled but couldn't read a track from is reported as
  a real, persistent error rather than silently swallowed (ride not left with an empty track).
- **Why:** Lock in fail-loud error handling so a broken track can't masquerade as success.

## Preserve full ride descriptions
- **What:** Split the fuller checked title into the scan name plus a colored location suffix;
  seed the display title from the scan name until a fuller one is checked.
- **Why:** Keep the richer detail heading (e.g. added location) without losing the original
  short scan name.

## More resilient screen detection
- **What:** Hardened navigation to the Journeys list — a ride-detail bottom-sheet covers the
  nav bar, so while it's open only Back dismisses it; tapping the tab would hit the sheet.
- **Why:** Avoid getting stuck or mis-tapping when a detail sheet is open; mirror real-device
  behavior so screen detection stays reliable.

## Initial version
- **What:** First working app — vanilla TS SPA driving the Beeline app over WebUSB ADB to batch
  rides to Strava: parsing, automation (`beeline.ts`), job queue, store, track decoding, real and
  demo ADB transports, full test suite and fixtures.
- **Why:** Establish the backend-free, framework-free architecture and the demo/real transport
  split that the rest of the project builds on.
