/**
 * High-level automation of the Beeline app: navigate, read status, upload.
 *
 * Port of `beeline_uploader.app` (Python). Coordinates that cannot be derived
 * from the UI dump (bottom-nav tabs, scroll gestures) are computed from the live
 * screen size so the logic is not hard-wired to one device. Every method is async
 * (the transport is async); blocking sleeps become awaited delays.
 */

import { realSleep, shellQuote, type AdbDevice, type Sleep } from "./adb/types";
import {
  boundsCx,
  boundsCy,
  findOptionsButton,
  findRiddenRouteRow,
  findSaveButton,
  findShareDownloadRow,
  hasActionButtons,
  isDownloadingGpx,
  isRideDetail,
  parseJourneysList,
  parseRideDetail,
  rideDatetime,
  rideShortLabel,
  type Bounds,
  type RideCard,
  type RideDetail,
  type StravaStatus,
} from "./parsing";

export const PACKAGE = "co.beeline";

/** Where Beeline writes exported GPX files on the device. */
export const DOWNLOAD_DIR = "/sdcard/Download";

/**
 * Directory names pruned from the `.gpx` scan: heavyweight trees that can hold
 * tens of thousands of files but never a user-saved GPX. Keeps detection fast.
 */
const GPX_SCAN_PRUNE = ["Android", "DCIM", ".thumbnails", "Pictures", "Movies", "Music"];

/**
 * A deterministic, collision-free GPX filename derived from a ride's (unique)
 * datetime key. Beeline names every export after its title/date, so two rides can
 * share a name and clobber each other on the device; deriving the name from the
 * unique key instead guarantees each ride maps to exactly one stable file.
 */
export function gpxFilename(key: string): string {
  const slug = key.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Beeline-${slug || "ride"}.gpx`;
}

/**
 * A human-friendly, sort-friendly name to offer in the browser's "Save As".
 * Unlike `gpxFilename` (device-stable, keyed on the raw datetime), this leads
 * with an ISO-ish `YYYY-MM-DD HH-MM` stamp so saved files sort chronologically,
 * then appends the ride's own title. Colons are rendered as `-` (illegal in
 * filenames), and any path separators / control chars in the title are stripped.
 * Falls back to a stamp-only name when the title is empty, and to the device
 * filename when the key can't be parsed into a date.
 */
export function gpxDownloadName(key: string, title: string): string {
  const dt = rideDatetime(key);
  if (dt === null) return gpxFilename(key);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${dt.getFullYear()}-${p2(dt.getMonth() + 1)}-${p2(dt.getDate())} ` +
    `${p2(dt.getHours())}-${p2(dt.getMinutes())}`;
  // Strip path separators and control chars; collapse runs of whitespace.
  const clean = title
    .replace(/[/\\<>:"|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? `${stamp} - ${clean}.gpx` : `${stamp}.gpx`;
}

/** A GPX file pulled off the device for one ride. */
export interface GpxFile {
  key: string;
  filename: string;
  /** Sort-friendly name for the browser download (see `gpxDownloadName`). */
  downloadName: string;
  bytes: Uint8Array;
}

/** Per-ride outcome of the native GPX export flow. */
export type GpxExport =
  | { ok: true; file: GpxFile }
  | { ok: false; reason: string };

// A callback the long-running passes call to report progress and check for cancel.
// It receives a short status message; returning true asks the operation to stop.
export type Progress = (msg: string) => boolean | Promise<boolean>;

const noop: Progress = () => false;

export interface Timing {
  open_card: number;
  reveal_swipe: number;
  close_detail: number;
  poll_interval: number;
  grace: number;
  scroll_settle: number;
  optimistic_upload: boolean;
  // Fast far-scrolling knobs (used only to reach targets far down the list).
  // `fling_ms` null keeps the normal controlled drag (safe/normal profiles); a
  // number switches the coarse phase to a short, fast momentum fling that coasts
  // several screens per gesture. `coarse_swipes_per_dump` chains that many blind
  // flings between the (expensive) uiautomator dumps while a target is still far
  // away. `fling_settle` is the settle delay after a fling — momentum needs a bit
  // longer to come to rest than a controlled drag.
  fling_ms: number | null;
  fling_settle: number;
  coarse_swipes_per_dump: number;
}

const BASE: Timing = {
  open_card: 1.0,
  reveal_swipe: 0.35,
  close_detail: 0.6,
  poll_interval: 1.5,
  grace: 4.0,
  scroll_settle: 0.5,
  optimistic_upload: false,
  fling_ms: null, // controlled drag — no momentum flinging by default
  fling_settle: 0.5,
  coarse_swipes_per_dump: 1,
};

export const PROFILES: Record<string, Timing> = {
  safe: {
    ...BASE,
    open_card: 1.4,
    reveal_swipe: 0.5,
    close_detail: 0.9,
    poll_interval: 2.0,
    grace: 5.0,
    scroll_settle: 0.7,
  },
  normal: { ...BASE },
  fast: {
    ...BASE,
    open_card: 0.6,
    reveal_swipe: 0.2,
    close_detail: 0.35,
    poll_interval: 1.0,
    grace: 2.0,
    scroll_settle: 0.3,
    fling_ms: 90, // momentum fling: coast several screens per gesture
    fling_settle: 0.5,
    coarse_swipes_per_dump: 3,
  },
  turbo: {
    ...BASE,
    open_card: 0.45,
    reveal_swipe: 0.15,
    close_detail: 0.25,
    poll_interval: 1.0,
    grace: 0.0,
    scroll_settle: 0.2,
    optimistic_upload: true,
    fling_ms: 70, // snappier fling, more coast
    fling_settle: 0.4,
    coarse_swipes_per_dump: 4,
  },
};

export const DEFAULT_PROFILE = "normal";

/** Screen-relative tap/scroll coordinates derived from screen size. */
export class Geometry {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  get journeysTab(): [number, number] {
    return [Math.trunc(this.width * 0.5), Math.trunc(this.height * 0.945)];
  }

  get cx(): number {
    return Math.trunc(this.width / 2);
  }

  listScrollDown(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.75), this.cx, Math.trunc(this.height * 0.3)];
  }

  listScrollUp(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.3), this.cx, Math.trunc(this.height * 0.85)];
  }

  // Momentum flings: a longer travel released quickly so the list keeps coasting
  // well past the gesture, covering several screens per swipe. Used (with a short
  // duration) for the coarse phase when a target is far down the list.
  listFlingDown(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.85), this.cx, Math.trunc(this.height * 0.12)];
  }

  listFlingUp(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.12), this.cx, Math.trunc(this.height * 0.88)];
  }

  detailScrollUp(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.8), this.cx, Math.trunc(this.height * 0.25)];
  }

  detailScrollDown(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.25), this.cx, Math.trunc(this.height * 0.8)];
  }
}

