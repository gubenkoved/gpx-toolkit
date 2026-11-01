/**
 * GPX Toolkit — sliding segmented controls.
 *
 * Every `.seg` in the app marks its choice with `button.active`. This module gives
 * each one a thumb — a flat fill that *slides* to the active button instead of the
 * highlight jumping — without touching any of the code that toggles `.active`:
 *
 *  - a MutationObserver batches class changes on `.seg > button` (and segs being
 *    (re)built); only a different selected button may animate;
 *  - a ResizeObserver re-measures the seg AND its buttons (labels folding to icons,
 *    a hidden seg becoming visible, a window resize). Geometry changes snap.
 *
 * The thumb is positioned by transform (compositor-only) relative to its seg — so a
 * seg must be a positioned box; one a stylesheet left `static` is made `relative`,
 * else the thumb would be placed in some ancestor's frame and stay behind when the
 * seg moves. It is first placed without animation, and hidden when no button is
 * active. Styling lives in style.css
 * (`.seg-thumb`); `prefers-reduced-motion` turns the slide off.
 */

const known = new WeakSet<HTMLElement>();
const selected = new WeakMap<HTMLElement, HTMLElement | null>();
let resizer: ResizeObserver | null = null;
let initialized = false;

function place(seg: HTMLElement, animate: boolean): void {
  const active = seg.querySelector<HTMLElement>(":scope > button.active");
  const previous = selected.get(seg);
  let thumb = seg.querySelector<HTMLElement>(":scope > .seg-thumb");
  if (!active || active.offsetWidth === 0) {
    selected.set(seg, null);
    thumb?.classList.add("off");
    return;
  }
  // The thumb's frame must be the seg (see the module note); a media query can flip
  // a seg's position later, so this is checked on every placement, not once.
  if (getComputedStyle(seg).position === "static") seg.style.position = "relative";
  const fresh = !thumb;
  if (!thumb) {
    thumb = document.createElement("i");
    thumb.className = "seg-thumb no-anim";
    thumb.setAttribute("aria-hidden", "true");
    seg.prepend(thumb);
  }
  const wasOff = thumb.classList.contains("off");
  const width = `${active.offsetWidth}px`;
  const height = `${active.offsetHeight}px`;
  const transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  selected.set(seg, active);
  // Repeated .active writes, unrelated classes and our own observer callbacks must
  // neither restart nor cancel a slide already heading to the same destination.
  if (
    !fresh &&
    !wasOff &&
    thumb.style.width === width &&
    thumb.style.height === height &&
    thumb.style.transform === transform
  )
    return;
  thumb.classList.toggle(
    "no-anim",
    !animate || !previous || previous === active || fresh || wasOff,
  );
  thumb.classList.remove("off");
  thumb.style.width = width;
  thumb.style.height = height;
  thumb.style.transform = transform;
  // Keep no-anim until an actual selection change. A later layout pass must not
  // turn a resize or reappearance into motion.
}

function observeButtons(seg: HTMLElement): void {
  for (const button of seg.querySelectorAll<HTMLElement>(":scope > button"))
    resizer?.observe(button);
}

function adopt(seg: HTMLElement): void {
  if (known.has(seg)) return;
  known.add(seg);
  resizer?.observe(seg);
  observeButtons(seg);
  place(seg, false);
}

function adoptWithin(root: ParentNode): void {
  if (root instanceof HTMLElement && root.classList.contains("seg")) adopt(root);
  for (const seg of root.querySelectorAll<HTMLElement>(".seg")) adopt(seg);
}

/** Wire every segmented control, now and as they appear. Idempotent. */
export function initSegSliding(): void {
  if (initialized || typeof MutationObserver !== "function") return;
  initialized = true;
  resizer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          const segs = new Set<HTMLElement>();
          for (const e of entries) {
            const target = e.target as HTMLElement;
            const seg = target.classList.contains("seg") ? target : target.parentElement;
            if (seg?.classList.contains("seg")) segs.add(seg);
          }
          for (const seg of segs) place(seg, false);
        })
      : null;
  adoptWithin(document);
  new MutationObserver((records) => {
    const dirty = new Map<HTMLElement, boolean>();
    for (const r of records) {
      const t = r.target as HTMLElement;
      if (r.type === "attributes") {
        const seg = t.parentElement;
        if (t.tagName === "BUTTON" && seg?.classList.contains("seg")) {
          adopt(seg);
          if (!dirty.has(seg)) dirty.set(seg, true);
        }
        continue;
      }
      // Segs built or rebuilt via innerHTML: adopt new ones, re-place the parent.
      for (const n of r.addedNodes) if (n instanceof HTMLElement) adoptWithin(n);
      // Rebuilt controls must release old ResizeObserver targets.
      for (const n of r.removedNodes) {
        if (!(n instanceof HTMLElement) || n.isConnected) continue;
        resizer?.unobserve(n);
        known.delete(n);
        for (const el of n.querySelectorAll<HTMLElement>(".seg, .seg > button")) {
          resizer?.unobserve(el);
          known.delete(el);
        }
      }
      if (t.classList?.contains("seg")) {
        adopt(t);
        observeButtons(t);
        dirty.set(t, false);
      }
    }
    for (const [seg, animate] of dirty) if (seg.isConnected) place(seg, animate);
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });
}
