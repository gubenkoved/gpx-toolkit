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