export class BeelineApp {
  geo!: Geometry;

  /** Resolved real path of `/sdcard` (cached after first lookup). */
  private gpxRoot: string | null = null;

  private constructor(
    readonly adb: AdbDevice,
    public timing: Timing,
    private readonly sleep: Sleep,
  ) {}

  /** Async factory: reads the screen size to derive geometry. */
  static async create(
    adb: AdbDevice,
    timing: Timing = PROFILES[DEFAULT_PROFILE],
    sleep: Sleep = realSleep,
  ): Promise<BeelineApp> {
    const app = new BeelineApp(adb, timing, sleep);
    const size = await adb.screenSize();
    app.geo = new Geometry(size.width, size.height);
    return app;
  }

  // -- navigation --------------------------------------------------------

  async ensureRunning(): Promise<void> {
    const focus = await this.adb.currentFocus();
    if (!focus.includes(PACKAGE)) {
      await this.adb.launch(PACKAGE);
      await this.sleep(2.0);
    }
  }

  /**
   * Make sure we're on the Journeys list — WITHOUT throwing away scroll position.
   * If a ride-detail sheet is open we press Back (which returns to the list exactly
   * where it was); only when we're on some other screen entirely do we tap the
   * Journeys tab (the one action that does jump back to the top — unavoidable from
   * elsewhere). This keeps repeated check/upload passes from re-scrolling each time.
   */
  async openJourneys(): Promise<void> {
    await this.ensureRunning();
    for (let i = 0; i < 6; i++) {
      const xml = await this.adb.uiDump();
      if (parseJourneysList(xml).length >= 2) return; // on the list, stay put
      if (isRideDetail(xml)) {
        // A detail sheet is open (its buttons may be below the fold) — Back
        // returns to the list at the same scroll position. Never tap the
        // Journeys tab here: the sheet covers the nav and would scroll/tap the
        // wrong window, which previously made checks report rides as missing.
        await this.adb.back();
        await this.sleep(this.timing.close_detail);
        continue;
      }
      // Some other screen/tab — the Journeys tab is the only way back (resets scroll).
      const [x, y] = this.geo.journeysTab;
      await this.adb.tap(x, y);
      await this.sleep(1.0);
    }
    await this.sleep(0.5);
  }

