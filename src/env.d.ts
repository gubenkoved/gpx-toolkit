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
