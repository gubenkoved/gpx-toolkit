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
