/**
 * Ambient declarations for build-time constants injected by Vite's `define`
 * (see vite.config.ts). These are string-replaced at bundle time.
 */

/** App version from package.json, e.g. "0.1.0". */
declare const __APP_VERSION__: string;
/** Short git commit SHA at build time, or "unknown" when git is unavailable. */
declare const __APP_COMMIT__: string;
/** Build date as an ISO day, e.g. "2026-06-13". */
declare const __APP_BUILD_DATE__: string;
/**
 * True only in a dev server started with `npm run dev:proxy` (BEELINE_DEV_PROXY=1):
 * routes the full-track GPX download through the Vite proxy (`/bl-storage`) to
 * sidestep the Storage redirect's missing CORS header for local testing. Always
 * `false` in production builds, so the proxy path never ships.
 */
declare const __BEELINE_DEV_PROXY__: boolean;
/**
 * Optional production relay URL for the full-track GPX download (see
 * infra/gpx-relay). Empty string when unset — the app then uses the direct
 * in-browser export path and stays fully backend-free. When set, the full-GPX
 * download is routed through this stateless Lambda to sidestep the Storage
 * redirect's missing CORS header in production.
 */
declare const __GPX_RELAY_URL__: string;
