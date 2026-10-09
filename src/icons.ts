/**
 * GPX Toolkit — the shared button icon set.
 *
 * ONE registry of inline-SVG glyphs (24-unit viewBox, 2px round strokes, the same
 * style as the sidebar and map icons) so every button across the app draws from
 * the same vocabulary. Two ways in:
 *
 *  - `icon(name)` returns the `<svg class="bi">` markup for a template string;
 *  - static markup in index.html declares `data-icon="name"` and `decorateIcons()`
 *    injects the glyph once at boot, so the HTML stays readable and the paths live
 *    in exactly one place.
 *
 * A button that starts with a `.bi` lays out as an icon + label row (see the
 * `button:has(> .bi)` rule in style.css); an icon-only button keeps its meaning in
 * `aria-label`/`title`.
 */

const PATHS = {
  /** Upload tray with an up arrow — import a file. */
  import:
    '<path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  /** Download tray with a down arrow — save / export a file. */
  download:
    '<path d="M12 3v12"/><path d="m8 11 4 4 4-4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  /** Cloud with a down arrow — fetch into the local cache. */
  cloudDown:
    '<path d="M7 18a4 4 0 0 1-.6-7.95A6 6 0 0 1 18 8.5a4 4 0 0 1 .5 7.97"/><path d="M12 12v9"/><path d="m8.5 17.5 3.5 3.5 3.5-3.5"/>',
  /** Box with an up arrow — push to an external service. */
  upload:
    '<path d="M12 16V4"/><path d="m8 8 4-4 4 4"/><path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  /** Arrow out of a box — open elsewhere. */
  external:
    '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/>',
  /** Archive box — everything, zipped. */
  archive:
    '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M10 13h4"/>',
  /** Plus in a circle — add more. */
  add: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  /** Plain plus. */
  plus: '<path d="M12 5v14M5 12h14"/>',
  /** Trash can — drop / delete. */
  trash:
    '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  /** Cross — clear / close. */
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  /** Tick. */
  check: '<path d="m5 12.5 4.2 4.2L19 7"/>',
  /** Back arrow — return to the overview. */
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  chevLeft: '<path d="m15 18-6-6 6-6"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  /** Calendar — open a day picker. */
  calendar:
    '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  /** Double-ended arrow — the whole range. */
  allRange: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4"/><path d="m17 8 4 4-4 4"/>',
  /** Phone with an up arrow — export from your phone. */
  phone:
    '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M12 7v6M9.5 9 12 6.5 14.5 9"/>',
  /** Circular arrow — refresh / pull again. */
  refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v5h-5"/>',
  /** Counter-clockwise arrow — reset to defaults. */
  undo: '<path d="M3 12a9 9 0 1 0 2.64-6.36"/><path d="M3 3v6h6"/>',
  /** Wind — three gusts. */
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 13h15a3 3 0 1 1-3 3M3 18h8a2.5 2.5 0 1 1 2.5 2.5"/>',
  /** Tag. */
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3" fill="currentColor" stroke="none"/>',
  /** Pencil — rename. */
  pencil: '<path d="M4 20h4l10.5-10.5a2.8 2.8 0 0 0-4-4L4 16v4Z"/><path d="m13 7 4 4"/>',
  /** Map pin — a place. */
  pin: '<path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2.2"/>',
  /** Push pin — freeze / keep. */
  tack: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/>',
  /** Push pin crossed — release. */
  tackOff: '<path d="M9 3h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 14v7"/><path d="M4 4l16 16"/>',
  /** Magnifier — search / change location. */
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  /** Folded map. */
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2z"/><path d="M9 4v14M15 6v14"/>',
  /** Play — run / start. */
  play: '<path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none"/>',
  /** Stop square. */
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  /** Arrow into a door — sign in / connect. */
  login:
    '<path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/><path d="M3 12h11"/><path d="m10 8 4 4-4 4"/>',
  /** Arrow out of a door — disconnect. */
  logout:
    '<path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/><path d="M21 12H10"/><path d="m17 8 4 4-4 4"/>',
  /** Open folder — choose files. */
  folder:
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v1H3z"/><path d="M3 10h18l-1.5 9a2 2 0 0 1-2 1.7H6.5a2 2 0 0 1-2-1.7z"/>',
  /** Warning triangle — destructive, irreversible. */
  alert:
    '<path d="M12 3 2 20h20z"/><path d="M12 9v5"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  /** Question mark in a circle — explain. */
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.5"/><circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none"/>',
  /** Ruler — distance. */
  ruler: '<path d="M3 15.5 15.5 3 21 8.5 8.5 21z"/><path d="m7 12 2 2M10 9l2 2M13 6l2 2"/>',
  /** Gauge — speed. */
  gauge: '<path d="M5 18a8 8 0 1 1 14 0"/><path d="M12 14l4-4"/>',
  /** Band — a min–max envelope with its median. */
  band: '<path d="M3 15c3-5 6-5 9 0s6 5 9 0"/><path d="M3 9c3-5 6-5 9 0s6 5 9 0" opacity=".45"/><path d="M3 12c3-5 6-5 9 0s6 5 9 0" opacity=".45"/>',
  /** Lines — every model's own track. */
  lines: '<path d="M3 17 8 9l4 5 4-7 5 6"/><path d="M3 12 8 6l4 4 4-5 5 5" opacity=".5"/>',
  /** Moon — dark theme. */
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  /** Sun — light theme. */
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  /** Monitor — follow the system. */
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  /** Two opposing arrows — trade sides. */
  swap: '<path d="M4 7h13"/><path d="m14 4 3 3-3 3"/><path d="M20 17H7"/><path d="m10 14-3 3 3 3"/>',
  /** Six dots — a drag handle (reorder). */
  grip: '<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
  /** Star — pin a favourite. */
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9z"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** The `<svg class="bi">` markup for a glyph (extra classes via `cls`). */
export function icon(name: IconName, cls = ""): string {
  return (
    `<svg class="bi${cls ? ` ${cls}` : ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ` +
    `focusable="false">${PATHS[name]}</svg>`
  );
}

/** Inject the glyph into every `[data-icon]` element under `root` that lacks one. */
export function decorateIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = el.dataset.icon as IconName | undefined;
    if (!name || !(name in PATHS) || el.querySelector(":scope > .bi")) continue;
    el.insertAdjacentHTML("afterbegin", icon(name));
  }
}