  async scrollListToTop(maxSwipes = 60): Promise<void> {
    let prev = "";
    for (let i = 0; i < maxSwipes; i++) {
      const xml = await this.adb.uiDump();
      if (xml === prev) break;
      prev = xml;
      const [x1, y1, x2, y2] = this.geo.listScrollUp();
      await this.adb.swipe(x1, y1, x2, y2, 250);
      await this.sleep(this.timing.scroll_settle);
    }
  }

  async listCards(): Promise<RideCard[]> {
    return parseJourneysList(await this.adb.uiDump());
  }

  /**
   * Move the Journeys list one step in the chosen direction. `fling` selects a
   * fast momentum fling (large travel, short duration, longer settle) over the
   * normal controlled drag; the fling path is only taken when the active profile
   * enables it (`timing.fling_ms` set). The controlled-drag branch reproduces the
   * original durations exactly, so safe/normal behaviour is unchanged.
   */
  private async moveList(goUp: boolean, fling: boolean): Promise<void> {
    if (fling && this.timing.fling_ms !== null) {
      const [x1, y1, x2, y2] = goUp ? this.geo.listFlingUp() : this.geo.listFlingDown();
      await this.adb.swipe(x1, y1, x2, y2, this.timing.fling_ms);
      await this.sleep(this.timing.fling_settle);
    } else {
      const [x1, y1, x2, y2] = goUp ? this.geo.listScrollUp() : this.geo.listScrollDown();
      await this.adb.swipe(x1, y1, x2, y2, goUp ? 250 : 300);
      await this.sleep(this.timing.scroll_settle);
    }
  }

  // -- ride detail -------------------------------------------------------

  async openCard(card: RideCard): Promise<void> {
    await this.adb.tap(this.geo.cx, card.tapY);
    await this.sleep(this.timing.open_card);
  }

  /**
   * Swipe the detail sheet up until the upload buttons are visible. The detail is
   * a bottom sheet, so the buttons are almost always off-screen right after
   * opening; we swipe up before the first dump to avoid a guaranteed-wasted dump.
   */
  async revealActions(maxSwipes = 4): Promise<string> {
    const [x1, y1, x2, y2] = this.geo.detailScrollUp();
    let xml = "";
    for (let i = 0; i < maxSwipes; i++) {
      await this.adb.swipe(x1, y1, x2, y2, 250);
      await this.sleep(this.timing.reveal_swipe);
      xml = await this.adb.uiDump();
      if (hasActionButtons(xml)) return xml;
    }
    return xml;
  }

  async readDetail(): Promise<RideDetail> {
    return parseRideDetail(await this.revealActions());
  }

  /**
   * Bring the top-right "Options" header back into view and return its bounds.
   * Reading the detail (revealActions) swipes the bottom sheet UP to expose the
   * Strava/komoot buttons, which pushes "Options" off the top of the screen — so
   * before the GPX export can tap it we swipe the sheet back DOWN until it shows
   * again. Returns null if it never reappears (caller surfaces the failure).
   */
  async revealOptions(maxSwipes = 5): Promise<Bounds | null> {
    const [x1, y1, x2, y2] = this.geo.detailScrollDown();
    for (let i = 0; i < maxSwipes; i++) {
      const found = findOptionsButton(await this.adb.uiDump());
      if (found) return found;
      await this.adb.swipe(x1, y1, x2, y2, 250);
      await this.sleep(this.timing.reveal_swipe);
    }
    return findOptionsButton(await this.adb.uiDump());
  }

  async closeDetail(): Promise<void> {
    await this.adb.back();
    await this.sleep(this.timing.close_detail);
  }

  // -- upload ------------------------------------------------------------

  /**
   * Tap the Strava button on the current ride detail and report status.
   * Returns 'uploaded', 'processing', 'pending', or 'unknown'.
   *
   * In `fast` mode we return as soon as the upload is confirmed to have started
   * (button leaves 'pending'); it completes on the phone in the background and a
   * later status check flips it to 'uploaded'. When the active profile sets
   * `optimistic_upload` we skip the polling dumps entirely: tap, wait one poll
   * interval, report 'processing'.
   */
  async uploadCurrentToStrava(
    progress: Progress = noop,
    timeout = 14.0,
    fast = true,
  ): Promise<StravaStatus> {
    const detail = await this.readDetail();
    if (detail.stravaStatus === "uploaded") return "uploaded";
    if (detail.stravaStatus !== "pending" || detail.stravaTap === null) {
      return detail.stravaStatus;
    }
    await progress("tapping the Strava button\u2026");
    await this.adb.tap(boundsCx(detail.stravaTap), boundsCy(detail.stravaTap));

    if (this.timing.optimistic_upload) {
      // Tap-and-go: assume it started; a later Check reconciles real status.
      await this.sleep(this.timing.poll_interval);
      return "processing";
    }

    let elapsed = 0.0;
    const grace = this.timing.grace;
    const interval = this.timing.poll_interval;
    let seenProcessingAt: number | null = null;
    while (elapsed < timeout) {
      await this.sleep(interval);
      elapsed += interval;
      if (await progress(`waiting for Strava to confirm\u2026 ${Math.round(elapsed)}s`)) break;
      const status = parseRideDetail(await this.adb.uiDump()).stravaStatus;
      if (status === "uploaded") return "uploaded";
      if (status === "processing") {
        if (seenProcessingAt === null) seenProcessingAt = elapsed;
        else if (fast && elapsed - seenProcessingAt >= grace) return "processing";
      }
    }
    return "processing";
  }

