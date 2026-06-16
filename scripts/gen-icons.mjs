// One-off rasterizer: renders the master logo SVG to the PNG icon sizes the app
// references (favicon fallback, apple-touch-icon, PWA manifest icon). Run with
// `node scripts/gen-icons.mjs` after changing public/logo.svg, then commit the PNGs.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const pub = resolve(here, "..", "public");
const src = await readFile(resolve(pub, "logo.svg"));

const targets = [
  { file: "favicon-32.png", size: 32 },
  { file: "apple-touch-icon.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
];

for (const { file, size } of targets) {
  const png = await sharp(src, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  await writeFile(resolve(pub, file), png);
  console.log(`wrote public/${file} (${size}x${size})`);
}
