/**
 * GPX Toolkit — labels fold before rows wrap.
 *
 * A toolbar that runs out of room should first trade words for icons (and drop its
 * least important text) and only then break onto a second line: a wrapped row costs a
 * whole line of height for a few missing pixels. `autoFold` measures the real layout —
 * no guessed breakpoints, so fonts, locales and live text ("Updated 5m ago", a picked
 * date) are all accounted for — and sets the smallest fold level that keeps the
 * toolbar on one line.
 *
 * Levels are cumulative classes on the toolbar (`fold-1`, `fold-2`, …); the stylesheet
 * says what each level folds, mildest first. A level is used only if it actually
 * avoids the wrap: when even the last one can't (a phone layout that stacks by
 * design), the toolbar keeps its full labels rather than losing them for nothing.
 */

const observed = new WeakMap<HTMLElement, { levels: number; width: number }>();
let ro: ResizeObserver | null = null;

/** True when every laid-out child sits on one line and nothing overflows sideways. */
function fitsOneLine(el: HTMLElement): boolean {
  if (el.scrollWidth > el.clientWidth + 1) return false;
  const boxes: DOMRect[] = [];
  for (const child of el.children) {
    const c = child as HTMLElement;
    if (!c.getClientRects().length) continue;
    const pos = getComputedStyle(c).position;
    if (pos === "absolute" || pos === "fixed") continue;
    boxes.push(c.getBoundingClientRect());
  }
  // Wrapped: some child starts at or below another's bottom edge.
  return !boxes.some((a) => boxes.some((b) => a.top >= b.bottom - 1));
}

function setLevel(el: HTMLElement, level: number, levels: number): void {
  for (let i = 1; i <= levels; i++) el.classList.toggle(`fold-${i}`, i <= level);
}

/** Pick the mildest level that keeps `el` on one line (0 when none does). */
export function refold(el: HTMLElement): void {
  const entry = observed.get(el);
  if (!entry || !el.isConnected || !el.getClientRects().length) return;
  const { levels } = entry;
  // Measure each level at its final size: buttons animate every property (a 0.12s
  // `transition`), so mid-fold they still had their old font-size / gap and every
  // level looked useless. Transitions are suspended inline while we measure (inline
  // wins over any component rule), then each element gets its own value back.
  const nodes = [el, ...el.querySelectorAll<HTMLElement>("*")];
  const saved = nodes.map((n) => n.style.transition);
  for (const n of nodes) n.style.transition = "none";
  try {
    for (let level = 0; level <= levels; level++) {
      setLevel(el, level, levels);
      if (fitsOneLine(el)) return;
    }
    setLevel(el, 0, levels);
  } finally {
    nodes.forEach((n, i) => {
      n.style.transition = saved[i];
    });
  }
}

/**
 * Keep `el` folded to fit, re-measuring when its width changes (window, sidebar,
 * splitter). Content changes that alter its width-need call `refold(el)`.
 */
export function autoFold(el: HTMLElement | null, levels: number): void {
  if (!el) return;
  observed.set(el, { levels, width: -1 });
  if (typeof ResizeObserver === "function") {
    ro ??= new ResizeObserver((entries) => {
      for (const e of entries) {
        const t = e.target as HTMLElement;
        const entry = observed.get(t);
        if (!entry) continue;
        // Folding changes the height, not the width: only a width change re-folds,
        // so a fold can never feed back into another resize.
        const w = Math.round(e.contentRect.width);
        if (w === entry.width) continue;
        entry.width = w;
        refold(t);
      }
    });
    ro.observe(el);
  }
  refold(el);
}