  // -- bulk passes -------------------------------------------------------

  /**
   * Scroll the Journeys list and collect ride cards (fast, no opens). Rides are
   * listed newest-first, so when `since` is given we stop scrolling as soon as we
   * reach a ride older than the cutoff, and return only rides at or after it.
   *
   * `onCards` is called with each page's newly-discovered cards so callers can
   * persist/display rides AS THEY ARE FOUND rather than waiting for the whole pass.
   * A hard page cap guards against any scroll jitter that never settles.
   */
  async enumerateCatalog(
    progress: Progress = noop,
    since: Date | null = null,
    onCards: (cards: RideCard[]) => void = () => {},
  ): Promise<RideCard[]> {
    const passesSince = (key: string): boolean => {
      if (since === null) return true;
      const dt = rideDatetime(key);
      return dt !== null && dt >= since;
    };

    if (await progress("opening Journeys…")) return [];
    await this.openJourneys();
    if (await progress("scrolling to your newest ride…")) return [];
    await this.scrollListToTop();
    const seen = new Map<string, RideCard>();
    let stale = 0;
    let reachedCutoff = false;
    let lastSig: string[] | null = null;
    const MAX_PAGES = 1000; // safety: never scroll forever
    for (let page = 0; page < MAX_PAGES; page++) {
      const cards = await this.listCards(); // one dump per page
      const fresh: RideCard[] = [];
      for (const card of cards) {
        if (!seen.has(card.key)) {
          seen.set(card.key, card);
          fresh.push(card);
        }
        if (since !== null) {
          const dt = rideDatetime(card.key);
          if (dt !== null && dt < since) reachedCutoff = true;
        }
      }
      const emit = fresh.filter((c) => passesSince(c.key));
      if (emit.length) onCards(emit); // hand rides to the caller as they appear
      if (await progress(`scrolling Journeys — ${seen.size} ride${seen.size === 1 ? "" : "s"} found`)) break;
      if (reachedCutoff) break;
      const sig = cards.map((c) => c.key);
      stale = fresh.length === 0 && lastSig !== null && sameKeys(sig, lastSig) ? stale + 1 : 0;
      if (stale >= 2) break; // list stopped changing => reached the end
      lastSig = sig;
      const [x1, y1, x2, y2] = this.geo.listScrollDown();
      await this.adb.swipe(x1, y1, x2, y2, 300);
      await this.sleep(this.timing.scroll_settle);
    }
    let cards = [...seen.values()];
    if (since !== null) cards = cards.filter((c) => passesSince(c.key));
    return cards;
  }

