/**
 * GPX Toolkit — idle-time slicing.
 *
 * The one rule for anything that touches thousands of rides on the main thread:
 * never do it in one go. `runInSlices` works through a list in ~12ms slices on
 * `requestIdleCallback` (setTimeout where unavailable), so input, scrolling and
 * animations keep their frames; the caller shows a loader meanwhile and finishes
 * in `onDone`. A fresh call for the same job cancels the previous one via the
 * returned function.
 */

const schedule = (fn: () => void): void => {
  if (typeof requestIdleCallback === "function") requestIdleCallback(fn, { timeout: 250 });
  else setTimeout(fn, 16);
};

export function runInSlices<T>(
  items: readonly T[],
  work: (item: T) => void,
  opts: { budgetMs?: number; onDone?: () => void } = {},
): () => void {
  const budget = opts.budgetMs ?? 12;
  let i = 0;
  let cancelled = false;
  const step = (): void => {
    if (cancelled) return;
    const t0 = performance.now();
    while (i < items.length && performance.now() - t0 < budget) work(items[i++]);
    if (i < items.length) schedule(step);
    else opts.onDone?.();
  };
  if (items.length) schedule(step);
  else opts.onDone?.();
  return () => {
    cancelled = true;
  };
}

/** Split a list into consecutive chunks of `size` (the last may be shorter). */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
