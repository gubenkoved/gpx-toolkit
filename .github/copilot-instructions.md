# Beeline Toolkit — Copilot instructions

A **backend-free**, framework-free browser SPA (vanilla TypeScript + DOM) that drives the
**Beeline Velo 2** Android app over **WebUSB ADB** to batch-upload rides to **Strava**.
Everything runs in the browser: it reads the phone's screen (uiautomator XML), taps
buttons, and persists ride status in `LocalStorage`. There is no server and no API.

## Tech stack & commands

- **TypeScript 5.6** (strict), **Vite 6** (`base: "./"`, `target: "esnext"`), **Vitest 2** + **jsdom**, **leaflet** for maps.
- ADB transport: [`@yume-chan/adb`](https://github.com/yume-chan/ya-webadb) (Tango) — Chromium-only, secure-context only.
- `npm run dev` — Vite dev server (boots in demo mode with sample rides).
- `npm run build` — `tsc --noEmit` type-check **then** `vite build`. Always type-check before considering a change done.
- `npm test` / `npm run test:watch` — Vitest.

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
- **Error handling**: throw/catch `AdbError` for device issues; wrap `localStorage` access in `try/catch` (private mode can throw — non-fatal); surface failures to the user via `toast(message, isError)` and fall back to demo mode rather than crashing.

## Domain notes

- **Ride keys** are human dates like `"Sat Jun 13 2026 at 14:22"`; months are `"2026-06"` / `"June 2026"`.
- **Timing profiles** (`PROFILES`: `safe`/`normal`/`fast`/`turbo`) trade robustness for speed; `turbo` skips upload-verification reads (optimistic) and is reconciled by a later Check.
- **Job coalescing**: consecutive `upload`/`status`/`download-gpx` tasks merge into one sweep — preserve this when touching `JobQueue`.
- Only the **Strava** upload path is automated (komoot is detected but left alone).

## Testing

- Tests live in `tests/**/*.test.ts` (Vitest + jsdom).
- **Parser tests** run against real captured Beeline screens in [tests/fixtures/recon/](../tests/fixtures/recon/) — reuse these dumps rather than hand-writing XML.
- **Integration tests** drive a full `Controller` + `DemoAdb` (no phone). Wait for async work with `await vi.waitFor(() => expect(c.state().jobs.busy).toBe(false))`.
- Use the in-test `memStorage()` helper and a `makeController()` factory with an instant sleep — don't touch real `localStorage` or wall-clock delays in tests.

## Gotchas

- UI automation is inherently brittle (~10 s/ride) and breaks if Beeline changes its layout — update coordinates/labels in [src/beeline.ts](../src/beeline.ts) and [src/parsing.ts](../src/parsing.ts) when that happens, and add a fresh fixture under `tests/fixtures/recon/`.
- WebUSB requires Chromium (Chrome/Edge) and a secure context (`localhost` or HTTPS); it is unavailable in Firefox/Safari.
- Keep new code dependency-light — this app intentionally has no backend and a tiny dependency set.