  /**
   * Position-aware sweep over `keys`: starting from wherever the Journeys list
   * currently sits (NO wasteful scroll-to-top), repeatedly bring each remaining
   * target on screen and hand it to `visit`. Direction is chosen from the list's
   * newest-first ordering — newer rides are up, older rides are down — and we
   * only move toward a side that could still hold a target, stopping once both
   * ends are exhausted so a removed/stale key can never cause an infinite loop.
   *
   * `visit(card, name, stop)` owns opening the card, doing the per-ride work, and
   * closing the detail; it returns true to abort the whole sweep (e.g. cancelled).
   * The shared `stop(msg)` reports progress and returns the cancel signal, marking
   * the sweep cancelled so unfound rides aren't wrongly treated as deleted.
   *
   * `onMissing` is called (only when the sweep ran to completion, not when it was
   * cancelled) with keys we searched the whole list for but never found — i.e.
   * rides that have been deleted on the phone since we last saw them.
   */
  private async sweepTargets(
    keys: Set<string>,
    progress: Progress,
    visit: (
      card: RideCard,
      name: string,
      stop: (msg: string) => Promise<boolean>,
    ) => Promise<boolean>,
    onMissing: (keys: string[]) => void = () => {},
  ): Promise<void> {
    let cancelled = false;
    // A progress call that returns the cancel signal; records it so we don't treat
    // an interrupted pass as proof that the unfound rides are gone.
    const stop = async (msg: string): Promise<boolean> => {
      if (await progress(msg)) {
        cancelled = true;
        return true;
      }
      return false;
    };

    if (await stop("checking we're on your rides…")) return;
    await this.openJourneys(); // dismisses any open detail without resetting scroll
    const remaining = new Set(keys);
    const missing = new Set<string>(); // requested but proven absent → deleted
    let cards = await this.listCards(); // start from the CURRENT position
    let exhaustedUp = false;
    let exhaustedDown = false;

    // Coarse→fine refinement level for the far-scroll phase (fast/turbo only):
    //   0 = chain several momentum flings between dumps (covers the most ground),
    //   1 = one fling per dump, 2 = precise controlled single-card drag per dump.
    // We start coarse and step finer each time a fling overshoots the target date,
    // so the approach is fast far away and exact up close. safe/normal can't fling
    // (fling_ms null), so they pin to level 2 — identical to the original behaviour.
    const canFling = this.timing.fling_ms !== null;
    const baseLevel = canFling ? 0 : 2;
    let level = baseLevel;
    // Consecutive "the list didn't move" results in the current direction. One
    // stall is treated as a transient miss (a fling that failed to register, or a
    // dump taken before the list settled) and is retried with a reliable drag; only
    // a SECOND, confirmed stall accepts that we've genuinely reached that end. This
    // is what stops a single missed swipe from ending the sweep and wandering off.
    let stalls = 0;

    // Name the rides we're still hunting for so status reads like a specific
    // intent ("Jun 13 14:22, Jun 12 09:10 (+3 more)") rather than a bare count.
    // We only know each target by its key, so show its short date/time label
    // (falling back to the raw key when it can't be parsed); cap at two names.
    const describeRemaining = (): string => {
      const labels = [...remaining].map((k) => rideShortLabel(k) || k);
      const shown = labels.slice(0, 2).join(", ");
      const extra = labels.length - 2;
      return extra > 0 ? `${shown} (+${extra} more)` : shown;
    };

    while (remaining.size) {
      const target = cards.find((c) => remaining.has(c.key)) ?? null;
      if (target) {
        // Include the date when we have a title, so same-named rides are
        // distinguishable; untitled rides already show the date via the key.
        const dateLabel = rideShortLabel(target.key);
        const name =
          target.title && dateLabel ? `${target.title} (${dateLabel})` : target.title || target.key;
        if (await visit(target, name, stop)) break; // aborted (e.g. cancelled)
        remaining.delete(target.key);
        exhaustedUp = exhaustedDown = false; // position moved; both ends open again
        level = baseLevel; // a new target may be far again — start coarse
        stalls = 0; // fresh approach — forget any stall from the last target
        cards = await this.listCards();
        continue;
      }

      if (cards.length === 0) break; // nothing on screen to navigate by

      // No target visible. The list is sorted newest→oldest and is contiguous, so
      // any *existing* ride whose date is within the visible page's span would be
      // on screen. A remaining key that is bracketed by the page (>= oldest and
      // <= newest) but absent has therefore been deleted on the phone — prune it.
      // This also breaks the oscillation that would otherwise occur when a target's
      // date sits between two pages we keep hopping across.
      const newestVisible = rideDatetime(cards[0].key);
      const oldestVisible = rideDatetime(cards[cards.length - 1].key);
      if (newestVisible !== null && oldestVisible !== null) {
        for (const key of [...remaining]) {
          const d = rideDatetime(key);
          if (d !== null && d <= newestVisible && d >= oldestVisible) {
            remaining.delete(key); // bracketed but not present → gone
            missing.add(key);
          }
        }
        if (remaining.size === 0) break;
      }

      // Direction is decided by the list's newest→oldest ordering and the dates of
      // the rides we still want — and it is AUTHORITATIVE: a target newer than
      // everything on screen is strictly ABOVE us, so we go up and never down (and
      // vice-versa). We only fall back to a blind both-ends sweep when a remaining
      // key has no parseable date to reason about. Crucially, when a target lies past
      // an end we've already CONFIRMED we cannot scroll toward, the ride is gone — we
      // stop instead of reversing into the opposite direction (the old bug that made
      // one missed up-swipe send us scrolling down forever).
      const remDates = [...remaining]
        .map(rideDatetime)
        .filter((d): d is Date => d !== null);
      const hasUndated = [...remaining].some((k) => rideDatetime(k) === null);
      const needUp = remDates.some((d) => newestVisible !== null && d > newestVisible);
      const needDown = remDates.some((d) => oldestVisible !== null && d < oldestVisible);

      let goUp: boolean;
      if (needUp && !exhaustedUp) goUp = true; // target is above and we can still go up
      else if (needDown && !exhaustedDown) goUp = false; // …or below and we can go down
      else if (hasUndated && !exhaustedDown) goUp = false; // no date — sweep down first…
      else if (hasUndated && !exhaustedUp) goUp = true; // …then up…
      else break; // every remaining ride is past a confirmed end → they're gone

      // The closest remaining target on the side we're heading toward — its date
      // lets us tell when a fling has coasted PAST it (overshoot) so we can refine.
      // When no dated target sits on that side we can't aim, so step precisely
      // (level 2) to be sure a blind fling never skips the page it's actually on.
      let aim: Date | null = null;
      if (goUp && newestVisible !== null) {
        const above = remDates.filter((d) => d > newestVisible).map((d) => d.getTime());
        if (above.length) aim = new Date(Math.min(...above));
      } else if (!goUp && oldestVisible !== null) {
        const below = remDates.filter((d) => d < oldestVisible).map((d) => d.getTime());
        if (below.length) aim = new Date(Math.max(...below));
      }
      const stepLevel = aim === null ? 2 : level;
      // Resilient gesture choice: only risk a fast momentum fling when we have a date
      // to aim at AND the list actually moved last time. After ANY stall we drop to a
      // slow, reliable controlled drag — a fling that merely failed to register must
      // never be mistaken for the end of the list.
      const fling = canFling && aim !== null && stepLevel <= 1 && stalls === 0;
      const stride = fling && stepLevel === 0 ? this.timing.coarse_swipes_per_dump : 1;

      const verb = fling ? "fast-scrolling" : "scrolling";
      if (await stop(`${verb} ${goUp ? "up" : "down"} to find ${describeRemaining()}…`)) break;
      const before = cards.map((c) => c.key);
      for (let s = 0; s < stride; s++) await this.moveList(goUp, fling); // blind between dumps
      cards = await this.listCards();
      if (sameKeys(before, cards.map((c) => c.key))) {
        // The list didn't budge — usually just a missed fling. Retry with a reliable
        // drag next time; only after a second, confirmed stall do we accept this end.
        stalls += 1;
        if (stalls >= 2) {
          if (goUp) exhaustedUp = true;
          else exhaustedDown = true;
          stalls = 0;
        }
      } else {
        stalls = 0; // we moved — this end is clearly not reached
        // Did a fast move coast past the target's date? Refine one level so the next
        // approach is gentler; the final level is an exact single-card drag that
        // cannot overshoot, guaranteeing convergence.
        if (aim !== null && cards.length) {
          const nv = rideDatetime(cards[0].key);
          const ov = rideDatetime(cards[cards.length - 1].key);
          const overshot =
            (goUp && ov !== null && aim < ov) || // scrolled up past it (now below the window)
            (!goUp && nv !== null && aim > nv); // scrolled down past it (now above the window)
          if (overshot && level < 2) level += 1;
        }
      }
    }

    if (!cancelled) {
      for (const key of remaining) missing.add(key); // swept everything → also gone
      if (missing.size) {
        await progress(`${missing.size} ride${missing.size === 1 ? "" : "s"} no longer on the phone — marked deleted`);
        onMissing([...missing]);
      }
    }
  }

