/**
 * GPX Toolkit — sliding segmented controls.
 *
 * Every `.seg` in the app marks its choice with `button.active`. This module gives
 * each one a thumb — a raised pill that *slides* to the active button instead of the
 * highlight jumping — without touching any of the code that toggles `.active`:
 *
 *  - a MutationObserver watches class changes on `.seg > button` (and segs being
 *    (re)built) and moves the thumb;
 *  - a ResizeObserver re-measures when a seg's size changes (labels folding to icons,
 *    a hidden seg becoming visible, a window resize).
 *
 * The thumb is positioned by transform (compositor-only) relative to its seg — so a
 * seg must be a positioned box; one a stylesheet left `static` is made `relative`,
 * else the thumb would be placed in some ancestor's frame and stay behind when the
 * seg moves. It is first placed without animation, and hidden when no button is
 * active. Styling lives in style.css
 * (`.seg-thumb`); `prefers-reduced-motion` turns the slide off.
 */

const known = new WeakSet<HTMLElement>();
let resizer: ResizeObserver | null = null;

function place(seg: HTMLElement, animate: boolean): void {
  const active = seg.querySelector<HTMLElement>(":scope > button.active");
  let thumb = seg.querySelector<HTMLElement>(":scope > .seg-thumb");
  if (!active || active.offsetWidth === 0) {
    thumb?.classList.add("off");
    return;
  }
  // The thumb's frame must be the seg (see the module note); a media query can flip
  // a seg's position later, so this is checked on every placement, not once.
  if (getComputedStyle(seg).position === "static") seg.style.position = "relative";
  let fresh = false;
  if (!thumb) {
    thumb = document.createElement("i");
    thumb.className = "seg-thumb no-anim";
    thumb.setAttribute("aria-hidden", "true");
    seg.prepend(thumb);
    fresh = true;
  }
  const wasOff = thumb.classList.contains("off");
  thumb.classList.toggle("no-anim", !animate || fresh || wasOff);
  thumb.classList.remove("off");
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.height = `${active.offsetHeight}px`;
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (thumb.classList.contains("no-anim")) {
    // Commit the no-animation placement, then allow the next move to slide.
    void thumb.offsetWidth;
    thumb.classList.remove("no-anim");
  }
}

function adopt(seg: HTMLElement): void {
  if (known.has(seg)) return;
  known.add(seg);
  resizer?.observe(seg);
  place(seg, false);
}

function adoptWithin(root: ParentNode): void {
  if (root instanceof HTMLElement && root.classList.contains("seg")) adopt(root);
  for (const seg of root.querySelectorAll<HTMLElement>(".seg")) adopt(seg);
}

/** Wire every segmented control, now and as they appear. Idempotent. */
export function initSegSliding(): void {
  if (typeof MutationObserver !== "function") return;
  resizer =
    typeof ResizeObserver === "function"
      ? new ResizeObserver((entries) => {
          for (const e of entries) place(e.target as HTMLElement, false);
        })
      : null;
  adoptWithin(document);
  new MutationObserver((records) => {
    for (const r of records) {
      const t = r.target as HTMLElement;
      if (r.type === "attributes") {
        const seg = t.parentElement;
        if (t.tagName === "BUTTON" && seg?.classList.contains("seg")) {
          adopt(seg);
          place(seg, true);
        }
        continue;
      }
      // Segs built or rebuilt via innerHTML: adopt new ones, re-place the parent.
      for (const n of r.addedNodes) if (n instanceof HTMLElement) adoptWithin(n);
      if (t.classList?.contains("seg")) {
        adopt(t);
        place(t, false);
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class"],
  });
}
