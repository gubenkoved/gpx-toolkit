# Beeline Toolkit

A **backend-free** browser companion for the **Beeline Velo 2** that batch-uploads your
rides to **Strava**. Beeline only lets you upload rides one-by-one; this app lists your
rides with their upload status, lets you select them, and uploads in a batch.

The main way to use it is the **Beeline account** source: sign in with your Beeline
email/password and the app downloads your **entire** ride history — routes, stats and Strava
status — in a single request from Beeline's own cloud backend, then uploads to Strava
server-side (fast, and several rides at once). No cable, works in any modern browser.

A legacy **phone (ADB)** source is also available for the cable-bound, account-credential-free
route — see [Legacy: phone (ADB) source](#legacy-phone-adb-source). Each source has its own
**demo** so you can explore either experience with no hardware and no account.

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

(The legacy phone source has its own extra requirements — see
[Legacy: phone (ADB) source](#legacy-phone-adb-source).)

## Quick start

```bash
npm install
npm run dev          # open the printed http://localhost:… URL
```

On first run the app shows a **source picker** — sign in to your **Beeline account** (or try
its **demo**). The legacy **Connect phone** option lives here too. Your choice is remembered,
so later visits go straight back into that mode (a Beeline account opens on your cached rides
and asks for the password only when you sync). Use **Change source** in the header to switch.

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
| [src/source.ts](src/source.ts) | `RideSource` seam + `AdbRideSource` (legacy phone adapter) |
| [src/beeline-api.ts](src/beeline-api.ts) | Beeline cloud backend client (auth, rides, upload) |
| [src/beeline-source.ts](src/beeline-source.ts) | `BeelineRideSource` — the account source over the API |
| [src/beeline-demo.ts](src/beeline-demo.ts) | Simulated Beeline backend for the account demo |
| [src/beeline.ts](src/beeline.ts) | Beeline app navigation + upload automation (phone) |
| [src/parsing.ts](src/parsing.ts) | Parse uiautomator dumps + ride-key helpers |
| [src/jobs.ts](src/jobs.ts) | Single-worker background job queue |
| [src/store.ts](src/store.ts) | Per-source IndexedDB-backed status cache |
| [src/track.ts](src/track.ts) | Decode/render ride GPS tracks |
| [src/adb/](src/adb/) | ADB transports — `webusb.ts` (real), `demo.ts` (sample data) |

## Tests

```bash
npm test
```

Parser tests run against real Beeline UI dumps captured during recon, in
[tests/fixtures/recon/](tests/fixtures/recon/); the Beeline-account source is tested against
a captured backend response in [tests/fixtures/beeline/](tests/fixtures/beeline/).

## Legacy: phone (ADB) source

Before the Beeline-account source existed, the only way in was to drive the **real Beeline
Android app** over USB — reading the phone's screen (uiautomator XML) and tapping buttons,
one ride at a time. That path is still available as an extra (pick **Connect phone** in the
source picker), but the account source supersedes it: it's far faster (whole history in one
request vs ~10 s per ride), needs no cable, and isn't tied to Android or a particular screen
layout. Prefer the account source unless you specifically can't use it.

It talks to a USB-connected Android phone over **WebUSB** (ADB via
[`@yume-chan/adb`](https://github.com/yume-chan/ya-webadb)) and never handles your account
credentials — it's the app on the phone (already signed in) that's being driven.

**Extra requirements:**

- An **Android** phone with the Beeline Velo 2 app (`co.beeline`) — **signed in** and with
  **Strava connected**. iOS/iPhone is **not supported** (ADB is Android-only).
- A Chromium-based browser (Chrome / Edge) — WebUSB is unavailable in Firefox/Safari; served
  over `localhost` or HTTPS (WebUSB is secure-context only).
- USB debugging enabled (Developer Options), phone plugged in and **authorized**.

**Notes specific to this source:**

- Choose a time range (Today / Week / Month / Year / All, or a custom number of days) and
  press **Scan**; scans stop early once they pass the window. Rides keep a lightweight route
  sketch (not the full GPS track the account source carries).
- An **Interaction speed** control (Safe → Turbo) tunes how aggressively the tool drives the
  phone — Turbo skips upload-verification reads (tap-and-go) and a later **Check** reconciles
  the real status. Uploads run one ride at a time.
- It's UI automation, so it can break if Beeline changes its layout; update coordinates/labels
  in [src/beeline.ts](src/beeline.ts) and [src/parsing.ts](src/parsing.ts) if that happens.
  Keep the phone unlocked and on while running; don't touch it mid-run.

## Notes

- Your **Beeline password is never stored** — see
  [Beeline account & your password](#beeline-account--your-password).
- Only the Strava upload path is automated (komoot is detected but left alone).