  /**
   * Open each ride whose key is in `keys`, read its detail (and upload to Strava if
   * `doUpload` and it is pending). `onDetail` fires after each ride so callers can
   * persist status AS IT IS KNOWN. Navigation is position-aware via `sweepTargets`
   * (no scroll-to-top); `onMissing` reports keys no longer on the phone.
   */
  async processTargets(
    keys: Set<string>,
    doUpload: boolean,
    progress: Progress = noop,
    onDetail: (detail: RideDetail) => void = () => {},
    onMissing: (keys: string[]) => void = () => {},
  ): Promise<RideDetail[]> {
    const results: RideDetail[] = [];
    await this.sweepTargets(
      keys,
      progress,
      async (target, name, stop) => {
        if (await stop(`opening ride: ${name}`)) return true;
        await this.openCard(target);
        if (await stop(`reading ride: ${name}`)) {
          await this.closeDetail();
          return true;
        }
        const detail = await this.readDetail();
        if (!detail.key) detail.key = target.key;
        detail.title = detail.title || target.title;
        if (doUpload && detail.stravaStatus === "pending") {
          if (await stop(`uploading to Strava: ${name}`)) {
            await this.closeDetail();
            return true;
          }
          detail.stravaStatus = await this.uploadCurrentToStrava(progress);
        } else {
          await progress(`checked: ${name} — ${detail.stravaStatus}`);
        }
        await this.closeDetail(); // Back returns to the list at the same position
        results.push(detail);
        onDetail(detail); // persist this ride's status immediately
        return false;
      },
      onMissing,
    );
    return results;
  }

