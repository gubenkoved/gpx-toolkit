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

## selection actions hint their real applicable count
- **What:** every ⋯-menu "Selected" action that acts on only a *subset* of the selection
  now stamps that subset's count into its label and hides when the subset is empty —
  "Push N rides to Strava" (upload-capable & not-yet-uploaded), "Fetch full GPX for N
  rides" (not cached yet), "Resolve wind for N rides" (has a track & unresolved),
  "Delete N rides" (live, non-tombstoned). Push previously gated on merely `can_upload`,
  so it showed for an all-uploaded Beeline selection and then toasted "already uploaded";
  Fetch/Resolve previously always showed and toasted a no-op. Actions that always act on
  all N (Save route/full GPX, Tags…) stay label-only. The per-action subsets are derived
  once from a single `selRides` array via cheap ride-view flags (`can_upload`/`status`,
  `gpx_cached`, `hasResolvedWind`, `deleted`).
- **Why:** a control that's visible but a no-op is a bug per *show only what applies*, and
  the count makes each action self-explanatory against the "Selected (N)" header (the
  skipped rides become self-evident) without adding redundant chrome — applied
  consistently across the whole selection group so no action is the odd one out.

## drop "Push all to Strava" — one push route via the selection
- **What:** removed the `Push all to Strava` item from the ⋯ state menu (markup, its
  Beeline-only visibility gating, its confirm-and-upload handler, and the now-orphaned
  `.menu-accent` CSS). Pushing to Strava now goes through `Push selected to Strava` only.
- **Why:** two routes to the same outcome (push to Strava) is redundant — the accented
  "all" variant duplicated what selecting rides + "Push selected" already does, and the
  more explicit selection-scoped action is the safer single entry point. The Strava-status
  filter gating (`fStatus`) is untouched.

## full-GPX badges appear immediately after a backup import
- **What:** `Controller.importAllZip` now fires a final `notify()` after the restored
  GPX/wind blobs are written and the cache indexes are rebuilt. Previously the only
  post-import render happened right after the ride records landed but BEFORE the blobs
  were restored, so every ride rendered as un-cached (no full-GPX badge, "fetch full
  GPX" offered again) until a manual page reload corrected it. Added a populated-blob
  round-trip test that asserts the FINAL notify already sees the restored blob (the old
  tests only exercised an empty cache, so this regression was invisible).
- **Why:** importing a full backup appeared to "lose" the full GPX tracks fetched from
  Beeline — they were actually restored correctly (verified against a real 2231-entry
  backup: all 11 blobs round-tripped and matched their ride uids), but the stale first
  render made them look gone. The fix is a one-line re-render at the right moment, not a
  data change.

## borderless per-ride stats grid
- **What:** dropped the dark boxed background/border/radius on the expanded ride card's
  stats grid (`.stats`) and replaced it with a single hairline `border-top` divider plus a
  little breathing room; kept the compact stacked label-above-value cells and shrank the
  auto-fill track min (112px → 92px) so the full set of stats fits on one row at the capped
  desktop width while still wrapping gracefully on narrow viewports.
- **Why:** the panel filled with `var(--bg)` (the page background, darker than the card's
  `--panel` surface), so it read as a recessed black hole that fought the design language. A
  borderless grid on the card's own surface, separated only by a divider, is quieter and more
  consistent with the rest of the app.

## remove ADB screen-scraping rudiments (locale-string parsers + title scrub)
- **What:** deleted the last dead code from the retired ADB screen-scraping source: the
  localized-string numeric parsers (`parseLocaleNumber`/`parseKm`/`parseKmh`/`parseMeters`/
  `parseDurationSec`), the `metricsFromStatStrings`/`mergeMetrics`/`posOrNull` helpers, and the
  `looksLikeStat` stat-shape detector with its regexes/labels — none had a production caller.
  Also dropped the store's `BAD_TITLES` set + on-load title-scrub block (which cleared UI-chrome
  and stat-shaped titles), the unused `stats.ts` re-export, and the tests exercising the removed
  symbols. Rewrote the *Data ingestion integrity* instructions section to describe structured-only
  ingestion.
- **Why:** both live sources hand us structured numbers — the Beeline cloud API returns SI fields
  (`mapBeelineRide`) and GPX derives metrics from track geometry — so a title can never be UI
  chrome or a mis-captured stat value, and no metric ever arrives as a localized string. The
  parsing/scrub machinery only defended against the ADB screen-scraper, gone since v0.3.0; keeping
  it was dead weight documented as a live "core value". Numbers-matter ethos is preserved, retargeted
  at the numeric source mappers (normalize once, `null`≠`0`, explicit unit conversions).

---
- **What:** rides now carry their start INSTANT (`start_epoch`) + resolved IANA zone
  (`tz`), and the displayed datetime + default time-of-day name ("Morning ride") are
  rendered in the ride's OWN timezone — resolved once at ingest from the ride's start
  coordinate (Beeline polyline / GPX first point) via a lazily-loaded, code-split
  `tz-lookup` (DST computed by the browser's current `Intl`, so only rare 2019 border
  data is stale). New `src/tz.ts` centralises zone lookup + instant→wall-clock. Lists
  sort by the true instant across zones (`compareRidesByDateDesc` prefers
  `start_epoch`). Time is shown UNAMBIGUOUSLY: a compact zone tag "UTC+2 · Amsterdam"
  appears on a ride only when its offset differs from the viewer's; the detail sheet
  labels every reading (Ride time / Your time / UTC); a `title` tooltip carries the
  full breakdown. Store schema → v3 (additive; Beeline rides gain real values on next
  sync). Fallback = the viewer's browser zone when a ride has no location.
- **Why:** the user moved timezones and every ride's clock shifted with them — a ride
  done at 8am abroad should read (and be named) as an 8am local ride forever, not
  re-cast into wherever you happen to be now. Anchoring on the fixed instant + the
  ride's own zone makes ride times stable and correct; the explicit tags/labels make
  it impossible to misread WHICH time is shown. Builds on the Phase 1 push-id
  identity, which decoupled a ride's identity from its (now purely cosmetic) clock.

## beeline: key rides by push-id, not the local-time datetime (fixes tz-move duplication)
- **What:** a Beeline ride's storage identity is now its stable backend push-id
  (`beeline::<pushId>`) instead of its start datetime (`beeline::<Wed Jun 3 … 19:04>`).
  The source addresses rides by push-id (`byKey`, `RideCard.identity`, `RideDetail.key`,
  filenames/labels derive the datetime from `raw.start`); the controller builds the scan
  uid from `card.identity` and reconciles deletions against the REAL store uid, never a
  uid reconstructed from the datetime. A schema **v1→v2** migration re-keys existing
  Beeline records by their `source_id` and COLLAPSES the tombstoned-original +
  live-duplicate pair a tz move created into one live ride. The datetime lives on as the
  display `key` only.
- **Why:** the datetime was rendered in the browser's LOCAL timezone, so moving timezones
  re-keyed every ride — tombstoning all originals and re-fetching them as exact
  duplicates. The push-id is the ride's true, timezone-invariant identity (as the user
  put it: "we have IDs from Beeline that we should use"). This mirrors how GPX rides
  already use a content-hash identity, keeping the store uniformly identity-keyed.

## wind/speed: Length becomes a live min/max band filter (moved out of segment extraction)
- **What:** the "Min length" slider (which lived under *Segment extraction*) is replaced
  by a **Length** min/max band in the *Segment filters* row, alongside grade/speed/wind.
  It's now a cheap synchronous **post-filter**, not a chopper input: the segmenter emits
  down to a fixed 50 m noise floor and the Length band (default min 300 m, optional max)
  filters the cached segments live — no re-sweep, and it reports drops in the analysed
  note like the other bands. `minLenM` left `SegmentOpts`/the cache key.
- **Why:** Length never drove *where* the path is chopped (heading turn / stop / data gap
  do that) — it only dropped already-cut segments that came out too short. So it was a
  filter masquerading as an extraction knob, paying a full re-segmentation on every
  change. Moving it to the band row makes the categorisation honest, the interaction live
  and consistent with the other filters, and adds a max-length bound for free.

