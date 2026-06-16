# Beeline Toolkit

A **backend-free** browser companion for the **Beeline Velo 2** that batch-uploads your
rides to **Strava**. Beeline only lets you upload rides one-by-one; this app lists your
rides with their upload status, lets you select them, and uploads in a batch.

The app uses the **Beeline account** source: sign in with your Beeline email/password and the
app downloads your **entire** ride history — routes, stats and Strava status — in a single
request from Beeline's own cloud backend, then uploads to Strava server-side (fast, and
several rides at once). No cable, works in any modern browser.

There's also a **demo** so you can explore with no account and no data of your own.

> **Your Beeline password is never stored.** Sign-in uses it once to obtain a short-lived
> token held only in memory; nothing is written to disk. On reload (or whenever an action
> needs the account) the app shows your last-downloaded rides and asks you to sign in again
> — so your **browser/password manager** can inject the password on demand. See
> [Beeline account & your password](#beeline-account--your-password).

> **Vibe coded.** This project is almost entirely "vibe coded" — developed with the help of
> LLM coding agents. Review accordingly and expect the occasional rough edge.

Everything runs **in the browser**: the Beeline-account source talks to Beeline's Firebase
backend over `fetch` (CORS-friendly, no proxy). There is no server and no rooting. State is
kept per-source in the browser (IndexedDB).

![Beeline Toolkit listing scanned rides with a distance chart, KPIs, and month groups, ready to batch-upload to Strava](docs/screenshot.png)

## Requirements

- A **Beeline account** with **Strava already connected** (in the Beeline app:
  Settings → Integrations → Strava).
- Any modern browser; the page served over `localhost` or HTTPS.
- For development: Node.js 20+ and npm.

## Quick start

```bash
npm install
npm run dev          # open the printed http://localhost:… URL
```

On first run the app shows a **source picker** — sign in to your **Beeline account** (or try
its **demo**). Your choice is remembered, so later visits go straight back into that mode (a
Beeline account opens on your cached rides and asks for the password only when you sync). Use
**Change source** in the header to switch.

## Beeline account & your password

The design goal is to **never store your Beeline password in clear** (or at all):

- Signing in sends the password **once** to Beeline's auth endpoint and keeps only the
  resulting short-lived ID token **in memory**. The password is never persisted, and the
  token is gone on reload.
- Only your **email** and the fact that you last used the Beeline source are remembered, to
  prefill and re-open the sign-in.
- On reload, the app enters an **offline, cached-rides** mode (everything you already
  downloaded is fully browsable). The moment you do something that needs the account —
  **Re-sync** or **Upload to Strava** — it asks you to sign in again, which is exactly when
  your **password manager** can autofill it. The action you triggered then runs.

This keeps the app autonomous offline and leaves password custody entirely to your browser /
password manager.

## Full-track GPX & the optional export gateway

Saving a ride's **full** recorded GPX (real per-point timestamps + elevation) needs one
server-side hop: Beeline renders the file to Firebase Storage, and the authenticated
download there 302-redirects to a Google host that returns **no CORS header**, so a browser
can't complete it. The app ships an **optional**, stateless relay for this
([`infra/gpx-relay`](infra/gpx-relay/README.md) — a zero-dependency AWS Lambda you host).

- It's **off by default**: with no relay configured the app is fully backend-free, and the
  light **route-only** GPX (synthesized from the cached polyline) still works everywhere.
- When a relay **is** configured (build-time `GPX_RELAY_URL`), the first full-GPX download
  shows a **one-time consent** prompt explaining that the request is routed through your
  gateway. It forwards only your **short-lived sign-in token and the ride id** — never your
  password — and the gateway **stores nothing**. Tick *"Don't ask again"* to remember it.
- If the gateway is ever **unreachable**, the download **degrades gracefully** to a
  route-only GPX instead of failing.

See [`infra/gpx-relay/README.md`](infra/gpx-relay/README.md) for the AWS deploy guide and the
(free, fail-closed) rate-limiting / cost-safety model.

## Usage

- **Get your rides** — press **Re-sync** to download your whole history in one shot.
- See a **distance-per-month chart** with quick KPIs (total km, ride count, averages).
- Rides are grouped by **year → month** with a green/amber bar showing uploaded vs pending.
  Each year and month has a **select-all checkbox** plus batch actions, so you can upload a
  whole month or year at once.
- Expand any ride to see full details (distance, avg/max speed, moving / elapsed time,
  elevation) and its **full** GPS route on a map.
- **Filter** by **Strava status** (Pending / Uploaded / Other), route presence, destination,
  whether you've given the ride a real name, and distance.
- **Upload** one ride, a month, a year, the current selection, or *all* known pending — with
  a live progress indicator. Uploads run **concurrently**, server-side.
- **Download GPX** for any ride (synthesized from the stored track — works offline too).
- **Queue work freely** — requests line up and drain in order, coalescing consecutive
  sweeps. Use **Clear queue** and **Stop** to manage it. Local data can be exported/imported
  as JSON from the **Data** menu.

## Scripts

```bash
npm run dev          # Vite dev server
npm run build        # type-check (tsc --noEmit) + production build to dist/
npm run preview      # serve the production build
npm test             # run the vitest suite
npm run test:watch   # watch mode
```

## Project layout

| Path | Responsibility |
|------|----------------|
| [index.html](index.html) | App shell, styles, and markup |
| [src/main.ts](src/main.ts) | UI entry point — rendering, DOM wiring, source picker |
| [src/controller.ts](src/controller.ts) | App state + scan/check/upload orchestration |
| [src/source.ts](src/source.ts) | `RideSource` seam + shared GPX/catalog types |
| [src/beeline-api.ts](src/beeline-api.ts) | Beeline cloud backend client (auth, rides, upload) |
| [src/beeline-source.ts](src/beeline-source.ts) | `BeelineRideSource` — the account source over the API |
| [src/beeline-demo.ts](src/beeline-demo.ts) | Simulated Beeline backend for the account demo |
| [src/parsing.ts](src/parsing.ts) | Normalized metrics + ride-key/date helpers |
| [src/jobs.ts](src/jobs.ts) | Single-worker background job queue |
| [src/store.ts](src/store.ts) | Per-source IndexedDB-backed status cache |
| [src/track.ts](src/track.ts) | Decode/render ride GPS tracks |

## Tests

```bash
npm test
```

The Beeline-account source is tested against a captured backend response in
[tests/fixtures/beeline/](tests/fixtures/beeline/).

## Notes

- Your **Beeline password is never stored** — see
  [Beeline account & your password](#beeline-account--your-password).
- Only the Strava upload path is automated (komoot is detected but left alone).