  // -- GPX export --------------------------------------------------------

  /**
   * Open each ride in `keys`, drive Beeline's native "Options → Share/download →
   * download GPX" flow, and pull the resulting file off the device. `onGpx` fires
   * per ride so callers can persist/download each file as it arrives; `onFail`
   * reports rides that were found but whose export failed (with the failing step);
   * `onMissing` reports keys that are no longer on the phone. `onDetail` fires per
   * ride with the detail read while its card is open, so a download records the
   * ride's title/stats/Strava status even if it was never opened via a Check.
   * Navigation is
   * position-aware via `sweepTargets`, so a download never bounces the list back
   * to the top — it starts from wherever we already are and scrolls only toward
   * each target.
   */
  async downloadGpx(
    keys: Set<string>,
    progress: Progress = noop,
    onGpx: (file: GpxFile) => void = () => {},
    onMissing: (keys: string[]) => void = () => {},
    onFail: (key: string, reason: string) => void = () => {},
    onDetail: (detail: RideDetail) => void = () => {},
  ): Promise<GpxFile[]> {
    const results: GpxFile[] = [];
    await this.sweepTargets(
      keys,
      progress,
      async (target, name, stop) => {
        if (await stop(`opening ride: ${name}`)) return true;
        await this.openCard(target);
        // Read the ride's detail while the card is open so a GPX download on a
        // ride we never explicitly opened still records its title/stats/Strava
        // status — exactly like a Check would.
        const detail = await this.readDetail();
        if (!detail.key) detail.key = target.key;
        detail.title = detail.title || target.title;
        onDetail(detail);
        const outcome = await this.exportCurrentGpx(target.key, detail.title, progress);
        await this.closeDetail();
        if (outcome.ok) {
          results.push(outcome.file);
          onGpx(outcome.file);
        } else {
          onFail(target.key, outcome.reason);
        }
        return false;
      },
      onMissing,
    );
    return results;
  }

  /**
   * The real shared-storage root, with the `/sdcard` symlink resolved once and
   * cached. On Android `/sdcard` → `/storage/emulated/0`; resolving it up front
   * means `find` never has to descend a symlinked start path (which it won't do),
   * so file detection is robust regardless of how the device wires up storage.
   * Falls back to `/sdcard` if `readlink` is unavailable.
   */
  private async storageRoot(): Promise<string> {
    if (this.gpxRoot) return this.gpxRoot;
    let root = "";
    try {
      root = (await this.adb.shell(`readlink -f /sdcard 2>/dev/null`)).trim();
    } catch {
      root = "";
    }
    this.gpxRoot = root || "/sdcard";
    return this.gpxRoot;
  }

  /**
   * Every exported-GPX file under shared storage, as absolute paths. Recursive
   * and name/folder-agnostic on purpose: the SAF "Save" dialog reopens at the
   * user's last-used location and names the export however it likes, so we never
   * match on a folder or exact filename — we diff this set across the export.
   *
   * Crucially we match both `*.gpx` AND `*.gpx (N)`: when a file already exists,
   * Android SAF de-duplicates by appending " (1)", " (2)", … AFTER the extension,
   * so a fresh export is often named "ride.gpx (3)" — which a plain `*.gpx` glob
   * would miss entirely (the exact bug that left exports undetected).
   *
   * Bounded for speed: we prune the heavyweight trees that can hold tens of
   * thousands of files but never a user-saved GPX (`Android/` app sandboxes,
   * `DCIM/` photos, thumbnail caches), and cap depth. `-L` is belt-and-suspenders
   * in case the resolved root is still a symlink on some device.
   */
  private async listGpxFiles(root: string): Promise<Set<string>> {
    const prune = GPX_SCAN_PRUNE.map((d) => `-name ${shellQuote(d)}`).join(" -o ");
    const out = await this.adb.shell(
      `find -L ${shellQuote(root)} -maxdepth 4 ` +
        `\\( ${prune} \\) -prune -o -type f \\( -iname '*.gpx' -o -iname '*.gpx (*)' \\) ` +
        `-print 2>/dev/null`,
    );
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  /** Pick the most-recently-modified path (falls back to the last one listed). */
  private async newestGpx(paths: string[]): Promise<string> {
    if (paths.length === 1) return paths[0];
    const out = await this.adb.shell(`stat -c '%Y %n' ${paths.map(shellQuote).join(" ")} 2>/dev/null`);
    let best = paths[paths.length - 1];
    let bestMtime = -1;
    for (const line of out.split("\n")) {
      const m = /^(\d+)\s+(.*\S)\s*$/.exec(line);
      if (!m) continue;
      const mtime = Number(m[1]);
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        best = m[2];
      }
    }
    return best;
  }

