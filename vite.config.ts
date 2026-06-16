/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Version metadata baked into the bundle at build time. The version comes from
// package.json; the commit and build date are best-effort — a static/offline
// build with no git available still works, falling back to "unknown".
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

// Opt-in dev-only reverse proxy for the full-track GPX download, enabled ONLY when
// the dev server is started via `npm run dev:proxy` (BEELINE_DEV_PROXY=1). The
// authenticated `firebasestorage.…/?alt=media` GET 302-redirects to a Google host
// that sends NO `Access-Control-Allow-Origin`, so the browser blocks it (the
// `exportRide` POST itself is CORS-clean and needs no proxy). With the flag on, the
// page fetches a same-origin `/bl-storage/…` path and Vite forwards it server-side,
// where CORS doesn't apply and the redirect is followed for us. Default `npm run dev`
// keeps the real cross-origin host so normal dev still exercises genuine CORS.
const devProxy = process.env.BEELINE_DEV_PROXY === "1";

// Optional production relay for the full-track GPX download (see infra/gpx-relay).
// The browser can't finish that download itself — the Storage redirect drops its
// CORS header — so a deployment can point at a tiny stateless Lambda that does the
// fetch server-side. Empty by default: the app then uses the direct in-browser path
// and stays fully backend-free (dev, native shells). String-baked at build time.
const gpxRelayUrl = process.env.GPX_RELAY_URL ?? "";

// `base: "./"` keeps asset URLs relative so the build can be served from any
// path on a static host (GitHub Pages project sites, Netlify subpaths, etc.).
// `target: esnext` (below) keeps modern JS (BigInt, top-level features) intact.
export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__: JSON.stringify(gitCommit()),
    __APP_BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
    // Always a literal boolean in the bundle; `false` in `vite build`, so the
    // `/bl-storage` path and the proxy never ship to production.
    __BEELINE_DEV_PROXY__: JSON.stringify(devProxy),
    // The full-GPX relay URL, baked in at build time ("" when unset).
    __GPX_RELAY_URL__: JSON.stringify(gpxRelayUrl),
  },
  server: devProxy
    ? {
        proxy: {
          "/bl-storage": {
            target: "https://firebasestorage.googleapis.com",
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/bl-storage/, ""),
          },
        },
      }
    : undefined,
  build: {
    target: "esnext",
  },
  optimizeDeps: {
    esbuildOptions: {
      target: "esnext",
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts"],
  },
});
