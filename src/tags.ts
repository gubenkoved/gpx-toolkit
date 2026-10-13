/**
 * Ride tags: free-form, user-assigned labels on rides. The ONE canonical home for
 * tag normalization + comparison, so the Store, the filter predicate and the UI all
 * agree on what two tags being "the same" means (one implementation, no drift).
 *
 * Tags are case-INSENSITIVE: `tagKey` is the lowercase comparison key used for
 * dedup, membership and filtering, while the original `normalizeTag` display casing
 * (first one seen) is what gets stored and shown. So "Commute", "commute" and
 * " COMMUTE " are one tag, displayed however it was first typed.
 */

/** A `RideView`/`RideRecord` carries its tags as a plain string list. */
export interface HasTags {
  tags: string[];
}

/** Trim + collapse internal whitespace; the display form that gets stored. */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Lowercase comparison key — two tags are "the same" iff their keys match. */
export function tagKey(raw: string): string {
  return normalizeTag(raw).toLowerCase();
}

/**
 * The catalog of distinct tags across a set of rides: one entry per comparison
 * key (keeping the first-seen display casing), sorted alphabetically by key. Drives
 * the filter popover and the assign-modal's existing-tag chips.
 */
export function collectTags(rides: readonly HasTags[]): string[] {
  const byKey = new Map<string, string>();
  for (const r of rides) {
    for (const t of r.tags) {
      const key = tagKey(t);
      if (!key) continue;
      if (!byKey.has(key)) byKey.set(key, normalizeTag(t));
    }
  }
  return [...byKey.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, disp]) => disp);
}

/** Add a tag to a list, deduped by key (keeps existing casing if already present). */
export function addTag(list: readonly string[], tag: string): string[] {
  const disp = normalizeTag(tag);
  if (!disp) return [...list];
  const key = tagKey(disp);
  if (list.some((t) => tagKey(t) === key)) return [...list];
  return [...list, disp];
}

/** Remove a tag from a list by key (case-insensitive). */
export function removeTag(list: readonly string[], tag: string): string[] {
  const key = tagKey(tag);
  return list.filter((t) => tagKey(t) !== key);
}

/** True when the list contains a tag matching `tag` by key (case-insensitive). */
export function hasTag(list: readonly string[], tag: string): boolean {
  const key = tagKey(tag);
  return list.some((t) => tagKey(t) === key);
}

/** The tag colour palette (names → `--tag-<name>` tokens, tuned per theme). */
export const TAG_COLOR_NAMES: readonly string[] = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
  "slate",
];

/** A stored tag colour as a CSS colour (a palette token or the hex itself); null
 *  for none. */
export function tagColorCss(color: string | undefined | null): string | null {
  if (!color) return null;
  if (TAG_COLOR_NAMES.includes(color)) return `var(--tag-${color})`;
  return /^#[0-9a-f]{6}$/i.test(color) ? color : null;
}

/** ` style="--tc:…"` for a tagged element when its tag has a colour, else "" — the
 *  stylesheet tints any `[style*="--tc"]` tag pill / dot from it. */
export function tagColorStyle(colors: Readonly<Record<string, string>>, tag: string): string {
  const css = tagColorCss(colors[tagKey(tag)]);
  return css ? ` style="--tc:${css}"` : "";
}