## wind/speed: unify grade + speed filters into the same min/max band controls
- **What:** replaced the four grade/speed range sliders (Min/Max grade, Min/Max speed)
  with two compact min/max number-input **band controls** (Grade %, Speed km/h),
  matching the Crosswind/Headwind/Tailwind filters — so all five segment filters now
  share one control idiom. Grade and speed became nullable-bound bands (blank = no
  bound) instead of slider sentinels: the `MAX_GRADE_OFF` sentinel, the per-bound
  reader/label helpers (`analyticsMaxGrade`/`analyticsMinGrade`/`analyticsMaxSpeed`/
  `analyticsMinSpeed`, `maxGradeLabel`/`minGradeLabel`/`minSpeedLabel`, `gradeDropLabel`)
  and the post-loop `speedCapIndices` step all collapse into the shared `readBand` +
  generalised `bandLabel` and one in-loop check. The max-speed GPS-glitch cap is
  preserved as a default of 50. The grade/speed/length filter controls reset to their
  defaults on first load after this change (they're not precious — no migration kept).
- **Why:** consistency — the grade/speed and wind filters did the same thing (keep
  segments within a band) through two different control styles and two parallel code
  paths. One idiom and one canonical band reader/label means less surface area, one
  behaviour to reason about, and a calmer, more uniform filter row.

## wind/speed: per-segment headwind + tailwind band filters; "Turn tolerance" down to 5°
- **What:** added two Crosswind-style min/max band filters to the Wind/Speed view —
  **Headwind** and **Tailwind** — each applied per segment on the signed along-track wind
  (headwind magnitude `max(0, −along)`, tailwind `max(0, along)`); the analysed-rides note
  reports how many segments each band dropped, and both bands persist across reloads. The
  crosswind band reader/label were generalised into a shared `readBand`/`bandLabel`. Also
  renamed the segment-tuning "Turn" knob to **"Turn tolerance"** and lowered its slider
  minimum from 15° to 5°.
- **Why:** when crosswind is on the X axis, segments that also carried significant head- or
  tailwind muddy the relationship being studied — these bands let you drop them (set a small
  Headwind-max + Tailwind-max) while keeping head and tail independently controllable. The
  lower turn tolerance allows chopping segments on gentler heading changes.

## wind/speed: distinguish fetchable "need full GPX" from untimed GPX in the analysed note
- **What:** the analysed-rides note (and the empty-chart message) split the single `needgpx`
  count by source: a Beeline ride still missing its download stays **"N need full GPX"**
  (fetchable), while a GPX-source ride imported from a file with no `<time>` is now reported
  separately as **"N GPX without timestamps"** (nothing to fetch). Phrasing is grammar-neutral so
  it reads for any N, and the note already wraps (a `flex-wrap` caption) so the extra fragment
  grows vertically rather than overflowing.
- **Why:** the old note lumped both into "need full GPX", which told users to fetch a timed GPX for
  rides whose GPX is already local and simply has no timestamps — a remedy the gate (correctly)
  never offers, so the count and the missing Fetch button disagreed. The split makes the note
  match what's actually actionable.

## wind/speed: add Min speed + Min grade filters; reorder controls to match the pipeline
- **What:** added a **Min speed** slider (0–40 km/h, left = "any") that drops crawling/near-stop
  segments, and a **Min grade** slider (0–20%, left = "any") that drops segments flatter than its
  |net grade| — pairing with Max grade to keep only a *band* of steepness (and dropping
  unknown-grade segments once either bound is set). Both are cheap live post-filters like their Max
  twins, with `≥N` / `any` outputs, accent fill, persistence, and analysed-note counts ("N under
  X km/h", band-aware grade wording: only-max "over X%", only-min "under Y%", both "outside Y–X%").
  Also restructured the Settings accordion to follow the computation pipeline: renamed *Segments* →
  **Segment extraction** (moved first) and *Filters* → **Segment filters**, and folded the
  standalone *Crosswind* band into Segment filters.
- **Why:** the view already had upper bounds on speed/grade; the matching lower bounds let you
  isolate hilly or faster stretches, which the wind-vs-speed question often wants. Ordering the
  groups extract → filter (with all post-extraction filters together) makes the controls mirror how
  the data actually flows, so the panel reads as the pipeline it drives.

## wind/speed: generalise "Flat segments only" into a Max-grade slider
- **What:** replaced the binary "Flat segments only" checkbox (a fixed 1.5% preset) with a
  **Max grade** slider (0.5–20%, top = "any"). Below the top it drops segments steeper than
  the set net grade — and any with unknown grade — generalising the old preset to a tunable
  threshold; at the top it's off (keeps every grade, like the old unchecked state). Wired as a
  cheap live post-filter (grade is precomputed per segment) like Max-speed, with an `≤N%` / `any`
  output, an analysed-note "N over X% grade dropped" count, and a prefs migration (`flatOnly:true`
  → cap 1.5%, else any). Replaces `FLAT_GRADE_PCT` with the shared `MAX_GRADE_OFF` sentinel.
- **Why:** a single fixed flatness cutoff is a blunt instrument — some questions want only truly
  flat stretches, others tolerate gentle grades. A slider lets the user dial in how much hill to
  forgive, mirroring the Max-speed knob, without adding a second control.

## wind/speed: fix highlight-ring alignment over dots
- **What:** the hover/selection rings are drawn on the `#windSpeedHover` overlay canvas,
  but the base scatter canvas has a 1px border and the overlay didn't — so the overlay's
  drawing origin sat 1px in from the dots and every ring landed slightly up-left of its dot.
  Gave the overlay a matching `1px solid transparent` border so the two content boxes line
  up pixel-for-pixel.
- **Why:** a ring that doesn't sit centred on its dot reads as a rendering bug; matching the
  border is the minimal, robust alignment (both canvases are `box-sizing: border-box`).

## wind/speed: consolidate prep actions into the centre gate card
- **What:** removed the standalone "Resolve wind for rides in range" / "Fetch full GPX for
  rides in range" button row (`.chart-controls`) that sat above the scatter. Those actions now
  live inside the centre confirm-to-run gate, under the "Analyse N rides" button (only shown
  when some rides in range actually need wind resolved or full GPX). Dropped the now-dead
  `syncAnalyticsActions`; the buttons keep their `#analyticsResolve` / `#analyticsFetchGpx`
  ids so the existing delegated handlers fire unchanged. Also darkened the `alongColor`
  diverging ramp's calm midpoint (dim, near-grey) so the legend/dots don't glow in the middle.
- **Why:** one card to act on — analyse, or first prepare the data — reads lighter than a
  separate always-there button row competing with the gate. The prep actions belong exactly
  where the user is already looking to trigger the run; consolidating loses no capability.

## wind/speed: selectable X axis (head/tailwind ↔ crosswind) + generic colour-by
- **What:** the Wind/Speed scatter's X axis is now a choice — head/tailwind (along-track,
  the old behaviour) or **crosswind magnitude** — via a segmented control at the top of the
  Settings accordion. The old "Colour by crosswind" checkbox was promoted to a generic
  **Colour by** segmented picker (Off / Head-tailwind / Crosswind); the dimension that's on
  X is hidden from the colour options (you can't colour by the axis you're plotting), and
  flipping X auto-switches an invalidated colour to the opposite wind dimension. The chart
  renderer (`drawWindSpeedChart`) gained `xValue`/`xSigned`/`xCaption` opts so crosswind plots
  one-sided `[0,max]` with no head/tail tinted halves; a new `alongColor` diverging ramp
  (headwind-red ↔ tailwind-green, mirroring the map) backs the head/tailwind colour mode, and
  the legend + KPI labels (still-air vs calm-air, tailwind vs crosswind slope) adapt to the
  axis. Prefs migrate the legacy `colorByCross` flag into the new `xAxis`/`colorBy` pair.
- **Why:** plotting speed against crosswind too lets you read the side-wind drag dependency,
  not just the head/tailwind one — the same regression machinery, a second question answered.
  Colour-by had to move up and generalise because tinting by crosswind is meaningless once
  crosswind is the axis; one generic picker keeps the two wind dimensions symmetric (whichever
  isn't on X can colour the dots) without a one-off control.

## datepicker: clear-this-date button in the calendar header
- **What:** the shared date-picker ([datepicker.ts](src/datepicker.ts)) gained an optional
  eraser button beside the month nav that clears just the bound being edited. It shows only
  when the picker has both an `onClear` handler and a current value, so an empty bound stays
  uncluttered. Wired into the Ridden and Added from/to pickers — clearing one date leaves every
  other active filter untouched (unlike the panel's "Clear filters", which resets everything).
- **Why:** there was no way to drop a single date bound without nuking the whole filter set;
  re-picking can't express "no bound". A per-field clear, right where the user is already
  looking (in the calendar), is the concise fix — and living in the shared picker, the Added
  field gets it for free.

## datepicker: zoom-out month/year navigation + fix close-on-navigate
- **What:** the shared date-picker popover ([datepicker.ts](src/datepicker.ts)) gained two
  zoom-out levels — clicking the header title steps day grid → month grid → year grid (and
  picking a cell zooms back in), so distant dates are a couple of taps away instead of one
  month-arrow click at a time. Also fixed a bug where clicking the month-nav arrows (or the new
  zoom title) **closed** the picker: the nav re-render detached the clicked button, and by the
  time the event reached the app's document-level click handler the orphaned target read as
  "outside the filter panel", so the panel (and picker) was dismissed. `onPopClick` now stops
  propagation so picker-internal clicks never reach that handler.
- **Why:** the freshly-added "Ridden" filter exposed both problems — navigation was unusable
  (the picker vanished on every arrow/label click) and, with rides spanning months/years,
  month-by-month stepping was tedious. The fix lives in the one shared picker, so the Added
  filter and the Timeline day-jump get the same zoom-out + reliable navigation for free.

## global filter: filter by the ride's own date
- **What:** added a "Ridden" date-range filter to the global filter panel — two `from`/`to`
  triggers (next to the existing "Added" ingestion-date field) reusing the shared date-picker.
  New `Filters.rideFrom`/`rideTo` bounds match each ride against its reference date
  (`date_key`, via `rideDatetime`) with the same inclusive local-day semantics as the
  ingestion band; persisted, counted in the active-filter badge, and reset by Clear.
- **Why:** users sort/group Explore by the ride's own date, so narrowing the library to a
  span of *ride* dates (e.g. "this summer's rides") was the obvious missing complement to the
  "Added" filter, which only narrows by when a ride entered the library. Built on the existing
  ingestion-date filter rather than a new mechanism, keeping one date-filter pattern.

## drop legacy "no cable" wording from source copy
- **What:** reworded the Beeline source description in the Sources picker (`index.html`) and
  the README intro — "with fast uploads and no cable" → "with fast, server-side uploads, all
  in your browser", and the README's "No cable, any modern browser" → "Works in any modern
  browser".
- **Why:** "no cable" was a relic of the removed ADB/phone-cable source (v0.3.0); with that
  source gone it contrasts against nothing and reads as meaningless to users. The cloud
  source's real benefit (fast, server-side, browser-only) is now stated positively. CHANGELOG
  ADB mentions are historical and left intact.

## ridemap: hide the empty wind-info strip when wind isn't resolved
- **What:** the wind summary strip (`#rideMapWind`, the faint-blue band that shows the
  resolved head/tailwind + data provenance) was leaking as an empty ~15px band between the
  stats summary and the map whenever wind wasn't resolved. Root cause: this sheet has no
  global `.hidden` rule, and `.ridemap-wind` never backed its own — so the element's
  `hidden` class did nothing and it rendered empty. Added `.ridemap-wind.hidden {
  display: none }`.
- **Why:** an empty coloured band reads as a broken/unexplained gap; the strip should only
  occupy space when it actually has wind content to show.

## ridemap: show the wind dial only in wind colour mode
- **What:** the hover readout's wind dial (the little compass pill) now appears only when
  the route is in **wind** colour mode. Previously it surfaced on hover whenever wind had
  been resolved for the ride — so after resolving wind once, it kept showing as a narrow
  pill even in plain/height/speed modes. Gated the dial on `rideMapColorMode === "wind"`,
  and it's dropped immediately when you switch colour mode away from wind (not lingering
  until the next hover).
- **Why:** the dial is the live readout *for* the head/tailwind colouring; outside wind
  mode it's just stray, unexplained chrome. Tying it to the mode keeps the readout honest —
  it shows wind only when wind is what you're looking at.

## ridemap: stop the bar resizing when you start hovering the track
- **What:** in the full-screen ride map, entering scrub mode (hovering the route / dragging
  the profile) no longer changes the header bar's height. The toolbar is the bar's tallest
  child; scrub mode used to `display:none` it, so the bar collapsed by a few px to the
  shorter readout — a visible, jerky jump on every hover (the `min-height: 51px` floor was
  below the real ~54px control-row height once the seg controls show). Now scrub mode keeps
  the toolbar occupying its full height (collapsed to zero width + `visibility:hidden`)
  instead of removing it, so the bar box is byte-for-byte identical resting vs scrubbing
  while the freed width still gives the live readout centre stage.
- **Why:** the resizing read as jerky/broken; holding the bar height truly constant
  (verified delta 0 in-browser) makes scrubbing feel stable, and tracking the real toolbar
  height auto-covers the compact-fold case rather than relying on a magic pixel floor.

## strava: quiet the per-card upload button, add "Show in Strava"
- **What:** the loud accent "Push to Strava" button is gone from the always-visible ride
  row; per-ride upload now lives as a quiet item inside the `⋯` overflow menu (bulk "Push
  selected to Strava" is unchanged). A new "Show in Strava" overflow item opens the ride on
  strava.com when its activity id is known. To make that link possible, the Strava activity
  id Beeline already reports (`raw.strava_activity.id`) is now persisted: a new optional
  `strava_activity_id` threads through `mapBeelineRide` → `UpsertFields`/`RideRecord` →
  `RideDetail`/`persistDetail` → `RideView`, populated on the next pull/upload (no schema
  migration; absent ids never clobber a known one).
- **Why:** the per-card upload button grabbed too much attention for a secondary action —
  *simplify by consolidating, never amputating*: the capability stays (menu + bulk), it's
  just no longer shouting. "Show in Strava" closes the loop for already-uploaded rides, and
  is gated on a real signal (a known id) so a GPX-only library never sees it.

## filters: hide a chip when it can't actually narrow anything
- **What:** every binary toggle filter chip (Route, Full GPX, Destination, Named,
  Deleted, Wind) now shows only when the library is *split* on that dimension — some
  rides match the predicate AND some don't. A library where every ride has a route, or
  carries Full GPX, no longer shows that chip at all. The decision is extracted into a
  pure, DOM-free `discriminatingDims(rides)` in [src/filter.ts](src/filter.ts), built on
  a shared `togglePredicate` map that is now the SINGLE source of truth for each toggle
  dimension — `matchesFilters` (to filter) and the chip-gating (to decide visibility)
  both read it, so they can't drift. `syncFilterBar` just maps the returned set to chip
  visibility (and neutralizes any active filter on a hidden chip).
- **Why:** *show only what applies* — a chip that can only ever be a no-op is clutter and
  a false affordance. Gating purely on the real diversity signal (not a source/mode flag)
  also subsumes the old Beeline gate: a GPX-only library naturally drops Route/Full GPX/
  Deleted, while Named correctly appears when some imported names are real and some
  synthesized. Pulling the logic out of the DOM glue makes it unit-testable — 6 new
  filter tests cover the diversity decision AND assert the shared predicate agrees with
  `matchesFilters` for every dimension (the guard against drift).

## ride-map: keep the wind dial's value from jumping as you scrub
- **What:** the hover readout's wind pill (`.rmh-dial`) is pinned to the bar's right
  edge, so when its km/h value changed digit count while scrubbing (`8` → `12`), the
  whole pill grew leftward and its compass icon visibly hopped sideways. The numeric
  value (`.rd-val`) now reserves a fixed `min-width: 2ch` (right-aligned, tabular) so
  1–2 digit speeds — the entire realistic wind range — never change the pill's width.
- **Why:** with scrub mode giving the readout centre stage, a twitching wind indicator
  is exactly the kind of micro-jitter that reads as unpolished; reserving space holds it
  rock-still without moving it off the right corner.

## ride-map: a transient "scrub" mode that clears the bar while you follow the track
- **What:** while you actively follow the route (desktop hover) or drag the elevation
  profile, the full-screen map's header strips down to just the live readout + the
  right-pinned wind dial — the ride title, the whole control cluster and the Close
  button hide (via a `.scrubbing` class on the modal), giving the data the full bar
  width. It's transient: it restores the instant the pointer leaves the route or the
  finger lifts, so the normal toolbar is always one small move away. The bar carries a
  `min-height` matching its control row, so hiding the controls can't change the bar's
  box at all — which kills two glitches at once: the header no longer jumps height, and
  (because the bar's own ResizeObserver drives the icon-fold) the buttons no longer
  unfold/refold for no reason as you enter/leave the mode. A mobile map *tap* deliberately
  stays out of scrub (it's a discrete inspect, and dragging the map pans it); the gesture
  is reserved for the profile drag and desktop hover. Esc still closes throughout.
- **Why:** the earlier flex fix stabilised the bar but left the readout fighting the
  toolbar for width, so the live distance/speed/elevation details got ellipsised away
  exactly when you wanted them. Hiding the chrome while you're "discovering" a point on
  the track gives the readout room to show everything, and auto-restoring keeps the full
  toolbar reachable.

## ride-map bar: stop the toolbar jumping on hover
- **What:** the full-screen ride map's header no longer reflows as you scrub the track
  or profile. The live hover readout (`.rmh-text`) and the wind pill (`.rmh-dial`) shared
  the toolbar's flex row and, being `nowrap` with no `min-width`, grew/shrank with each
  hovered point — shoving the control cluster, which tripped the icon-fold and made the
  buttons jump. The readout now claims exactly the leftover space (`flex: 1 1 0;
  min-width: 0`) and ellipsises its text within that fixed box, and the wind dial is
  pinned to the box's right edge (`margin-left: auto`) so it holds a stable position.
- **Why:** a header that twitches on every hover is distracting and makes the controls
  hard to hit; the toolbar's compact-fold should track the viewport width, not the
  transient readout content.

## ride-map profile "hide stops" switch
- **What:** added a subtle `.rmb` toggle to the single-ride map's elevation/speed
  profile that collapses every no-movement stretch out of the chart — each detected
  stop contributes zero width so the moving sections fill the graph, and a thin dashed
  cool rule (`.rp-cut`) marks where the track was cut instead of the grey stop band.
  Reuses the existing `stableStoppedRanges` detection; works on both the distance and
  time axes (the bottom-right extent label then reflects the moving span actually drawn).
  Off by default; the button shows only when the profile is open and a real stop exists.
  When ON it lights up with the shared accent fill (a new `.ridemap-tools > .rmb.active`
  rule mirroring `.seg button.active`), so the toggle — and the Wind toggle beside it —
  reads as "on" the same way the segmented controls do.
- **Why:** rides with long pauses (lights, cafés, the time axis especially) waste chart
  width on flatlined idle stretches; letting the user fold them away makes the moving
  profile far more legible while still flagging where the cuts happened.

## ingestion-date ("Added") range filter
- **What:** added an "Added" from/to date filter to the global filter panel that
  narrows the library by each ride's *ingestion date* (when it entered the library,
  `RideRecord.ingested_at`) — independent of the ride's own date. Bounds are
  inclusive whole local days (from → start-of-day 00:00:00.000, to → end-of-day
  23:59:59.999); legacy rides with no recorded ingestion date are excluded once
  either bound is set. Both triggers reuse the shared styled date-picker
  (extracted from the Timeline view into `src/datepicker.ts`), constrained so the
  two bounds can't cross. Wired through `Filters`/`matchesFilters`, so it applies
  uniformly across Explore, Map, Stats and Wind/Speed. To smooth the rollout, the
  store backfills any legacy ride missing `ingested_at` with "now" once on load
  (and persists it), so every ride has a defined ingestion date from day one.
- **Why:** a power user re-importing or syncing history wants to find "what did I
  just add", which the ride-date filter can't express. Reusing one canonical
  date-picker (rather than the unstylable native `<input type="date">`) keeps the
  control consistent with the rest of the UI and removes the Timeline's private
  calendar copy.

## drop the "rough approximation only" route note
- **What:** Removed the per-ride caveat shown under imported-GPX mini-maps
  ("Rough approximation only — not the full GPX") in `trackBlock`, plus its now-dead
  `.rmapnote` CSS and the `source` plumbing it needed.
- **Why:** The note added clutter without telling the user anything actionable; the
  mini-map already reads as a simplified sketch, so the caption was just noise.

## privacy-friendly usage analytics (GoatCounter)
- **What:** Embedded the cookieless GoatCounter counter (`index.html`) plus a tiny
  fail-soft seam ([src/analytics.ts](src/analytics.ts)) with two primitives:
  `trackView(view)` for per-view usage (fired from `setView`) and `trackEvent(name)`
  for a handful of key actions — `demo`, `beeline-connect`, `beeline-pull`,
  `gpx-import`, `location-import`, `strava-upload`. No personal data, GPS, emails or
  tokens are ever sent — only a synthetic path/event name; the script auto-skips
  localhost and both helpers no-op until it loads.
- **Why:** Wanted a lightweight signal of whether the app is actually used (and which
  features), without any user tracking. Kept the instrumentation to one canonical
  helper and the existing action funnels so it stays unobtrusive.

## gpx-relay: optional free durable persistence (DynamoDB) for stats + rate limits
- **What:** The relay can now persist its rate-limit counters, the global monthly cap and
  the lifetime download stats in a shared **DynamoDB** table (new `DDB_TABLE` env var;
  unset = the existing in-memory behaviour, so nothing changes by default). Counters use
  atomic `ADD`, ephemeral rate-limit windows auto-expire via TTL, and any store error
  **fails closed** (503, no upstream egress) so the cost ceiling holds during an outage.
  `deploy.sh` provisions everything idempotently (table at provisioned 5/5, TTL,
  least-privilege `GetItem`/`UpdateItem` IAM policy, `DDB_TABLE` wiring) and now defaults
  reserved concurrency to **2**. GET liveness reports durable counts + a `persistence`
  field. Added `@aws-sdk/client-dynamodb` as a **dev-only** dependency for test mocking
  (the SDK is runtime-provided in Lambda, so the deploy zip stays dependency-free). Relay
  package bumped 1.1.0 → 1.2.0.
- **Why:** The in-memory counters reset on every cold start and were only exact at
  reserved concurrency = 1. DynamoDB's *always-free* tier (25 GB + 25 WCU/RCU, no expiry)
  makes the stats and limits durable across cold starts AND exact across containers at
  $0 — which is what lets concurrency safely rise to 2 for faster parallel backfills.

## refactor: collapse the Wind/Speed controls into one grouped Settings accordion
- **What:** Replaced the three accordion cards (Settings / Crosswind / Segments) with a
  SINGLE "Settings" accordion (`#accSettings`, open by default) whose body splits the
  controls into all-caps labelled groups (FILTERS, CROSSWIND, SEGMENTS). Each group is a
  tight cluster — a quiet uppercase caption sitting directly above its own control row
  (`.ctl-grp` / `.ctl-grp-head` / `.ctl-grp-row`) — with the hairline separator BETWEEN
  adjacent groups (never under a header, which read as splitting it off from its controls).
  Inner-control styling re-scoped from `.ctl-acc-body` to `.ctl-grp-row`.
- **Why:** Three separate cards (three borders, three chevrons) read as too many
  accordions. One card with quiet between-group separators is lighter and more cohesive,
  while still collapsible to a single bar.

## refactor: fold the Wind/Speed basics into a Settings accordion
- **What:** Wrapped the two basic filters (Flat segments only, Max speed) in a third
  `<details>` accordion card ("Settings", open by default) matching Crosswind/Segments,
  so the whole control area is one cohesive stack of accordion cards. The contextual
  resolve/fetch action buttons moved below the stack (`.chart-controls`, no own margin
  so they leave no gap while hidden).
- **Why:** The basics sat as a loose row above the two accordion cards, reading as a
  different style. Folding them into a peer accordion (kept open so the primary filters
  stay visible) makes the area visually consistent.

## fix: hide the Wind/Speed hover tooltip at rest (stray accent pill)
- **What:** Added a `.chart-tip.hidden { display: none }` backing rule. The hover
  tooltip (`#windSpeedTip`) is shown/hidden purely via the `hidden` class, but this
  sheet has no global `.hidden`, so the empty tooltip rendered as a stray
  `--accent-dim`-bordered pill at the chart's top-left until the first hover.
- **Why:** Pre-existing gap from the "tap a dot" feature, surfaced while polishing the
  controls. Same class of bug as other components here — each must back its own
  `.hidden` state explicitly.

## feat: fold the Wind/Speed advanced knobs into Crosswind + Segments accordions
- **What:** Reworked the wind-vs-speed control bar. The two basic filters (Flat
  segments only, Max speed) stay visible; the two advanced groups (Crosswind,
  Segments) each became a self-contained `<details>` accordion card (`.ctl-acc`):
  a clickable header with a rotating CSS chevron, collapsed by default, whose own
  controls expand directly beneath it. Native `<details>` drives open/close (no JS
  toggle, no persisted flag).
- **Why:** The first pass used one detached "Tweak" panel whose button read as
  disconnected from what it opened. Per-group accordions keep each knob visually
  attached to the group it belongs to, read consistently, and give a calm default
  look without losing any capability.


## feat: tap a Wind/Speed dot to find + open its ride
- **What:** Made the wind-vs-speed scatter interactive. `drawWindSpeedChart` now returns
  a hit-test layout (`ChartLayout`/`ChartDot`, CSS-px dot geometry); new pure
  `nearestDot()` maps a pointer to the closest dot and `drawDotHighlights()` rings it +
  all its ride's sibling dots on a dedicated overlay canvas. In the view: hovering a dot
  (precise pointers only) shows a tooltip with that segment's wind/speed/length/grade and
  rings it; tapping/clicking pins it, ringing every segment of that ride and revealing a
  card below the chart (reusing the `.ms-matched`/`.ms-item` vocabulary) that names the
  ride and opens it in Explore on click. New `WindSpeedDeps.openRide` wires that to the
  existing `openRideInExplore`.
- **Why:** A dot is a roughly-straight stretch of some ride, but until now there was no
  way to tell *which* ride a point came from or get to it — the chart was read-only. This
  closes that observability gap. Tap-to-select + an in-flow card (not a hover-only
  tooltip) keeps it usable on touch, matching the Map/Stats "select → card → open"
  pattern; the highlight rides on a cheap overlay so the base scatter is never redrawn for
  hover, staying responsive at the thousands-of-rides scale.

## feat: replace selection "Drop deleted" with "Delete selected"
- **What:** dropped the selection-driven "Drop deleted" bulk button and added a "Delete selected"
  selection action that tombstone-deletes the live rides in the selection (source-aware confirm:
  Beeline rides leave the account, imported rides lose their stored GPX). Runs as ONE queued
  `delete` sweep via a new `Controller.deleteRides`; `doDelete` now loops over the task's keys.
  Drop is still reachable per-ride ("Drop from library") and globally ("Drop N deleted").
- **Why:** the selection "Drop deleted" was a confusing near-no-op — it only acted when the
  selection happened to contain already-deleted tombstones. Bulk *delete* is the action users
  actually want on a selection of live rides; purging tombstones stays per-ride + global.

## fix: order/bucket/label by reference date, never the content-addressed uid
- **What:** established a hard invariant — a ride's uid/key is **identity only**; everything date-related
  (sort, month/period bucketing, range-filtering, granularity, date labels) reads the ride's **reference
  date** (`date_key` on `RideView`, `rec.key` on the record). Switched every date-deriving call site off
  `.key`: Explore month sort, Selected/Map/Wind-Speed sorts + labels, `dateRange`/`filterRidesByRange`,
  `computeStats`/`autoGranularity` inputs, the stats chart `bucketRide`, and the single-ride map's start
  instant. Added a `rideLabel(name, dateKey)` helper (name-driven, reference date in parens — "Béthune
  loop (Jun 13, 2026, 14:22)") and a controller `uidLabel(uid)` that resolves a record's name+date;
  used them for the side panels, queue/task labels, bundle names and progress messages so a GPX ride
  never shows its `gpx::sha256:…` hash. The GPX **reference date** now falls back to the **upload
  instant** (was the file mtime) when no `<time>`/filename date is present, and is **stamped once** on
  first import (preserved across idempotent re-imports, like `ingested_at`). Ride-list sorts use a new
  `compareRidesByDateDesc` that breaks reference-date ties by **name** (A→Z, case-insensitive) so
  same-minute imports (e.g. GPX files sharing an upload instant) order stably instead of arbitrarily.
- **Why:** content-addressing made a GPX uid a hash, so any code that parsed a date out of the uid got
  `null` — sorting every imported ride after all Beeline rides, mis-bucketing stats, letting them ignore
  the map date slider, and printing the raw hash as a user-facing label. The reference date is the right
  axis for all of that; the hash is purely storage identity. Making the upload-instant fallback safe (it
  no longer feeds identity) and set-once keeps a timeless ride's date stable instead of jumping on every
  re-import.

## feat: "Drop deleted" — permanently purge tombstoned rides
- **What:** Deleted rides (soft-delete tombstones kept indefinitely) can now be permanently
  dropped from local state. Added `Store.remove()` (hard delete) + `Controller.dropDeleted(keys?)`
  which removes only `deleted` records, clears each ride's full-GPX blob (cache for Beeline, data
  vault for imported GPX) and in-memory wind state, and reports the count. Three entry points:
  per-ride "Drop from library" on deleted rows, "Drop deleted" in the Selected menu (deleted subset
  of the selection), and a global "Drop N deleted" in the ⋯ menu shown only when tombstones exist.
  All confirm with a count.
- **Why:** Tombstones accumulated with no way to reclaim their space short of a full reset. Drop is
  strictly guarded to deleted-only (never a live ride), local-only (a Beeline tombstone is already
  gone upstream; a GPX ride's bytes were removed at delete time), and leaves the shared per-cell
  wind cache untouched.

## fix: importing several GPX files collapsing into one ride (content-addressed GPX identity)
- **What:** GPX rides are now identified by a **content hash** of their bytes (`gpx::sha256:<128-bit>`)
  rather than their minute-resolution start datetime. `GpxRideSource` mints the identity in
  `importOne` (SHA-256 via SubtleCrypto, `crc32:<hex>-<len>` fallback) and keys both the data-vault
  blob and `source_id` by it; `RideCard` gained an optional `identity` (the uid suffix) while `key`
  stays the display datetime; `Store.upsert` accepts an explicit `key` field and `ingest` trusts the
  stored `key` for content uids (deriving it from the uid only when the suffix is itself a datetime,
  so Beeline + already-imported GPX are unchanged); `controller.state()` now reads the real Store
  Map key instead of reconstructing `rideUid(source, datetime)`; `gpxDownloadName` takes an explicit
  datetime so the human "Save As" stamp survives.
- **Why:** ride keys are minute-resolution (`Wed Jun 3 2026 at 19:04`) and the uid was `gpx::<key>`,
  fusing storage identity with the display datetime. Route-style GPX files carry no `<time>` and
  often no date in the filename, so they all fell back to the file's `lastModified` — identical when
  files are downloaded/saved together — producing the SAME key, and the per-uid upsert silently
  overwrote each previous ride, collapsing N files into one. Content addressing fixes this at the
  root: distinct files get distinct identities regardless of time, and re-importing the same bytes
  is idempotent (same hash → updates one ride, no duplicate). The datetime keeps doing display/
  bucketing as a record field. Beeline is untouched (its datetime genuinely is its identity).
  Migration was deliberately skipped — old `gpx::<datetime>` rides keep working via the dual-scheme
  `ingest`; only re-importing a pre-existing file (vs the new scheme) could make one duplicate.

## wind-vs-speed: crosswind colouring + crosswind filter
- **What:** added two crosswind controls to the wind-vs-speed view, grouped together under a
  shared `.ctl-group` "Crosswind" cluster (the same hairline-rule + caption treatment as the
  Segments group, so the chart controls read as cohesive clusters rather than a loose row). A
  **"Colour"** toggle tints each scatter dot by its crosswind (side-wind) magnitude on a
  blue→violet→red cool→hot ramp (`crossColor`, blue = near-calm, red = strong; distinct from the
  map's head/tail green/red), with a gradient **legend** scaled to the strongest crosswind in
  view. A **crosswind band filter** (min–max km/h number inputs, reusing the `.custom` range
  pattern) keeps only segments whose `|cross|` is within the band — set a max to drop side-windy
  stretches, or a min to study them; the analysed-rides note reports how many fell outside. To
  support both, a render-time cross-track wind component was threaded through the pipeline:
  `crossTrackComponentKmh` + `PointWind.crossKmh` → `windSamples().cross` → `WindSeg.avgCrossKmh`;
  `drawWindSpeedChart` took an optional per-dot `dotColor`. Both controls are cheap post-filters
  (no re-sweep) and are persisted in `AnalyticsPrefs`.
- **Why:** the X axis stays the *true* along-track wind (the clean, external regressor), but the
  crosswind — previously invisible — is what often muddies the signal. Colouring surfaces it at a
  glance and the band filter lets you isolate or exclude it. (An earlier exploration of Apparent /
  Effective wind X-axis modes was dropped: apparent wind is almost always negative — you outrun the
  wind — so it added little, and effective duplicated it; encoding crosswind directly is simpler
  and more useful.)

---

## control-geometry design tokens (button/chip size cohesion)
- **What:** added a `--ctrl-*` token scale (`--ctrl-font[/-sm]`, `--ctrl-pad-y/x[/-sm]`,
  `--ctrl-radius[/-sm]`, `--ctrl-border`, `--ctrl-gap`, `--tap-min`) as the single source
  of truth for the button / chip / segmented / field family's height·padding·radius·font,
  and routed the canonical recipes through it (`button`, `button.small`, `.fchip`, `.seg`,
  `.custom`, the tag chips, the header icon-squares). Documented it in the style.css
  design-system header and strengthened the *"One unified design language"* instruction to
  mandate the tokens. Captured the visual-cohesion value in the instructions.
- **Why:** we kept fighting button-size drift because there were colour/shadow/radius tokens
  but NO control-geometry tokens — so every new control eyeballed its own px and ended up a
  hair off its neighbours (the Filters button, the tag rows). One md/sm token scale removes
  the drift by construction: a new control inherits the right size instead of guessing, and
  future changes happen in one place.

## global ride filter across Map / Stats / Wind-Speed
- **What:** the Explore filter is now a single GLOBAL filter that narrows every
  track view too. Moved the filter chips out of the Explore-inline `.filterbar` into
  one header-anchored panel (a desktop dropdown / mobile bottom sheet) summoned by a
  new "Filters" button in the header actions, and wired the shared `visibleRides(filters,…)`
  into Map (`mountMapView`), Stats (`mountStatsView`, so totals/records/heatmap all
  narrow together) and Wind/Speed (`windSpeedVisibleRides`) via a new `applyFilters`
  dep on each view seam, plus the Explore inline summary panel (`renderStats(rides)` —
  its "Distance/Speed per …" chart and KPIs now narrow with the filters, matching the
  group rows below which already did). The Map side note and Stats flag/heat note now say "hidden by
  filters", and `statsFilteredFlag` flags a narrowed set when filters are active even
  with the full date span. Panel opens/closes like the Tags popover (stays open while
  toggling chips; closes on outside-click / Esc / view-switch); the button badges the
  active-filter count and reveals "Clear filters". The header button is styled to match
  its neighbours — funnel icon + "Filters" label like Re-sync, with the count as a
  top-right corner badge so it never inflates the button height, and it folds into the
  same equal 32×32 icon-square cluster as Pull / Sources / the ⋯ menu on phones. On a
  phone the panel is a proper bottom sheet (scrim, grabber, sticky header with a close ×,
  roomy chips, safe-area padding) rather than a cramped dropdown. The panel is moved to
  `<body>` at runtime (`initFilterPanel`) and JS-anchored under the button on desktop /
  CSS-pinned to the viewport bottom on mobile, because `<header>`'s `backdrop-filter`
  otherwise makes it the containing block for `position: fixed` and pins the sheet to the
  top of the page (the bug that made the narrow-view filters unusable). The Tags filter
  is an IN-FLOW section of the panel (not a floating popover): clicking the Tags chip
  expands it into a connected **accordion card** — the chip becomes the card's header (a
  full-width, accent-tinted bar with an up-caret) and the tag cloud is its body, so the
  expanded tags read as belonging to the Tags button rather than a detached box; each tag
  reuses the canonical `.fchip` pill vocabulary (accent when selected) for one consistent
  set of chips. A
  leading **"Untagged"** pseudo-tag (shown when some ride has no tags) filters to the
  un-tagged rides, OR-combined with the real tags — backed by a new `Filters.untagged`
  flag (persisted, gated/pruned like the tags themselves). The panel header is sticky and
  the panel scrolls (desktop + mobile) so long content stays usable.
- **Why:** filtering only existed on the Explore list, yet the Map/Stats/Wind-Speed
  views are exactly where narrowing to a subset (a tag, a source, a distance band) is
  most useful. A per-view summon button would have crowded the Map's already-busy
  corner (area-select / expand / locate + the date slider + the OSM credit); since the
  filter is conceptually app-level, one global header entry point with a floating panel
  keeps the Map uncluttered (the panel never shrinks the map) and says each control
  once — one filter surface, driven by the one persisted `filters`.

## rename npm package to gpx-toolkit
- **What:** renamed the npm package `name` from `beeline-uploader-web` to `gpx-toolkit`
  in package.json (and the matching entries in package-lock.json).
- **Why:** the product was long ago reframed as "GPX Toolkit" everywhere user-facing
  (title, manifest, README, UI) but the build-time package id was left at its historical
  `beeline-uploader-web` value; since the package is private/unpublished it had no
  functional impact, so it had simply slipped through. This is the package `name` only —
  not one of the `beeline-*` module names or storage keys we deliberately keep stable as
  persistence ids — so nothing in `src/` or persistence depends on it.

## suggest tagging after a GPX import
- **What:** after a successful GPX import the app now offers (via the shared consent
  dialog) to tag the just-imported rides, opening the existing multi-ride tag modal
  pre-targeted at them. The controller emits the new rides' uids on an `onImported`
  signal (mirroring `onGpx`); a new persisted `suggestTagsAfterImport` setting (default
  on) gates the prompt, exposed as an "Ask to assign tags after GPX upload" checkbox in
  Settings — and the dialog's "Don't ask again" flips that same setting, so the two stay
  one source of truth.
- **Why:** tags are the main way to find and filter rides, but freshly imported rides
  arrive untagged and the tagging UI is easy to overlook; a gentle, opt-out prompt at the
  moment of import nudges the habit without nagging (it's one quiet dialog, dismissable
  and switchable off).

## tunable wind-vs-speed segmentation (look-ahead bearing + knobs)
- **What:** the Wind/Speed chopper now derives each hop's heading over a configurable
  **look-ahead distance** (default 15 m) instead of the immediately-next point, and
  exposes three end-user sliders in the chart controls — Look-ahead, Turn tolerance,
  Min segment length — grouped under a "Segments" sub-group with a Reset, persisted in
  the analytics prefs and applied live (geometry knobs re-sweep on release; the cache
  key folds in the tuning). Responsive: the controls stack full-width under 640 px.
- **Why:** a slow, dense track (e.g. a Wikiloc hike at ~3 km/h) has points a metre or
  two apart, so the next-point bearing is dominated by GPS jitter and the ride was
  shredded into sub-threshold fragments that all got dropped — a 15.5 km hike yielded a
  single segment. Looking ahead averages the jitter out so real headings hold, and the
  knobs let any track type (hike → MTB) be dialled in; `lookAheadM:0` preserves the
  exact legacy behaviour (regression-tested).

## capture a per-ride library ingest date
- **What:** added an `ingested_at` (ISO-8601) field to each `RideRecord`, stamped
  once on the very first `upsert` and never overwritten by later syncs/checks
  (mirroring `uploaded_at`/`deleted_at`). Legacy records load with it empty.
- **Why:** we now record *when* a ride first entered the local library, distinct
  from its start time (`key`) and `last_seen`. It rides along in the persisted/
  backup blob with no UI surface for now — a foundation for future "recently
  added" sorting/filtering without re-deriving it later.

## gpx-relay deploy: normalize origins to scheme://host, default concurrency 1
- **What:** `deploy.sh` now reduces every `ALLOWED_ORIGINS` entry to a bare origin
  (`scheme://host[:port]`), stripping any path/query/fragment as well as the existing
  spaces + trailing slash. Reserved-concurrency default dropped 2 → 1 (one container
  at a time also makes the in-memory `RL_GLOBAL_PER_MONTH` cap an exact ceiling).
- **Why:** A redeploy that pasted the page URL `https://gubenkoved.github.io/gpx-toolkit`
  (a path, not an origin) into `ALLOWED_ORIGINS` made the relay's allow-list never
  match the browser's path-less `Origin`, so it 403'd every preflight — a live CORS
  outage. The browser only ever sends `scheme://host[:port]`, so normalizing to that
  removes the whole class of "pasted the wrong URL" CORS misconfigurations.

## gpx-relay: GET runtime stats + a global monthly download cap
- **What:** The relay Lambda now answers a plain **GET** to its Function URL with
  basic in-memory liveness JSON (`startedAt`, `uptimeSeconds`, `instanceId`,
  lifetime `downloads`, and the global monthly counter/limit) — no auth, and it
  answers even when `ENABLED=0` since it's a diagnostic. Added a single **global**
  successful-download ceiling per calendar month (UTC), `RL_GLOBAL_PER_MONTH`
  (default 10000), with no per-account/IP bucketing, gated before any upstream
  egress and counted only on success. CORS now advertises `GET`. Relay package
  bumped 1.0.0 → 1.1.0.
- **Why:** The operator wanted to pin down restart behaviour / how long a warm
  container lives — a changed `instanceId` or reset counters reveal a cold start —
  and a coarse, account-agnostic monthly stop-loss as a cheap cost ceiling on top of
  the existing per-account/IP limits. Both are intentionally in-container memory
  (they don't survive a cold start), which is exactly the signal being observed.

## Render Wind rose and Timeline in the wide layout
- **What:** Wind rose and Timeline now break out of main's 940px column to the same
  ~1200px width as Map, Stats and Wind/Speed at viewports ≥1000px. The breakout is
  now driven by a single `.view-wide` marker class on the opted-in view sections
  instead of an enumerated list of view ids, and the redundant `body.map-expanded`
  width-reset was dropped (Stats already proves a fixed fullscreen overlay needs no
  per-view exception, since plain width/margin don't form a containing block).
- **Why:** Both are full-bleed map experiences that were cramped in the narrow column.
  Generalising the rule to a class (every view is simply narrow-by-default or `.view-wide`)
  unifies the narrow/wide split and makes adding or removing a wide view a one-class
  change rather than an edge-case tweak to a hard-coded id list.

## Gate the Wind/Speed sweep behind a confirm + remember its filters
- **What:** The Wind/Speed tab no longer auto-analyses on open. It shows a centred
  card stating how many rides the selected date window will analyse (live-updating as
  the slider moves) with an "Analyse N rides" button; the heavy per-ride segment sweep
  is now scoped to the in-window rides and only starts once the user presses Analyse
  (once per session — reload re-shows the gate, then it runs live). The date window
  plus Flat-only / Max-speed are persisted to localStorage and restored on reload.
- **Why:** Opening the tab used to silently sweep the *entire* wind-resolved history,
  doing a lot of work the user may not want or only need for a subset. Making the user
  confirm — and clearly showing the ride count for the chosen window — puts them in
  control and keeps a narrow window cheap; remembering the selection avoids re-picking
  it every reload.

## Unify every single-thumb slider onto one styled component
- **What:** introduced a canonical `.uslider` class (style.css) + a shared `setSliderFill()`
  helper (new `src/slider.ts`) and routed every single-thumb `<input type="range">` through
  them — Stats thickness, Wind/Speed max-speed + trims, Timeline heat-spread/dwell + day
  scrubber, Settings moving-threshold, and the Windalytics hour. They now match the dual-thumb
  `.rf-*` date-range slider: a 4px dark track with an orange fill up to a round accent thumb.
  Folded the bespoke `.cl-ctl` styling onto the shared class (renamed its `--cl-fill` →
  generic `--fill`) and dropped the native `accent-color`-only chrome from the rest. One
  document-level `input` listener keeps every slider's fill live on drag.
- **Why:** the sliders were inconsistent — most rendered as the unstyled native gray control
  while only the date-range and climate-hour sliders looked finished. One canonical
  implementation per concern (per the repo's reuse/one-design-language values) means they all
  read as one product and a future restyle touches a single place.

## Refactor: extract the Stats view into `src/stats-view.ts`
- **What:** lifted the Stats view (`#statsView`) out of `main.ts` into its own module behind
  a `StatsViewDeps` seam (~290 lines): lifetime totals + records (`computeStats`, `statCard`,
  `periodCard`) and the whole route-frequency heatmap subsystem — the viewport-densified,
  pan/zoom-cached `leaflet.heat` layer, its area-select + locate + full-screen toggle, the
  hover overlay and the "Selected" list. The shared date-range control, ride list, the
  filtered-window flag (`statsFilteredFlag`, range-system coupled, stays in main) and the
  canonical `renderMatchedCards` (shared with the Map view) are injected as lazy closures; the
  heatmap basemap + expand come from `./map-core`. `statCard`/`periodCard`/`computeStats` were
  Stats-only so they moved in wholesale; six now-orphaned imports were dropped from `main.ts`.
  Build + 423 tests green; browser-verified (totals/records/heatmap render, expand + area-select
  toggles work). `main.ts` 4203 → ~3920.
- **Why:** the last big map-coupled view out of the monolith, completing the Map+Stats pair that
  share the `map-core` Leaflet/area-select/expand subsystem. Leaves `main.ts` owning Explore, the
  shared range control, the dialogs and bootstrap — a much smaller surface to finish carving.


- **What:** lifted the all-rides Map view (`#mapView`) out of `main.ts` into its own
  module behind a `MapViewDeps` seam: the translucent-track basemap + lazy creation, the
  side panel, click/area selection + hover emphasis, the locate marker and the expand
  toggle (~210 lines). The shared date-range control, the live ride list and the canonical
  "Selected" card renderer (`renderMatchedCards`, still shared with the Stats heatmap) are
  injected as lazy closures; the cross-view hop (open a ride in Explore) stays in `main.ts`.
  The two genuinely-shared map constants — `CLICK_PX` (click-hit radius) and `HOT_TRACK`
  (highlight style), used by both the Map area-select and the heatmap hover — moved into
  `map-core` rather than being duplicated. `mountAllRidesMap` → `mountMapView`. Build +
  423 tests green.
- **Why:** the next per-view module out of the monolith, now unblocked by the `map-core`
  groundwork. The Map view is the most direct consumer of `createInteractiveMap`, so it
  proves the shared core carries a real interactive view (selection, area-drag, locate,
  expand) and not just chrome.


- **What:** lifted the connective tissue the big interactive maps share out of
  `main.ts` into `src/map-core.ts`: the canonical `OSM_ATTRIBUTION` credit, a
  `createInteractiveMap()` factory (the dark-OSM basemap + compact credit + world
  default, defined once) and a `makeExpandToggle()` builder for the pseudo-fullscreen
  pattern. The Map view (`allRidesMap`) and the Stats heatmap (`freqHeatMap`) now build
  their maps and their expand toggles through it — two ~20-line near-identical creation
  blocks and two near-identical `setMapExpanded`/`setHeatExpanded` functions collapsed
  to one definition each. Build + 423 tests green; bundle marginally smaller.
- **Why:** groundwork for pulling the Map and Stats views into their own modules — they
  share one Leaflet/area-select/expand subsystem, so the common basemap machinery has to
  become an importable module first (one canonical implementation, per *Reuse before you
  write*), rather than each future view module re-deriving the same tile setup.


- **What:** lifted the whole wind-vs-speed scatter (~340 lines: the per-ride segment
  sweep + cache, the distance-weighted regression, KPI cards, empty/blocked states and
  the analysing-progress overlay) out of `main.ts` into a self-contained module behind a
  `WindSpeedDeps` seam — the same injected-lazy-closure pattern as `climate-view`/
  `timeline-view`. `main.ts` keeps the shared range control, ride list and controller and
  passes them in; it no longer imports `windchart`/`windspeed` directly. Renamed the two
  public entry points (`mountAnalyticsView`→`mountWindSpeedView`, `analyticsVisibleRides`→
  `windSpeedVisibleRides`) and rewired all 7 call sites. `main.ts` 4765 → ~4420.
- **Why:** continue carving the monolith into per-view modules. Wind/Speed is the first
  full *data* view to come out cleanly because it's self-contained (its own DOM subtree,
  no shared render glue) — proving the deps seam carries a real view, not just chrome.


- **What:** created `src/app-state.ts` — the home for state that several views share,
  built on the reactive core. First state moved in: the active top-level view
  (`activeView` signal + `setActiveView` persistence + the `ViewName` type), out of
  `main.ts`'s closures. `main.ts` now imports them; its ~18 `activeView` value-reads
  became `activeView()` (tsc-verified — a missed read is a type error). View switching
  + localStorage persistence verified in-browser (Map/Timeline/Explore switch, active
  tab follows, the view restores on reload). `main.ts` 4819 → 4798.
- **Why:** the monolith's views are all woven into shared module-level `let`s + one
  global render — the glue that blocks decomposition. A shared signal module is the
  seam: a future per-view module imports the shared state it needs (e.g. `activeView`
  to know if it's on screen) instead of reaching into `main.ts`. Deliberately started
  with one bounded, genuinely-shared slice; more state migrates here as views split.

---

## Refactor: extract confirm/prompt/consent dialogs to `src/confirm.ts` (view split #1)
- **What:** moved the styled `confirmDialog` / `promptDialog` / `consentDialog` (+ their
  state and the OK/Cancel/backdrop/Enter listeners) out of `main.ts` into a
  self-contained `src/confirm.ts` that wires its own DOM via `initConfirm()`. `main.ts`
  imports the four functions; its global keydown still calls the imported `closeConfirm`
  for Escape. `main.ts` dropped 4928 → 4819 lines. Verified in-browser (OK and Cancel
  both close the modal); build + 423 tests + biome green.
- **Why:** first slice of decomposing the 4.9k-line `main.ts` monolith into focused
  modules (the agreed item 1). The dialogs are a cohesive, promise-based unit with no
  shared-state coupling — the safest first extraction, and it establishes the pattern
  (own state + own listeners + a small init) for the bigger view splits to follow.
  (Signals don't fit an imperative promise-dialog, so this one stays plain — the
  signal-driven views, e.g. Wind/Speed, come next.)

---

## Feature: tiny reactive core (`src/reactive.ts`) + first adoption
- **What:** added `src/reactive.ts` — fine-grained `signal` / `effect` / `computed` in
  ~50 dependency-free lines (reading a signal inside an effect subscribes it; the
  effect re-runs only when a signal it actually read changes; effects clean up stale
  deps; `computed` caches). 10 unit tests in `tests/reactive.test.ts`. First adopter:
  the Wind/Speed view's granularity + metric toggles — `statGran`/`statMetric` became
  signals, and one `effect` each keeps the segmented-control `.active` highlight in
  sync, **deleting the active-class loop that was duplicated four times** (twice in
  the render path, twice in the click handler). Verified: the effect sets the initial
  highlight correctly in-browser; build + 423 tests + biome green.
- **Why:** the app re-renders via hand-rolled `lastSig`/`lastTrackSig` dirty-checking
  across ~40 module-level `let`s — verbose, and the glue that makes `main.ts` (4.9k
  lines) hard to split. A signal/effect core replaces that plumbing and is the
  mechanism for decomposing `main.ts` into self-contained views (each owning its
  state as signals). Deliberately tiny — no framework, no scheduler, no new dep; see
  `temp/design-language-next-steps.md` and the "do we need a framework?" analysis
  (answer: no — the view layer is ~60 `innerHTML` sites, not the 20k LOC).

---

## Feature: render-layer design vocabulary (`src/ui.ts`) + `statNum`
- **What:** introduced `src/ui.ts` — a pure, dependency-free leaf module of
  `(opts) => string` builders that own the canonical markup+classes for shared
  components, with HTML escaping centralised + safe-by-default. First helper:
  `statNum({value,label,sub?,title?,small?})`, unifying the Stats lifetime/record
  numerals (`statCard` now delegates to it) and the wind-rose summary numerals
  (`small` variant) — previously two hand-rolled copies (`.stat-card` vs `.cl-card`,
  the documented "copy-to-match"). CSS unified into `.stat-num` (+ `.stat-num--sm`).
  `escHtml` moved from `main.ts` into `ui.ts` (one source). Added `tests/ui.test.ts`
  (6 tests: exact markup, sub/title, small variant, and XSS-escaping of every field).
  Build + 413 tests + biome green; wind-rose numerals verified pixel-identical.
- **Why:** a CSS class you must *remember* loses to copy-paste — the wind-rose proved
  it. Making the canonical UI a function call flips the incentive (reuse is easier
  than copying), gives the design layer real unit tests (it had none), and means a
  markup/class change happens in one place. This is the first step of unifying at the
  render layer, not just in CSS; see `temp/design-language-next-steps.md`.

---

## Docs: sync the in-file design-language header
- **What:** updated the design-language reference block at the top of `style.css` to
  list the new tokens (elevation scale, `--track`, `--glass-strong`, `--accent-ink`)
  and the new shared classes (`.panel`, `.map-banner`).
- **Why:** the header is the canonical "reuse before you write" map; keeping it current
  is what makes the next feature grab the shared class instead of copying (the exact
  gap the wind-rose review exposed).

---

## Refactor: shared `.panel` surface (5 side/stats panels)
- **What:** the Stats panel, the Map / heatmap / Timeline / Wind-rose side lists all
  repeated the same surface core (`background: var(--panel); border: 1px solid
  var(--line); border-radius: var(--radius)`). Extracted a canonical `.panel` class;
  the five elements now carry it and each rule keeps only its own padding/overflow.
  Also removed the dead `.notice*` rules (the class isn't rendered anywhere).
- **Why:** one source of truth for "a static panel surface" — distinct from `.modal-card`
  (which adds elevation). The wind-rose `.cl-side` was another copy of the same thing;
  it now shares the base. A new panel is `class="panel"` instead of three more lines.

---

## Refactor: shared `.map-banner` (timeline + wind-rose)
- **What:** `.cl-banner` (Wind-rose) was a **byte-for-byte copy** of `.tl-banner`
  (Timeline) — the centred glass status pill at the top of each map. Merged both into
  one `.map-banner` class; both `#tlBanner`/`#clBanner` now carry it and the duplicate
  rule is gone.
- **Why:** first retrofit from the wind-rose review — the feature copy-pasted the banner
  because no shared class existed. Now there is one, so the two can never drift apart.

---

## Refactor: elevation + track tokens (design-language tier 1)
- **What:** promoted the remaining repeated literals to `:root` tokens and swapped every
  call site — a drop-shadow scale (`--shadow-thumb`/`-float`/`-bar`/`-pop`/`-menu`,
  joining the existing `--shadow-modal`), the slider/bar rail `--track` (`#2a313c` ×4),
  `--glass-strong` (the more-opaque glass ×3), `--accent-ink` (ink on accent buttons ×3),
  and fixed `.toast` to use `var(--panel2)` instead of re-typing `#1b1f27`. Pure
  substitution — every token holds the exact prior value, zero visual change; build +
  407 tests green.
- **Why:** shadows were half-tokenised (only `--shadow-modal` existed while identical
  recipes sat raw in `.iconbtn`, the banners, slider thumbs); the wind-rose feature then
  added *more* raw copies. Centralising the elevation scale + the slider rail is the
  prerequisite for the shared `.slider`/banner/panel components that follow.

---

## Drop the redundant per-tile “details” link
- **What:** removed the blue `details`/`hide` link from each ride tile in the Explore
  list (plus its now-dead click handler and unused `.rmeta a` CSS).
- **Why:** clicking anywhere on the tile already toggles the expanded details, and
  `.rrow` already shows `cursor: pointer` — the link was a second route to the same
  action. No redundancy: say each thing once.

## Windalytics polish + a hidden-view fix
- **What:** refined the new Wind-rose view — a dual-thumb **year-window** slider (gets
  its own full-width row in tight layouts, sharing the app's `.rf-*` thumb/track with
  the now-cohesive hour slider), **month selection by clicking the monthly mini-roses**
  (click the focused one again for all months, replacing the chip row), a **hover
  readout** on the big rose (highlights the sector + shows its speed mix), a **"locate
  me"** button, a subtler dashed analysed-cell outline, Stats-style underline numerals,
  and a **"steadiness"** stat (directional constancy) replacing the always-zero "calm %".
  Fixed a bug where the Wind-rose view never hid when switching tabs — its `#climateView`
  was missing from the `.hidden` backing rule (there's no universal `.hidden` rule), so
  its map + panel leaked onto every other tab.
- **Why:** the first cut shipped the data; these make it legible and consistent with the
  app's design language, and the hidden-view bug was a real regression on every tab.

## Feature: Windalytics — point wind climatology ("Wind rose" tab)
- **What:** new top-level view. Click a point on a dark map and it pulls a window of
  **ERA5** hourly wind for that grid cell — one archive request per calendar year,
  cached in the shared wind cache via the new `Controller.getPointWind(lat, lon,
  startYear, endYear)` — then mines it into a **wind rose** (16 sectors × speed bins),
  **twelve monthly mini-roses** (each captioned with its sample count), a **month ×
  direction heatmap**, and a **mean-wind arrow** drawn on the cell. A **dual-thumb year
  window** slider (shared `.rf-*` look: drag a thumb to resize, drag the middle to
  slide the span across 1950→now, capped at 20 years) sets the range; a single-hour-of-
  day slider (with an "All day" position) and month-filter chips drive the charts. Hour
  and month are pure in-memory re-aggregations (`windrose.ts`), so the rose morphs
  instantly with no refetch; only moving the year window refetches (new years only).
  Provenance is spelled out — cell coords, the actual year span covered, total
  hours/days pulled (+ any no-data days), and the filtered sample count — for full
  data visibility. The pure compute core lives in `windrose.ts` (tested in both the new
  `windrose.test.ts` and a `getPointWind` controller test); the view is an isolated
  module (`climate-view.ts`) wired through a `ClimateDeps` seam, mirroring the Timeline
  view (dark basemap, floating expand button, `body.climate-expanded` fullscreen + Esc).
  The existing wind-vs-speed "Wind" tab was relabelled **"Wind/Speed"** so the new
  climatology tab can own the **"Wind rose"** name.
- **Why:** rides only ever sampled wind along a track at one instant; there was no way
  to ask "where does the wind actually come from here, and how does that shift across
  the day and the seasons?" ERA5 already reaches back to 1950 globally and the cache is
  keyed per (cell, day), so the heavy data-mining was almost free to add — lock to one
  consistent dataset, fetch once, and let the user slide the year window / time-of-day /
  month over cached data to find patterns. Reuses the established map/slider/chip
  vocabulary rather than inventing a new surface.

## Chore: apply biome formatting + organize imports repo-wide
- **What:** ran `biome format` and import-organization across the codebase so
  `biome check` (and therefore `npm run verify`) is fully green. Pure mechanical
  whitespace/line-wrapping + import ordering + one string-concat → template literal;
  no logic touched. Build + 390 tests still green.
- **Why:** the repo had drifted out of formatter conformance; a clean `biome check`
  means future diffs are formatting-noise-free and the verify gate actually passes.

## Chore: clear all biome lint findings
- **What:** fixed every outstanding `biome lint` finding across the codebase —
  optional-chaining (`!x || !x.y` → `!x?.y`), `import type` for type-only imports,
  `let` → `const` for a never-reassigned binding, dropped a useless `continue` and
  unused `catch` bindings, made an `if (promise)` an explicit `!== null` check, and
  gave a `forEach` callback a non-returning block body. The three `role="group"`
  segmented-control toolbars carry a documented `biome-ignore` (no native element
  fits a labelled button group). Pure cleanup — no behaviour change; build + 390
  tests green.
- **Why:** a clean `biome lint` keeps the signal high so real issues stand out.

## Docs: design-language reference at the top of `style.css` (phase 7)
- **What:** added a concise design-language header to `src/style.css` listing the
  semantic tokens and the shared component vocabulary (`button` family, `.iconbtn`,
  `.scrim` / `.modal-card` / `.modal-x`, `.field`) with the rule "reuse before you
  write; extract only what truly repeats." So the next surface starts from the
  vocabulary instead of pasting literals.
- **Why:** the refactor built a real vocabulary; a short in-file map makes it
  discoverable and keeps the single-source-of-truth discipline from eroding.
- **`@layer` deliberately skipped.** The original plan's cascade-layering step does
  not earn its keep here: the sheet interleaves element and class rules, and a
  *partial* `@layer` adoption makes layered rules lose to every un-layered rule
  (e.g. `button:hover` 0,2,1 would stop beating a `.chip:hover` 0,2,0), which can
  silently flip styling. A *full* migration would be a large reorg with no
  pixel-level test to catch regressions. The maintainability goals — one source of
  truth (tokens), no global collisions (`.onb-empty`), reusable components — were
  reached without it, so adding cascade complexity now is risk without reward.

## Refactor: shared `.field` text-input look (phase 6)
- **What:** the Beeline sign-in inputs (`.srcopt-form input`) and the confirm / tag
  inputs (`.confirm-input`) repeated the same dark-inset look (bg, line border, 8px
  radius, inherited font, accent focus ring). Extracted a canonical `.field` class +
  `:focus`; each input rule now keeps only its own layout/padding, and the four input
  elements carry `field`. Verified in-browser (computed style unchanged).
- **Why:** one place to tune the text-field look. *Deliberately did NOT* force a
  shared `.chip` class as the plan floated — the chips (`.fchip` r9/panel2,
  `.cstate` r20/transparent, `.selchip` r20/accent) genuinely diverge in radius,
  padding and fill, so a shared base would be a thin 3-declaration stub plus heavy
  per-chip overrides: more indirection, not less. Extract only what truly repeats.

## Refactor: shared modal vocabulary `.scrim` / `.modal-card` / `.modal-x` (phase 5)
- **What:** the source picker, confirm dialog, tag modal and settings each
  re-declared the same full-screen overlay, dark elevated card and corner close
  button (a comment even said they "reuse the source-picker's vocabulary" — by
  copy-paste). Extracted three canonical classes — `.scrim` (fixed blur backdrop),
  `.modal-card` (panel card + shadow) and `.modal-x` (close button) — plus two
  tokens `--scrim` and `--shadow-modal`. Each modal now keeps only what differs
  (its `z-index` and card `width`); the duplicated `.*-close` rules are gone. All
  modal markup in `index.html` carries the shared classes. Verified in-browser:
  the picker, card and close button render pixel-identical.
- **Why:** one real source of truth for "a modal", so a new dialog is `class="scrim"`
  + `class="modal-card"` instead of another copied overlay, and the modal look is
  tuned in one place. Net CSS dropped again (~85.1k → 84.2k).

## Refactor: shared `.iconbtn` floating-button class (phase 4)
- **What:** the four floating square overlay buttons — `.map-expand`, `.map-select`,
  `.map-locate`, `.map-help` (used across the Map, heatmap and Timeline) — carried
  four near-identical 17-declaration blocks. Extracted the shared look (34px glass
  square, blur, shadow, hover) into one canonical `.iconbtn` class; each specific
  class now keeps only what differs (its `top` slot and its `.active` colour), and
  the markup gains `iconbtn` at all ten call sites (9 in `index.html`, 1 in the
  per-ride mini-map button in `main.ts`). Verified pixel-identical in the browser.
- **Why:** one source of truth for the overlay-button vocabulary — a new floating
  control now just adds `class="iconbtn"` instead of copying 17 lines, and a tweak
  to the shared look happens once. Net CSS shrank (~86.2k → 85.1k).

## Refactor: kill the global `.empty` collision (phase 3)
- **What:** renamed the first-run onboarding empty-state class from the bare,
  global `.empty` to a namespaced `.onb-empty` (CSS + the one `index.html` call
  site; the element keeps `id="empty"`, so all JS `$("#empty")` wiring is
  untouched). The two unrelated elements that use `empty` as a *local* state
  modifier — the speed-histogram "no data" stub bar and the leading blank calendar
  cells — now resolve only to their own scoped rules, and `.col .bar.empty` gained
  an explicit `padding: 0` so it renders as the intended 2px stub. Removed the now
  redundant `padding: 0` defence (and its stale comment) from `.tl-cal-cell.empty`.
- **Why:** the bare `.empty` (0,1,0) onboarding rule bled `padding: 56px` into any
  element carrying an `empty` modifier — the exact bug that inflated the calendar
  cells. Namespacing the component removes the whole class of collision instead of
  patching each victim. *Incidental visual correction:* the histogram's "no speed
  data" stub bar previously inherited that 56px padding and rendered tall; it now
  shows as the 2px stub its inline `height` always intended.

## Refactor: design-language tokens (phase 1)
- **What:** promoted the most-repeated colour literals in `src/style.css` to semantic
  `:root` tokens and swapped every call site over — `--surface-hover` (#222732 ×13),
  `--border-hover` (#333b48 ×18), `--map-bg` (#05070a ×6), `--glass` (the translucent
  header/popover backdrop ×8), `--danger-border` (#5a2420 ×8), and `--accent-tint` /
  `--accent-tint-strong` (the accent washes). Pure substitution: every token holds the
  exact prior value, so the rendered pixels are unchanged.
- **Why:** first step of turning the 5k-line one-off sheet into a reusable design
  language. These hand-typed hexes were de-facto tokens with no single source of truth;
  centralising them kills the "two copies, two behaviours" drift and makes the hover/
  danger/accent palette tunable in one place.

## Feature: ride tags + multi-tag OR filter
- **What:** rides can now carry free-form, case-insensitive tags. Assign them per ride
  (the … menu → Tags…) or in bulk over the current selection via a small modal that
  lists existing tags as toggle chips and creates new ones from a text field; tags
  render as inline pills on each ride's title row, before the GPX/wind badges. A single
  "Tags" filter chip (shown only once any ride is tagged) opens a multi-select popover
  that filters with OR semantics. New canonical `src/tags.ts` owns normalization +
  the lowercase comparison key; persisted on the ride record (no schema bump — legacy
  records default to `[]`) and mutated via a side-effect-free `Store.setTags` so tagging
  never resurrects a deleted ride. The selected tag keys persist in the filter blob.
- **Why:** lets a rider organize a large library by their own categories and quickly
  narrow to one or several of them — a user-owned dimension alongside the derived ones
  (source/Strava/wind/distance), reusing the existing chip/popover/modal vocabulary so
  it reads as one product.

## Fix: analytics no longer resets mid-sweep; calmer, steadier progress
- **What:** The wind-vs-speed analysis now runs ONE sweep at a time over the WHOLE
  resolved library (range-independent) and never restarts it: a re-entrant call while a
  sweep runs (date-slider drag, settings change, a background job ticking ride state)
  coalesces into a single post-sweep refresh instead of bumping `analyticsSeq` and
  aborting. Progress is time-throttled (~100ms) and names the ride in flight, the
  overlay is a fixed-width card (stable header line + ellipsized detail + bar) so it
  stops resizing, the sweep runs newest-first, and the overlay only reveals after a
  ~200ms delay so 1-ride top-ups during a download never flash it.
- **Why:** Background job ticks and slider drags were driving `render()` → remount →
  `analyticsSeq++`, which aborted the in-flight sweep so the counter reset to 0 and the
  in-range-only total dropped; the count-based throttle jumped ~40 at a time on a large
  library; the auto-sized panel jumped with each ride label; and each downloaded ride
  flashed an "Analysing 1 ride…" overlay. Segments are cached per ride and independent
  of the date range, so the slider is now a pure view filter over cached results.

## Fix: caching full GPX fetched from the ride map
- **What:** `Controller.fetchFullTrack` (the interactive path the single-ride map
  uses) now persists the downloaded GPX to the cache and upserts the ride's rough
  track + `track_bytes`, mirroring the queued `download-gpx` path. `RideSource.
  fetchFullTrack` now returns `{ track, bytes }` so the controller can cache the bytes.
- **Why:** fetching the full GPX from the map only loaded it into the in-memory
  session map — nothing was written to the GpxCache or the record, so on reload the
  ride showed as un-cached (`gpx_cached` false) and kept offering to fetch again.

## Fix: Timeline view leaking into other tabs
- **What:** Added `#timelineView.hidden` to the view `display:none` rule so the Timeline
  map + "Where you spend time" panel actually hide when switching to another tab.
- **Why:** The hide rule enumerated every view container except `#timelineView`, so adding
  the `.hidden` class in `applyView()` had no effect — the Timeline panel rendered below
  every other view (Explore/Map/Stats/Wind). Keeping the selector list complete fixes it.

## Timeline: explore your Google Location History on a map
- **What:** A new **Timeline** tab brings a Google **on-device Timeline** export into the
  app, entirely on-device in its own droppable storage. Import parses the export into one
  normalized, time-ordered `LocRecord` stream (path samples, place visits, travel segments,
  recent raw fixes) persisted month-chunked in a dedicated `location-history` IndexedDB store
  (a columnar delta+zig-zag+varint codec, gzipped per month — measured 83.5 MB JSON → 1.52 MB
  on disk, 55x, on a real 11-year/172k-record export; coordinates kept lossless at E7).
  The tab is a map-centric experience:
  - a **dwell heatmap** of where you spend time, normalized to the visible window, with live
    persisted spread/sensitivity tweaks;
  - a draggable **date-range window** over the whole history (drag the middle to slide a
    fixed-size window through time) and a custom in-design-language **day-picker calendar**;
  - **area-select** ("when was I here") that lists the matching days grouped into consecutive
    **stays**, with a per-year histogram drill-down; hovering a day previews its footprint on
    the overview map;
  - **day replay** — a colour-coded event rail (by place / travel mode) synced to a time
    scrubber, with the map marker, a UTC ⇄ approximate-area-local time toggle (with day-
    rollover feedback), and rail-hover map highlighting.
  Fully responsive (controls reflow and the side panel stacks under the map on phones), with
  the app's icon set, dark map tooltips, and design language throughout.
- **Why:** Location History is a large, rich dataset fundamentally different from rides, so it
  gets its own compression-first bucket and a dedicated map-first tab to explore where and
  when you've been — without ever leaving the device.

## Full export/import in ZIP format
- **What:** added `exportAllZip()` / `importAllZip()` on Controller to package all ride state, settings, and cached GPX blobs (cache + data vault) + wind cache into a single ZIP file. Import transparently handles both JSON (rides only) and ZIP (full state + caches) files. ZIP carries manifest.json with metadata and entry counts.
- **Why:** a power user's full dataset (thousands of rides, 500MB+ cache, shared wind history) cannot be backed up as JSON alone — binary blobs must be preserved for offline/restore scenarios. ZIP is universal and enables complete backup/restore workflows. Import merges rather than replaces, skipping blobs with identical bytes, so re-importing is idempotent. Added `reload()` methods to GpxCache and WindCache to rebuild in-memory indexes after bulk blob writes.

## Error-card “Details” stays open while jobs run
- **What:** the expanded state of an error card's “Details” panel is now tracked
  in a module-scope `expandedErrIds` set (mirroring `dismissedErrIds`/`shownErrIds`)
  and re-applied in `renderError()`, instead of living only as a DOM `.errfull.show`
  class toggled on click.
- **Why:** while a batch runs, the job ticker re-renders frequently and
  `renderError()` rebuilds the whole error stack from scratch (`stack.textContent
  = ""`), which dropped the open panel — so an expanded error collapsed on its own
  mid-task. Persisting the toggle outside the DOM keeps it open across re-renders.

## Mini-maps no longer flicker when the status/queue panel updates
- **What:** `mountMaps()` now RE-ADOPTS each already-mounted Leaflet mini-map
  across a list rebuild — moving the live container into the freshly-rendered
  `.rmap` slot (`replaceWith` + `invalidateSize`) — and only tears down maps whose
  ride is no longer shown, instead of removing every detached map and recreating it.
- **Why:** A bulk job (upload / re-sync) ticks `active_keys`/`current_keys` as each
  ride starts and finishes, so `render()` wipes and rebuilds `#months` on every
  tick. The old teardown-then-recreate path destroyed and remounted every open
  ride's Leaflet instance each time, reloading its tiles — a visible flicker. Re-
  adopting the live map keeps tiles/zoom intact, so progress updates are silent.

## Year/month batch select only selects rides passing the active filters
- **What:** `keysOfMonth`/`keysOfYear` now gather keys from `visibleRides(filters,
  STATE.rides)` instead of the full unfiltered `STATE.rides`.
- **Why:** clicking a year/month header checkbox selected every ride in that bucket,
  including ones hidden by the active filters — yet the same checkbox's
  checked/indeterminate state was already derived from the *visible* rides, so the
  action and its displayed state disagreed. Sourcing from the filtered set makes
  batch select act on exactly the rides the user can see.

## Keep a ride's destination after a GPX download / upload
- **What:** `Controller.persistDetail` now writes a freshly read ride detail's base
  name to `title_base` instead of the display `title`.
- **Why:** the detail's `title` is the base name only (no place suffix), but it was
  written straight to `title`, where `Store.upsert` overwrote the stored
  "base, place" title — silently dropping the reverse-geocoded destination suffix
  after any download-gpx/upload, until a full re-sync rebuilt it. Writing it to
  `title_base` leaves the richer `title` (and its derived location) intact.

## Auto-renew the Beeline session instead of failing on token expiry
- **What:** The Beeline `idToken` (~1h TTL) is now renewed silently from the Firebase
  refresh token, which `signIn` now captures into `BeelineSession` (memory-only — never
  persisted). `BeelineRideSource` routes every backend call through a new
  `withFreshSession()` wrapper that renews *proactively* when the token is within 2 min of
  expiry and *reactively* (retry-once) when a call comes back 401/403 — `request()` now
  tags those as `BeelineError` kind `expired` with the HTTP status. A failed refresh (revoked
  token) drops the connection so the next action re-prompts for the password via the existing
  `withBeelineAccess` gate; `main` shows a "Renewing…" toast and a clear expired-session card.
- **Why:** Previously a token expiring mid-session made every Beeline action (pull, upload,
  rename, delete, GPX export) fail until the user manually signed in again — a long batch
  upload could silently die partway. Renewing transparently keeps in-session work alive
  without re-prompting, while preserving the no-stored-password posture (refresh token is
  in-memory only, so a reload still re-prompts).

## Fix the full-screen route bar clipping Close on narrow viewports
- **What:** Made the `.ridemap-tools` control cluster the bar's overflow valve — it may
  shrink (`flex: 0 1 auto; min-width: 0`) and scroll horizontally as a last resort, with
  its controls pinned to natural width (`.ridemap-tools > .rmb, > .seg { flex: 0 0 auto }`)
  and the Close button pinned (`flex: 0 0 auto`). Re-based `syncRideMapBarCompact` to test
  the cluster's own `scrollWidth > clientWidth` (not the whole bar), and added a
  `max-width: 560px` block that trims the bar's gap/padding, caps the title, and hides the
  "~ time is estimated" footnote.
- **Why:** On a phone-narrow viewport the single non-wrapping bar overran its width and the
  Close button (last in the row) was clipped off-screen. The first attempt let the cluster
  shrink but the seg buttons (which `overflow: hidden`) shrank too and clipped their labels
  ("Elev", "Dist") instead of overflowing, so the icon-fold never fired. Pinning the
  controls to natural width makes the cluster honestly overflow → fold to icon-only first,
  then scroll, while title + Close always stay fully visible.

## Extract the full-screen ride map into its own module
- **What:** Moved the ~1,200-line full-screen single-ride route map (route colouring,
  elevation/speed profile, hover readout + wind dial, fetch-full-track flow) out of `main.ts`
  into a new [src/ridemap.ts](src/ridemap.ts). It reaches the rest of the app only through an
  injected `RideMapDeps` seam (`initRideMap` — the live controller/state, toast, HTML escape,
  the Beeline/relay re-auth gates and the OSM credit), so it never imports the entry module;
  `main.ts` wires it once and calls the exported handlers from its central event dispatch.
  Pure code move + DI seam — no behaviour change. `main.ts` drops 5,572 → 4,330 lines.
- **Why:** `main.ts` had grown into a monolith mixing app shell, rendering, dialogs and this
  self-contained subsystem. The ride map is the single most cohesive, separable chunk, so
  lifting it (behind the repo's established DI-seam style) is the highest-value step toward a
  maintainable entry file without touching behaviour.

## Complete & start maintaining the module map in copilot-instructions
- **What:** Filled in the *Architecture / module map* table so every `src/*.ts` has a row
  (added the wind/weather, stats, heatmap, area-select, location-history and low-level utility
  modules that were missing), grouped the table by concern, and added a directive to update
  the table in the same change that adds/splits/renames/removes a module.
- **Why:** The map listed only ~16 of 28 source files, so it had silently drifted from the
  code. As part of the modularization effort we want one canonical, self-maintained structure
  reference for humans and the assistant — and a rule that keeps it from rotting again.

## Make "still" stretches legible in the ride profile
- **What:** Restyled the stopped-range bands in the ride speed/elevation profile: a faint
  cool fill (`.rp-stop`) topped by a crisp cool rule (`.rp-stop-top`), drawn in the background
  behind the area + line. Replaced the previous dark dim.
- **Why:** Stops sit at ~0 km/h — the chart floor, where there's no orange fill — so the old
  dark-on-dark band was invisible. A cool, top-ruled region reads as a quietly marked "paused"
  stretch (cool vs. the warm orange of riding) and stays legible exactly where the speed line
  flatlines, without overdrawing the foreground profile. Picked via a quick live A/B of five
  treatments (hatch / softfill / gradient / topline / finehatch); the spike was then removed.

## De-jitter GPS speed so a parked bike reads as stopped
- **What:** Replaced the per-hop speed series (`movingAverage(fullTrackSpeedsKmh, 3)`) with a
  new `smoothedSpeedsKmh` that derives each point's speed from the **net displacement** over a
  ~10 s window (`SPEED_WINDOW_SEC`) minus a `GPS_NOISE_FLOOR_M` (12 m) quadrature noise floor.
  Wired it into peak speed, the moving/stopped split (`fullTrackSummary`, `stableStoppedRanges`)
  and the ride profile/hover in `main.ts`. Raw `fullTrackSpeedsKmh` is kept (still unit-tested).
- **Why:** Stationary stretches showed several km/h. Per-hop distance is always positive, so
  ±5–10 m of ~1 Hz GPS jitter computes as speed, and a moving-average of an always-positive
  series can never reach zero — it left ~4 km/h, which still exceeded the 1 km/h stop threshold
  and so counted as "moving". Measuring net displacement (random wander cancels) and shaving the
  GPS noise floor finally pulls a standstill below the threshold. Trade-off: peak speed is now
  the fastest *sustained over ~10 s* (a lone GPS spike no longer inflates it) and genuine motion
  slower than ~walking pace reads as stopped. Total distance is intentionally left untouched.

## Wind vs speed analytics (new Wind tab)
- **What:** A fourth view, **Wind**, plots how much the wind helps or hurts you. Each ride
  is split into roughly-straight moving segments (`src/windspeed.ts`); every segment is a
  point on a Canvas-2D scatter (`src/windchart.ts`) of along-track wind (X: ← headwind /
  tailwind →) vs average moving speed (Y), sized by distance. A distance-weighted fit
  reports **still-air speed** (intercept), **km/h per km/h of tailwind** (slope) and
  **R²**. Controls: a **Flat segments only** toggle and a **Max speed** cap that drops
  GPS-glitch segments above a plausible speed (a physical filter that, unlike trimming the
  fast/slow tails, keeps every real headwind/tailwind point so the slope isn't flattened).
  Uses **only rides with full GPX** (real timestamps — otherwise speed is synthetic);
  context-aware **Resolve wind** / **Fetch full GPX** buttons appear with a count only when
  some in-range ride actually needs (and can take) the action. A big library analyses with
  a live progress bar; the layout stays put while dragging the date slider (gaps show as a
  calm chart overlay, not a page swap). Controller gains `windSamples()` (cache-only,
  aligned along-wind + elevation + `realTimes` flag). New tests cover segmentation, the
  weighted regression, the speed cap and the chart's scale/tick helpers.
- **Why:** "How much does the wind actually slow me down?" was unanswerable from the
  per-ride summary, because a ride's average along-wind cancels out on an out-and-back.
  Single-heading segments keep the headwind and tailwind legs apart so the regression can
  quantify the effect. Honest speed needs a full timed track (hence the GPX gate), and
  capping by plausible speed removes only impossible glitches, not the genuine extremes
  that carry the wind signal. Segments are memoized per ride so the slider and toggles stay
  instant even at thousands of rides.

## Moving-average speed & an inactivity-aware ride map
- **What:** The full-screen ride map now distinguishes riding from idling. The summary strip
  adds a **moving avg** speed (excludes hops below a stop threshold) + a subtle "not moving Xm"
  chip; the elevation/speed profile dims the stopped stretches (`stoppedRanges`, "stopped M:SS"
  tooltip) and gains a **Distance ↔ Time** x-axis toggle (time stretches idle spans to their
  true width, cursor↔map sync generalized via per-point `axisX`). The stop threshold is a new
  persisted setting (`movingThresholdKmh`, default 1 km/h, 0–5) tuned in a new minimal
  **Settings** popup. **Wind** folded into the Route/Height/Speed colour seg as a 4th pillar
  when a full track is loaded (standalone button kept as the no-full-GPX fallback), and the now-
  crowded control bar collapses its buttons to icons (`.compact`) when it would overflow. Also
  renamed the vague "Download cache" storage row to **"Beeline tracks"**.
- **Why:** The plain distance/elapsed average is dragged down by stops (lights, photos, coffee),
  so it misrepresents how the ride felt — splitting out moving time gives a truthful pace, and
  dim bands + the time axis show *where* and *how long* you stopped. Wind is just another route
  colouring, so it belongs in the seg once advanced controls appear; icon-collapse keeps the
  fuller bar uncrowded without dropping any control; and the clearer label makes the
  data-vs-cache split obvious. Gave the app its first real home for preferences.

## App logo & favicon: bike-on-a-route badge
- **What:** Introduced a single brand mark (`public/logo.svg`) — a rounded Strava-orange badge of a
  bike riding a route ribbon — and used it everywhere: the header brand mark (replacing the bare
  CSS accent dot in both the header and the Sources dialog), the favicon (replacing the old route-
  squiggle), and as PNG fallbacks (`favicon-32`, `apple-touch-icon`, `icon-192/512`) wired up via
  a new `site.webmanifest` + `theme-color`. PNGs are rasterized from the SVG by `scripts/gen-icons.mjs`
  (`npm run gen-icons`, `sharp` devDependency) and committed. Patch bump to 0.9.1.
- **Why:** The app had a placeholder favicon and no real logo; the bike+route badge expresses the
  product (rides + GPX tracks) in the established accent palette, and the platform icons/manifest
  make it install/bookmark cleanly on mobile.

## Fix: per-ride "⋮" menu clipped by the month box
- **What:** The month container that owns the currently-open per-ride overflow menu now gets a
  `menu-open` class flipping it to `overflow: visible`, so the downward dropdown is no longer cut
  off at the month box's bottom edge (most visible on the only/last compact card in a month).
- **Why:** `.month { overflow: hidden }` (kept for rounded-corner clipping) was clipping the
  absolutely-positioned `.ovr-items` dropdown. Only one menu is open at a time, so at most one
  month transiently relaxes its clipping — a minimal, state-gated fix with no JS positioning.

## Historical wind overlay on rides (head/tailwind colouring)
- **What:** An explicit **Resolve wind** action (per-ride, row action, or over a selection) adds
  a **Wind** colouring mode to the big ride map: the route is painted green (tailwind) → red
  (headwind) by the along-track wind component, with downwind arrows, the data's grid-cell
  footprint, and a summary line (direction, speed, %tailwind, gust, Open-Meteo credit). New
  `weather.ts` (Open-Meteo client + grid sampling + wind math) and `windcache.ts` (a global
  `(dataset, cell, day)` cache in its own IndexedDB `wind` store, finest archive per place/era:
  CERRA 5 km → ECMWF-IFS 9 km → ERA5 25 km, live forecast for recent rides). Resolution runs
  through the job queue, never automatically; adds a "Clear wind cache" action and a **Wind**
  filter chip. Renamed the DB `beeline-toolkit` → `gpx-toolkit` (no migration).
- **Why:** Let the rider see how their speed correlates with the wind along their axis of
  movement — on the analysis surface, leaving mini-maps untouched. The cache is keyed by
  place+time (not ride) because wind is universal, so resolving one ride pre-populates cells
  others reuse for free — keeping us inside Open-Meteo's free tier. Wind is computed from the
  freshly-fetched data (not a cache read-back), so a cache-write failure degrades to "re-fetched
  next time" not "no wind"; the IndexedDB layer self-heals a missing store by forcing an upgrade.
  Footprints keep the coarse spatial resolution honest.

- **What:** Reframed the app from a single-purpose **Beeline → Strava uploader** into a
  generic, multi-source **ride library** ("GPX Toolkit"). Rides now come from any source and
  coexist in one unified, uid-keyed store (`${source}::${datetime}`): a local **GPX import**
  source (`.gpx`/`.zip`, parsed and stored in the browser, never uploaded) alongside the
  **Beeline Velo account** (whole-history pull + server-side Strava push). The `RideSource`
  seam carries per-source `capabilities`, and a Controller source registry dispatches each
  ride's actions to its own source. There is no per-source "mode": the app boots into the one
  library, a **Sources** dialog connects/manages sources, and every Beeline/Strava-specific
  surface is gated on a real signal (capability/connection), never a flag — chrome, filters,
  wording and per-ride actions all adapt to the source in front of the user (e.g. GPX
  delete/rename stay local; destination is editable for GPX, read-only for Beeline). Imported
  GPX lives in a separate **data vault** (never flushed by a cache clear) vs. the re-fetchable
  Beeline **cache**. The whole UI was unified and decluttered around this: one click-through
  filter-chip vocabulary, a consolidated `⋯` actions menu, per-ride source markers, a
  source-neutral first-run/empty experience, and a versioned, future-proof state schema.
- **Why:** Beeline is now *one optional source*, not the whole product — the same explore /
  map / stats / export experience should work for any ride a user has as GPX, and the app must
  stay fully functional with no account at all. Gating on real capability (not a mode) is what
  lets sources coexist correctly in one list while keeping each source's actions and copy
  truthful; the unified uid-keyed store + data/cache split is what makes that coexistence safe
  and efficient.

## Single-ride map: start/finish markers + speed profile toggle
- **What:** The full-screen ride map now draws persistent **Start** (green) and
  **Finish** (red) dots at the route ends — green/red is the universal convention,
  matching the orange hover dot's circle style; each has a hover tooltip and they
  redraw with the line on a colour-mode change. The profile panel below the map can
  now graph **Speed** as well as **Elevation**, via an "Elevation | Speed" segmented
  toggle (shown only when the full track carries both elevation and timestamps).
  `renderRideProfile` was generalized to plot either metric (speed anchored at 0,
  km/h axis); the cursor sync is unchanged since the x-axis is distance for both.
- **Why:** "Where did the ride end?" wasn't answerable from the line alone (only a
  transient hover dot existed), and the recorded track already carries per-point
  speed (reused via `fullTrackSpeedsKmh` + `movingAverage`) — so surfacing a speed
  profile is a natural, math-free extension of the existing elevation graph.

## Surface the cached full GPX: "GPX" badge, "Full GPX" filter, clearer "Route" label
- **What:** Ride cards carry a subtle "GPX" badge (muted pill + small green
  "ready offline" dot) when the full recorded GPX is cached locally, and the Explore
  filter bar gains a "Full GPX" tri-state chip (any → cached → not cached), both
  driven by `RideView.gpx_cached`. The existing route-preview filter was relabeled
  **"GPS" → "Route"** to read cleanly next to it (the lightweight stored polyline vs
  the full recorded track); the internal `gps` key is unchanged.
- **Why:** With full GPX now persistently cached, "which rides already have the real
  track (offline map/profile, instant save)?" is a distinct axis from "does the route
  preview exist" — so it needed its own quiet indicator + filter, and the old "GPS"
  label was ambiguous once both concepts shared the bar.

## Declutter the header & unify GPX action naming
- **What:** The labeled "Data" dropdown (Import / Export / Clear GPX cache / Reset)
  is now a single icon-only "⋯" overflow button, so the rare maintenance actions
  stop competing with the task buttons. GPX actions are renamed to one consistent
  vocabulary used identically in the selection menu and the per-ride menu:
  **Save route GPX** (light/local), **Save full GPX** (download), **Fetch full GPX**
  (cache only; shows a "✓" when already cached) — replacing the old mix of
  "Save .gpx files" / "Save .gpx (route)" / "Save full .gpx" / "Fetch full GPX
  (cache only)" with their inconsistent `.gpx`-vs-`GPX` casing, parens-vs-prefix
  qualifiers and stray "files" suffix. Tooltips carry the detail.
- **Why:** The top bar had grown crowded and the same action was worded three
  different ways across surfaces. De-emphasizing maintenance actions to an icon
  and giving every GPX action one name (kind as an adjective, op as the verb)
  makes the bar scannable and the choices unambiguous.

## Offline full-GPX cache: persist downloads gzipped, fetch-only, reuse everywhere
- **What:** Full-track GPX downloads are gzipped and kept in their own IndexedDB
  object store (`gpx`, DB bumped to v2) keyed per profile, behind a new `GpxCache`
  (over a binary `BlobStore` in kv.ts) wired into the Controller; `gzip`/`gunzip`
  live in a shared `src/gzip.ts`. A re-download/bundle of an already-saved ride is
  served straight from the cache (no network, fully offline), so a year-bundle only
  fetches what it's missing and an all-cached full save skips the relay-consent +
  re-auth prompts. A new selection/per-ride **"Fetch full GPX"** action pre-warms the
  cache *without* saving any file — an orthogonal `save:false` flag on the
  `download-gpx` task (its own non-coalescing sweep) that runs the same fetch + map
  rehydrate + cache write, minus delivery. The ride map now rehydrates a cached
  track from the cache on open (`Controller.loadCachedFullTrack`) and `fetchFullTrack`
  falls back to the cache before the source, so the full map UX (real time/elevation/
  speed profile) works offline after a reload instead of showing "Fetch full track".
  An icon-menu **"Clear GPX cache"** flushes only the GPX bytes (Reset still wipes
  everything); the header size chip shows the cache total (`… · X MB GPX`).
- **Why:** The full GPX is the expensive artifact (server-side render + ~500 KB,
  paced 1/s); discarding it after one save meant re-paying that cost every time, and
  the parsed track only ever lived in per-session memory — so a reload silently lost
  it. Persisting it gzipped makes re-saves and the offline map instant, a *separate*
  store + flush keeps megabytes of GPX out of the re-serialized state blob (and lets
  the user reclaim it without losing rides/settings), and a file-free "fetch" makes
  "just make these available offline" a first-class action instead of a noisy download.

## Bundle multi-ride GPX downloads into a single .zip
- **What:** A bulk GPX download (selecting many rides → save) now delivers ONE `.zip`
  containing every ride's GPX instead of firing one `<a download>` click per ride; a
  single-ride download still saves a plain `.gpx`. Applies to both light (route-only,
  local) and full (cloud-rendered) modes. Added a dependency-free ZIP builder
  (`src/zip.ts`) — CRC-32 + raw DEFLATE via the native `CompressionStream("deflate")`
  (header/trailer stripped; STORE fallback when a payload doesn't shrink) — and reworked
  `doDownloadGpx` to accumulate produced files into a bundle, then emit one zip
  (`Beeline routes <date-range> (N).zip`) via the existing `onGpx`/`saveGpxFile` path
  (now MIME-aware). `emitCachedLightGpx` became a `buildCachedLightGpx` builder so files
  can be collected rather than emitted immediately.
- **Why:** Selecting a whole year only ever saved ~5 files — browsers throttle and
  silently drop rapid programmatic downloads, so most of a large light-mode batch was
  lost, and full mode popped one "Save As" per ride. One archive is one reliable
  download. Hand-rolled the ZIP (no new dependency) to honour the app's dependency-light
  core value, using `deflate`+strip over `deflate-raw` for Node/Vitest compatibility.

## Hover the elevation profile → highlight that point on the route map
- **What:** Hovering the full-screen ride map's elevation profile now lights up the
  matching point on the route above it — dropping/moving the same circle marker and
  writing the distance/time/elevation/speed readout — mirroring the existing map→profile
  sync so the two are fully bidirectional. Extracted a shared `showRideTrackPoint(latLng,
  idx, km)` (used by both the map-hover and the new profile-hover paths) plus a
  `trackPointAtKm` resolver that inverts the map's pixel search, and a `clearRideTrackPoint`
  shared teardown. The profile strip gets a crosshair cursor; listeners are wired once on
  the persistent host (the SVG re-renders per ride but events bubble).
- **Why:** Hover sync only worked one way (map → profile cursor). Reading a climb off the
  profile and seeing *where* on the route it happens is the natural other half, and reusing
  the readout/marker keeps both directions identical.

## Pace full-GPX cloud exports to ≤1 ride/second
- **What:** Full-mode GPX export (`BeelineRideSource.downloadGpx`, full path) no longer
  fans rides out through the upload concurrency pool — it now runs them sequentially,
  paced to at most one cloud export per second (new `FULL_GPX_MIN_INTERVAL_S`, holding
  out only the remainder of each 1 s window via the injected `sleep`). It still goes
  through the existing `download-gpx` task queue, and the per-ride `onFail` →
  aggregated persistent-error path is unchanged. Added a test asserting N−1 paced waits
  for an N-ride batch.
- **Why:** Each full export is a server-side render plus a ~500 KB download; selecting a
  whole year and firing them concurrently hammers the Beeline backend. A deliberate,
  gentle client-side ceiling keeps batch downloads polite without changing the queueing
  or error feedback users already rely on.

## Full-GPX export gateway (optional AWS Lambda relay) + consent + graceful fallback
- **What:** The full-track GPX download can now be routed through an optional, stateless
  relay (`infra/gpx-relay`, a zero-dep Node 20 AWS Lambda behind a Function URL). In a
  deployed browser the direct download can't complete — the authenticated Firebase
  Storage `?alt=media` GET 302-redirects to a Google host that returns no
  `Access-Control-Allow-Origin`, so the browser blocks the cross-origin read. The relay
  does both export hops server-side (taking only a `rideId` — never a client URL, so no
  SSRF) and returns the gzipped GPX with CORS headers. Wiring: build-time
  `GPX_RELAY_URL` (Vite `define` → `__GPX_RELAY_URL__`), passed in the Pages deploy
  workflow as a repo Variable; empty by default so the app stays backend-free
  (dev `dev:proxy`, native shells). Before the first relayed download the app shows a
  one-time consent dialog (what's sent: the short-lived id token + ride id; never the
  password; gateway stores nothing) with a "Don't ask again" checkbox persisted in
  localStorage. If the gateway is unreachable mid-download, each affected ride degrades to
  a route-only GPX synthesized from the cached polyline (the task still succeeds, with a
  status note) instead of failing; a genuine "no recorded track" stays a real error.
  Relay safety (free, fail-closed): kill switch (`ENABLED=0` → 503 → app falls back),
  Origin allow-list, strict `rideId` validation, and a best-effort per-account/per-IP
  in-memory rate limit — paired with low reserved concurrency + an AWS Budgets alert as
  the real ceiling (see `infra/gpx-relay/README.md`).
- **Why:** Every prior CORS workaround (the empirical probe, the dev proxy) confirmed the
  Storage redirect drops its CORS header in production, so the browser physically cannot
  finish the download — a tiny server-side relay is the smallest fix that restores the
  real timed/elevation track. It's kept strictly optional and isolated from the SPA build
  so the backend-free promise holds when unset; consent + graceful light fallback keep the
  user informed and the app working even when the gateway is off or down; the layered,
  zero-cost rate limiting guards a self-hosted public URL from a surprise bill.

## Full recorded GPX track: fetch on demand, real time/elevation map + profile
- **What:** Fetch a ride's full recorded GPX on demand (cloud `exportRide` → Firebase
  Storage → gunzip: the real ~1 Hz track with per-point time + elevation), kept in
  memory for the session and never persisted; the lightweight polyline still drives the
  list/heatmap. On the single-ride map it replaces the even-pace time *estimate* with
  real time/elevation/speed on hover, adds a hideable elevation profile, a height/speed
  route recolour, and a summary strip (points, measured distance, elevation gain/loss,
  recording span, peak/avg speed). Save-GPX offers light (route-only, local) and full
  (cloud) variants, per-ride and bulk; a failed fetch shows inline (with Retry) + toast.
- **Why:** The ride record only carries a downsampled polyline (no time/elevation), so
  every per-point readout was an estimate. The cloud holds the real trace; exposing it
  on demand gives honest time attribution and elevation without bloating storage.

## Compact the distance/speed chart panel on narrow screens
- **What:** On ≤560px the Explore chart panel's header no longer wastes vertical
  space. The four KPIs (total / rides / avg / avg-per-ride) dropped their
  `margin-left:auto` right-push and 22px gaps and now pack left on a single
  full-width row (~37px instead of a right-aligned ~100px two-row block); their
  numbers shrink 16px → 14px. The Distance/Speed and 5-way granularity segmented
  controls are compacted (4px/8px, 11px) and made `overflow-x:auto` so the
  granularity row never clips on a phone instead of overflowing the panel. Panel
  padding, head gap and the trim-slider widths are trimmed to match.
- **Why:** The chart header ate ~127px before a single bar showed, most of it the
  big right-aligned KPI block and a granularity segment that overflowed/clipped at
  phone width. Left-packing the KPIs onto one row and letting the segments scroll
  reclaims that space and keeps the chart — the actual content — above the fold.
  Desktop is untouched (KPIs stay right-aligned at full size).

## Collapse the filter bar behind a "Filters" toggle on narrow screens
- **What:** On ≤560px the Explore filter bar (status segment + five tri-state chips +
  Source/Distance fields + Clear) — which otherwise wraps into ~4 rows (~100px) above
  the list — now collapses behind a single **"Filters"** disclosure pill that expands
  the controls as a stacked panel. The pill carries an active-dimension **count badge**
  (new canonical `filterActiveCount` in [src/filter.ts](src/filter.ts), with `filtersActive`
  redefined as its `> 0` case) so a collapsed bar still signals that filtering is on, and
  goes accent when any filter is set. Toggling flips an `.open` class on the static
  `#filterbar` directly (ephemeral view state, not routed through render). Also fixed a
  latent bug surfaced here: **"Clear filters"** was permanently visible — the JS toggles
  `.hidden` on it, but no rule backed that bare class (the sheet's convention is
  component-scoped `.hidden`); added the missing `#fClear.hidden { display: none }`.
- **Why:** After the ride-row and header mobile passes, the always-open filter bar was the
  last thing eating a big chunk of a phone screen before any rides showed. Collapsing it
  (same disclosure idea, ≤560px to match the header's icon-only cut-off) reclaims the space
  while a count badge keeps active filters discoverable; desktop is untouched (the bar stays
  inline, toggle hidden). Reused the accent-pill vocabulary and inline-SVG icon rule
  throughout.

## Narrow-mobile iteration: icon-only actions for ride rows + header
- **What:** Reworked the narrow-viewport layout so it's usable on a ~390px phone.
  Ride rows: the per-ride **"Upload to Strava"** button collapses to an icon-only
  square (new `UPLOAD_ICON`, label wrapped in `.btn-label`) at ≤768px, freeing the
  ~90px the text ate so the expanded **stats grid** and **mini-map** (which live
  inside `.rmain`) get real width instead of being crushed into a narrow left
  column; status badges now wrap below the title instead of overflowing, the stats
  grid packs tighter (`minmax(96px…)`, two fixed columns ≤480px) and the mini-map
  shortens (150px → 130px). Header: **Change source**, **Data** and **Upload all to
  Strava** gained inline icons (hidden on desktop, label-only) that take over as
  icon-only squares ≤560px, with **Re-sync**'s hoisted text label dropping to reveal
  its existing refresh icon — collapsing the toolbar from three stacked rows (~128px)
  to one (~76–98px). Added two finer breakpoints (`560px` for the header collapse,
  `480px` for very-narrow chrome) on top of the existing `768px` block.
- **Why:** The narrow view was "barely usable" — the upload button + kebab squeezed
  every ride's content/stats/map into a cramped column, and the header wrapped into a
  bloated three-row stack. Reusing the established icon-only pattern (inline SVG, never
  Unicode glyphs; meaning kept in `title`/`aria-label`) reclaims the width text labels
  ate while leaving desktop untouched, so the same actions stay one tap away on a phone.

## Rename & delete rides (cloud, through the RideSource seam) (v0.4.0)
- **What:** Added per-ride **Rename** and **Delete** as cloud actions. New
  `renameRide`/`deleteRide` on the `RideSource` seam ([src/source.ts](src/source.ts)),
  backed by direct Realtime-Database writes in [src/beeline-api.ts](src/beeline-api.ts)
  — `PATCH …/rides/<uid>/<pushId>.json {name}` to rename, `DELETE …/rides/<uid>/<pushId>.json`
  to delete (per the APK-verified protocol, temp/beeline-protocol.md §5a). The
  `BeelineRideSource` resolves a ride key → push-id from its index (refreshing when cold,
  e.g. after an offline re-auth) and mirrors the change locally; the demo backend mutates
  its in-memory rides so demo/tests exercise the path. Both run as single-ride `JobQueue`
  tasks (`"rename"`/`"delete"`, never coalesced) so they can't race a scan/upload mutating
  the source index. UI: the kebab menu gained **Rename…** (themed prompt dialog, prefilled,
  Enter-to-accept) and **Delete…** (strong confirm naming the ride). Both gate through
  `withBeelineAccess` re-auth like uploads.
- **Why:** Bring the two remaining destructive account actions into the app instead of
  forcing a trip to the phone. **Delete keeps the ride locally as a tombstone** (reusing the
  existing `deleted`/`deleted_at` state via `store.markDeleted`) rather than dropping the
  row — the cloud node is gone but the ride stays visible, marked deleted, and a later
  complete scan won't resurrect it. Routing through the seam (not a local-only edit) keeps
  the change authoritative and consistent with how uploads already work.

## Declutter the ride row: only "Upload to Strava" stays inline; the rest move under "⋯"
- **What:** Restructured the per-ride action cluster in [src/main.ts](src/main.ts) so the
  primary **Upload to Strava** is the only always-visible button; **Save .gpx**, **Rename…**
  and **Delete…** now live in the "⋯" overflow menu at *every* width (not just mobile).
  Scoped the overflow-dropdown CSS to `.rbtns` in [src/style.css](src/style.css) so the
  single-action group headers keep their inline-on-desktop behaviour.
- **Why:** Adding Rename + Delete pushed the row to four inline buttons on desktop — a wall
  of controls. Collapsing everything but the primary action behind the existing kebab keeps
  the row minimal and identical on desktop and mobile, without inventing new UI.

## Reliably scroll-to + blink a ride opened from a map's "Selected" list on mobile
- **What:** Reworked `openRideInExplore` in [src/main.ts](src/main.ts) to scroll the
  target `.rrow` into view across several settle passes (rAF → 120ms → 360ms) using
  instant (not smooth) scrolls, firing the `.flash` pulse only on the final pass.
  Added `scroll-margin-top` to `.rrow` so it clears the sticky header, and widened the
  map/heatmap click hit-radius (`CLICK_PX`) to 22px on coarse (touch) pointers.
- **Why:** On mobile a single smooth scroll landed wrong and the blink was often missed:
  the just-opened detail block mounts a Leaflet mini-map a tick later and the mobile URL
  bar reflows the viewport, so the row kept moving after the one scroll. Re-scrolling on a
  few ticks corrects for those late layout shifts, and a fingertip needs a bigger hit area
  than a mouse to land on a track line.


- **What:** Reworked the Explore status segment from `All / Pending / Uploaded / Other`
  to `All / Not uploaded / Processing / Uploaded`. The `Filters.status` union and its
  predicate in [src/filter.ts](src/filter.ts) now use three mutually-exclusive concrete
  buckets that partition every ride — `uploaded`, `processing` (an upload mid-flight),
  and `not-uploaded` (pending/unknown, still eligible). Updated `STATUS_VALUES`, the
  `#fStatus` markup, and the filter tests; the `loadFilters` sanitizer migrates stale
  persisted `pending`/`other` values to `all`.
- **Why:** "Other" was a catch-all that actually hid Beeline's real `processing`
  (`startedUploading`/`uploading`) state behind a meaningless label, and the old
  `pending` bucket folded the orthogonal deletion check into status. Naming the genuine
  states makes each bucket self-explanatory and leaves deletion to the separate filter.

## Remove the orphaned Check / route-preview engine paths
- **What:** Second cleanup batch after deleting the Check / Preview-route UI. Dropped
  `controller.status()` and the `"status"` `TaskKind` (renamed the shared `doTargets`
  to `doUpload`, upload-only); removed the `doUpload` parameter from
  `RideSource.processTargets` (+ Beeline impl) so it is always an upload sweep; and
  collapsed `downloadGpx`'s preview-vs-save split — GPX export now always writes the
  file (the `saveToDisk` flag, its job-payload, and the preview-only coalescing guard
  are gone). Updated tests to the new signatures and removed the obsolete
  preview/save coalescing test.
- **Why:** With Beeline the only source, status arrives with the one-shot history
  download and every ride already carries its full track, so "check status" and
  "rough route preview" did nothing. Removing the dead branches also fixes the
  half-applied UI cleanup where the "Save .gpx" actions had been pointed at the
  (now-removed) preview mode and silently stopped writing files.

## Drop the "Sign out" button
- **What:** Removed the connected-state "Sign out" affordance (the connection slot
  now just shows the device name when signed in) and its only handler, the
  orphaned `leaveSource()`. The offline "Sign in" re-auth shortcut stays.
- **Why:** The password is never stored, so a plain page refresh already drops
  account access back to the offline cached-rides state, and "Change source"
  already leads out — a dedicated sign-out did little but add header clutter.

## "View saved rides" reads the Beeline cache (fix empty list after sign out)
- **What:** Folded the vestigial `goOffline()` into `goBeelineOffline()` so every
  saved-rides entry point — Sign out → "Skip — view saved rides", Reset, and the
  no-profile boot — loads the Beeline profile store (`beeline-toolkit-state:beeline`)
  and presents Beeline-offline chrome, instead of a separate empty default-key store
  under the now-dead `"offline"` source mode.
- **Why:** Beeline rides are cached under the per-profile key, but `goOffline()` loaded
  `Store.load()` with no key → the default `"beeline-toolkit-state"` blob a Beeline user
  never wrote to, so the saved-rides view came up blank. With Beeline the only source,
  the distinct `"offline"` runtime mode was a leftover; converging fixes the empty list
  and stops the legacy non-Beeline Check/Preview chrome (gated on `!beelineMode()`) from
  ever rendering.

## Map & Stats UX polish
- **What:** Date filter sits below the basemap (Map + Stats) so it never covers the
  OSM credit; drag the selected span as a fixed-width window; area-select works on
  touch; Leaflet zoom/attribution themed to match the dark UI; Stats cards restyled
  minimal with a "filtered" hint when the date range is narrowed; misc modal/slider/
  form fixes.
- **Why:** Cohesive, lighter map and stats experience that also works on mobile.

## Render the all-rides Map on a canvas (perf at scale)
- **What:** Switched `#allRidesMap` to Leaflet's canvas renderer (`preferCanvas: true`)
  so every ride track draws onto one `<canvas>` instead of one SVG `<path>` per ride,
  moved the track glow CSS from per-line `.track-line` onto `.leaflet-canvas`, and
  memoized polyline decoding in `ridesWithTracks()` (keyed by the immutable encoded
  string) so background/job-tick re-mounts don't re-decode thousands of tracks.
- **Why:** At a power user's scale (here ~1964 drawable tracks) the SVG DOM and the
  repeated decode were the bottleneck — pan/zoom and re-renders dragged. Canvas blends
  the translucent strokes identically (the "ridden more = brighter" heatmap look is
  preserved) and selection is unaffected (it uses our own pixel projection, not
  Leaflet path events), so this is a pure perf win with no UX change.

## Unify the heatmap's selection UX with the Map view
- **What:** Moved the Stats route-frequency heatmap's "Selected" matches out of the
  full-width strip below the map into a side panel beside it (`.freq-wrap` is now a
  `1fr 280px` grid with a `.freq-main` + `.map-side#heatMatched`, mirroring the Map
  view), with an empty-state hint when nothing is selected. Matched cards now sort
  newest-first in both maps (`renderMatchedCards`), hovering a heatmap card traces that
  ride's route as a bright overlay on the heatmap (`showHeatHover`, reusing `HOT_TRACK`),
  and opening a ride from either list now briefly pulses its Explore row (`.rrow.flash`).
  Also dropped the inaccurate "press GPX to add them" tail from the Map side panel's
  count line.
- **Why:** The two maps' selection flows had drifted apart (side list vs. below-map
  strip, unsorted, no hover feedback on the heatmap); aligning them gives one consistent
  "select → list → hover → open" experience, and the flash makes the jump-to-Explore land
  where the eye expects.

## Declutter OSM map attribution
- **What:** Replaced the repeated per-map "© OpenStreetMap" badge with one canonical
  `OSM_ATTRIBUTION` string: the three big interactive maps (full-screen ride map, all-rides
  Map view, Stats heatmap) keep a *compact* corner credit (`setPrefix(false)` drops the
  "Leaflet" flag) linking to openstreetmap.org/copyright; the per-ride mini-maps drop the
  control entirely; a tiny `.osm-credit` link in the header carries the page-level credit.
- **Why:** The badge was visual noise repeated on every ride card while the wording ("©
  OpenStreetMap") was off from OSM's required "© OpenStreetMap contributors". This keeps a
  single, correctly-worded, linked credit visible wherever tiles render — satisfying OSM's
  tile-usage policy without cluttering each map.

## Removed the ADB (phone) ride source (v0.3.0)
- **What:** Deleted the legacy Android/ADB ride source entirely — `src/adb/` (WebUSB +
  demo transports), `src/beeline.ts` (uiautomator-driven app automation), `AdbRideSource`,
  the interaction-speed/timing profiles, the phone source picker tile, the USB-debugging
  demo notice, and all phone-only chrome. The `RideSource` seam stays (Beeline is now its
  only implementation); shared GPX/catalog/progress types + `realSleep` moved from the
  deleted modules into `src/source.ts`. Dropped `device_serial` and the uiautomator XML
  parsers from `src/parsing.ts`, the three `@yume-chan/adb` deps + `@types/w3c-web-usb`,
  and the ADB tests/recon fixtures. Bumped to 0.3.0.
- **Why:** The Beeline cloud account supersedes ADB on every axis — it pulls the whole
  history in one request (vs ~10 s/ride of UI automation), needs no cable, isn't tied to
  Android/Chromium, and isn't brittle to the Beeline app's layout. Keeping a faithful-but-
  dead phone path behind the seam was pure carrying cost; removing it leaves one fast,
  portable source and a much smaller, simpler codebase.

---

## UX & responsiveness cleanup (mobile fullscreen + source picker)
- **What:** Three small CSS fixes. (1) Fullscreen Map/Stats use `100svh` instead of
  `100vh` (and the mobile bottom row `38svh`) so the ride-labels panel no longer hides
  below the address bar and the floating expand button stops jumping. (2) `.rmapwrap`
  gets `isolation: isolate` so the mini-map's expand button can't paint over the
  full-screen route lightbox. (3) The source picker's phone/ADB option becomes a
  wrapping flex row (text full-width, buttons grouped right) with the `legacy / ADB`
  tag kept on one line, plus a `#srcBeeline` reset so the row's flex-basis doesn't
  balloon the account panel.
- **Why:** Tighten mobile/responsive behaviour and remove stray, cramped, or misplaced
  UI — keeping the one unified design language readable at small widths and in
  full-screen.

---

## Privacy note on the Beeline sign-in screen
- **What:** Added a `.srcopt-note` under the Beeline account sign-in form in the
  source picker: serverless / runs entirely in the browser, password sent once and
  kept only in memory (never stored, so the password manager can fill it), plus an
  open-source line linking the GitHub repo and noting you can run it locally. Shown
  on the full picker only — hidden in password-only re-auth mode.
- **Why:** Reduce the friction/hesitation of typing a password into a third-party
  web app by making the existing privacy posture (already documented in the README)
  visible at the point of entry, and lean on the open-source/run-it-yourself angle
  to earn trust.

## Normalize ride metrics to numbers (drop string duplication)
- **What:** Replaced the persisted localized stat strings (`distance: "5.50 km"`,
  `duration`, and the `stats` label→string map) with a single set of normalized
  numeric fields on `RideRecord`/`RideView` (`distance_km`, `moving_sec`,
  `elapsed_sec`, `avg_speed_kmh`, `max_speed_kmh`, `elevation_gain_m`,
  `elevation_loss_m`; `number | null`, null = unknown). Parsing now converts to
  numbers at the ingestion boundary (`parseRideDetail`/`parseJourneysList` carry a
  `RideMetrics`; the Beeline mapper emits SI→numbers directly), the store migrates
  legacy string blobs on load (one-way, idempotent, strings dropped), and every
  consumer (controller/state, stats, filters, main render) reads the numbers. Added
  `fmtDurationExact` for the detail grid. Python `rides.json` interop is dropped.
- **Why:** The old schema stored the same figure twice (top-level summary *and* the
  `stats` map) as gross locale-dependent strings that every reader had to re-parse —
  fighting the "normalize once, at the boundary" value and inviting the comma-decimal
  10× bug. One numeric field per metric removes the duplication, kills the
  number→string→number round-trip on the Beeline path, and makes every aggregate read
  a clean number.

## Stamp app version/build into exported state
- **What:** `exportRides` now prepends an `app: { version, commit, build_date }` block
  (the existing Vite build globals) to the downloaded state file; `store.exportJson`
  takes an optional `meta` merged ahead of the cache. The persisted IndexedDB blob is
  unchanged — the stamp lives only in the download, and `ingest` ignores it on import.
- **Why:** An exported state should record which build produced it, so a future import
  (or a bug report) can tell the schema/app version at a glance.

## Reset returns to the source picker
- **What:** After erasing local data, Reset now forgets the chosen source and shows
  the source-selection screen (mirroring Change source) instead of dropping into
  offline mode on the last-used source. Updated the confirm/toast copy to match.
- **Why:** A full wipe is effectively starting over, so the user should land on the
  same first-run picker — landing back on a now-empty source was confusing, and a
  later reload already led to the picker, so this makes the two paths consistent.

## Mobile-friendly header + job pill
- **What:** Make the chrome reflow on narrow screens (wrap the connection cluster,
  guard against sideways scroll, drop the storage-size pill, tighten buttons) and
  keep the floating job pill within the viewport and clear of Chrome Android's
  bottom toolbar. Also: hide the selected-ride actions when nothing is selected,
  shorten "Upload all pending to Strava" → "Upload all to Strava" behind a styled
  confirm modal, drop the redundant "Exit demo" button (use Change source), and
  tag the source picker "(the forgotten Beeline Velo UI)".
- **Why:** On a phone the header was a tall stack of mostly-dead controls and the
  pill hid behind the address bar / ran off-screen. Bulk upload to Strava also
  deserves an on-brand "are you sure" rather than the browser's native confirm.

## Condense the ride-detail stats grid
- **What:** Reworked the expanded ride-detail stats (Distance / speeds / times /
  elevation) into a tighter grid — semantic `.stat`/`.k`/`.v` markup replacing the
  old `label<br><b>value</b>`, with smaller fonts, tighter gaps and narrower
  `minmax(120px,1fr)` columns so more stats pack per row.
- **Why:** The old grid was over-tall, especially on narrow screens where it fell
  to ~2 columns of stacked pairs. The compact stacked layout shortens the panel
  and fits more per row without losing the label/value readability.

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
