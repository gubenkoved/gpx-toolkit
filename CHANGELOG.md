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