  private async tapBounds(b: Bounds): Promise<void> {
    await this.adb.tap(boundsCx(b), boundsCy(b));
  }

  /** Poll the UI up to `tries` times until `find` returns a target. */
  private async pollFor(find: (xml: string) => Bounds | null, tries = 8): Promise<Bounds | null> {
    for (let i = 0; i < tries; i++) {
      const target = find(await this.adb.uiDump());
      if (target) return target;
      await this.sleep(this.timing.poll_interval);
    }
    return null;
  }

  /**
   * From an open ride detail, run the GPX export flow and return the pulled file.
   * On failure returns `{ ok: false, reason }` naming the step that didn't appear
   * (the same message is also reported via `progress`), so callers can surface it.
   */
  private async exportCurrentGpx(
    key: string,
    title: string,
    progress: Progress,
  ): Promise<GpxExport> {
    const root = await this.storageRoot();
    const downloadDir = `${root}/Download`;
    const before = await this.listGpxFiles(root);

    const options = await this.revealOptions();
    if (!options) {
      const reason = `could not find Options for ${key} (scrolled the detail to look for it)`;
      await progress(reason);
      return { ok: false, reason };
    }
    await this.tapBounds(options);

    const shareRow = await this.pollFor(findShareDownloadRow, 6);
    if (!shareRow) {
      const reason = `no Share/download option for ${key}`;
      await progress(reason);
      return { ok: false, reason };
    }
    await this.tapBounds(shareRow);

    const riddenRoute = await this.pollFor(findRiddenRouteRow, 6);
    if (!riddenRoute) {
      const reason = `no "ridden route" export for ${key}`;
      await progress(reason);
      return { ok: false, reason };
    }
    if (await progress(`exporting GPX: ${key}`)) return { ok: false, reason: `cancelled before exporting ${key}` };
    await this.tapBounds(riddenRoute);

    // Wait out the "Downloading GPX route" progress, then tap Save in the system dialog.
    const save = await this.pollFor(
      (xml) => (isDownloadingGpx(xml) ? null : findSaveButton(xml)),
      20,
    );
    if (!save) {
      const reason = `GPX export did not complete for ${key}`;
      await progress(reason);
      return { ok: false, reason };
    }
    await this.tapBounds(save);

    // Find the freshly-written GPX. Beeline's SAF "Save" dialog reopens at the
    // user's last-used folder and names the file however it likes, so we diff the
    // whole-tree .gpx set and take whatever is new (newest by mtime if several).
    let newPath: string | null = null;
    let inventory = before;
    for (let i = 0; i < 20; i++) {
      inventory = await this.listGpxFiles(root);
      const fresh = [...inventory].filter((p) => !before.has(p));
      if (fresh.length) {
        newPath = await this.newestGpx(fresh);
        break;
      }
      await this.sleep(this.timing.poll_interval);
    }
    if (!newPath) {
      const seen = [...inventory].sort();
      const where = seen.length ? seen.join(", ") : `(find saw none under ${root})`;
      // Independent cross-check via `ls` on the resolved Download folder, so the
      // message is conclusive even if `find` itself is the problem: it shows what's
      // actually sitting in the default save location.
      const dl = (await this.adb.shell(`ls -1 ${shellQuote(downloadDir)} 2>/dev/null`)).trim();
      const dlList = dl ? dl.split("\n").map((s) => s.trim()).filter(Boolean).join(", ") : "(empty)";
      const reason =
        `could not find the exported GPX file for ${key}: no new .gpx appeared after ` +
        `tapping Save. The Save dialog likely targeted a folder we don't scan, or a ` +
        `confirmation step was missed. GPX files found by find under ${root}: ${where}. ` +
        `Contents of ${downloadDir}: ${dlList}`;
      await progress(`could not find the exported GPX file for ${key}`);
      return { ok: false, reason };
    }

    // Consolidate the export into Downloads under a stable, app-driven name so device
    // files never collide (our own re-export overwrites this ride, never a stranger).
    const finalName = gpxFilename(key);
    const dst = `${downloadDir}/${finalName}`;
    if (newPath !== dst) {
      await this.adb.shell(`rm -f ${shellQuote(dst)} && mv ${shellQuote(newPath)} ${shellQuote(dst)}`);
    }
    const bytes = await this.adb.readFile(dst);
    return {
      ok: true,
      file: { key, filename: finalName, downloadName: gpxDownloadName(key, title), bytes },
    };
  }
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
