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
 * A deterministic, collision-free GPX filename derived from a ride's (unique)
 * datetime key. Beeline names every export after its title/date, so two rides can
 * share a name and clobber each other on the device; deriving the name from the
 * unique key instead guarantees each ride maps to exactly one stable file.
 */
export function gpxFilename(key: string): string {
  const slug = key.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `Beeline-${slug || "ride"}.gpx`;
}

/** A GPX file pulled off the device for one ride. */
export interface GpxFile {
  key: string;
  filename: string;
  bytes: Uint8Array;
}

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
}

const BASE: Timing = {
  open_card: 1.0,
  reveal_swipe: 0.35,
  close_detail: 0.6,
  poll_interval: 1.5,
  grace: 4.0,
  scroll_settle: 0.5,
  optimistic_upload: false,
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

  detailScrollUp(): [number, number, number, number] {
    return [this.cx, Math.trunc(this.height * 0.8), this.cx, Math.trunc(this.height * 0.25)];
  }
}

export class BeelineApp {
  geo!: Geometry;

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

  /** Scroll the list down one screen. Returns false if already at the end. */
  async scrollListDown(): Promise<boolean> {
    const before = (await this.listCards()).map((c) => c.key);
    const [x1, y1, x2, y2] = this.geo.listScrollDown();
    await this.adb.swipe(x1, y1, x2, y2, 300);
    await this.sleep(this.timing.scroll_settle);
    const after = (await this.listCards()).map((c) => c.key);
    return !sameKeys(before, after);
  }

  /** Locate a ride by its datetime key (scrolling) and open it. */
  async findAndOpen(key: string, maxScrolls = 400): Promise<boolean> {
    await this.openJourneys();
    await this.scrollListToTop();
    for (let i = 0; i < maxScrolls; i++) {
      for (const card of await this.listCards()) {
        if (card.key === key) {
          await this.openCard(card);
          return true;
        }
      }
      if (!(await this.scrollListDown())) return false;
    }
    return false;
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
   * Open each ride whose key is in `keys`, read its detail (and upload to Strava if
   * `doUpload` and it is pending). `onDetail` fires after each ride so callers can
   * persist status AS IT IS KNOWN.
   *
   * Navigation is position-aware: we start from wherever the list currently sits
   * (no wasteful scroll-to-top) and scroll *towards* each target using the list's
   * newest-first ordering — newer rides are up, older rides are down. We only move
   * in a direction that could contain a remaining target, and stop as soon as both
   * ends are exhausted, so a removed/stale key can never cause an infinite loop.
   *
   * `onMissing` is called (only when the search ran to completion, not when it was
   * cancelled) with keys we searched the whole list for but never found — i.e. rides
   * that have been deleted on the phone since we last saw them.
   */
  async processTargets(
    keys: Set<string>,
    doUpload: boolean,
    progress: Progress = noop,
    onDetail: (detail: RideDetail) => void = () => {},
    onMissing: (keys: string[]) => void = () => {},
  ): Promise<RideDetail[]> {
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

    if (await stop("checking we're on your rides…")) return [];
    await this.openJourneys(); // dismisses any open detail without resetting scroll
    const remaining = new Set(keys);
    const missing = new Set<string>(); // requested but proven absent → deleted
    const results: RideDetail[] = [];
    let cards = await this.listCards(); // start from the CURRENT position
    let exhaustedUp = false;
    let exhaustedDown = false;

    const left = (): string => `${remaining.size} ride${remaining.size === 1 ? "" : "s"}`;

    while (remaining.size) {
      const target = cards.find((c) => remaining.has(c.key)) ?? null;
      if (target) {
        // Include the date when we have a title, so same-named rides are
        // distinguishable; untitled rides already show the date via the key.
        const dateLabel = rideShortLabel(target.key);
        const name =
          target.title && dateLabel ? `${target.title} (${dateLabel})` : target.title || target.key;
        if (await stop(`opening ride: ${name}`)) break;
        await this.openCard(target);
        if (await stop(`reading ride: ${name}`)) {
          await this.closeDetail();
          break;
        }
        const detail = await this.readDetail();
        if (!detail.key) detail.key = target.key;
        detail.title = detail.title || target.title;
        if (doUpload && detail.stravaStatus === "pending") {
          if (await stop(`uploading to Strava: ${name}`)) {
            await this.closeDetail();
            break;
          }
          detail.stravaStatus = await this.uploadCurrentToStrava(progress);
        } else {
          await progress(`checked: ${name} — ${detail.stravaStatus}`);
        }
        await this.closeDetail(); // Back returns to the list at the same position
        remaining.delete(target.key);
        results.push(detail);
        onDetail(detail); // persist this ride's status immediately
        exhaustedUp = exhaustedDown = false; // position moved; both ends open again
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

      // Pick a direction from where the remaining targets must be.
      const remDates = [...remaining]
        .map(rideDatetime)
        .filter((d): d is Date => d !== null);
      const wantUp = remDates.some((d) => newestVisible !== null && d > newestVisible);
      const wantDown = remDates.some((d) => oldestVisible !== null && d < oldestVisible);

      let goUp: boolean;
      if (wantUp && !exhaustedUp) goUp = true;
      else if (wantDown && !exhaustedDown) goUp = false;
      else if (!exhaustedDown) goUp = false; // unknown/undated → sweep down first…
      else if (!exhaustedUp) goUp = true; // …then up…
      else break; // …both ends reached: the rest are gone.

      if (await stop(`scrolling ${goUp ? "up" : "down"} — looking for ${left()}…`)) break;
      const before = cards.map((c) => c.key);
      const [x1, y1, x2, y2] = goUp ? this.geo.listScrollUp() : this.geo.listScrollDown();
      await this.adb.swipe(x1, y1, x2, y2, goUp ? 250 : 300);
      await this.sleep(this.timing.scroll_settle);
      cards = await this.listCards();
      if (sameKeys(before, cards.map((c) => c.key))) {
        // The list didn't move → we've hit that end.
        if (goUp) exhaustedUp = true;
        else exhaustedDown = true;
      }
    }

    if (!cancelled) {
      for (const key of remaining) missing.add(key); // swept everything → also gone
      if (missing.size) {
        await progress(`${missing.size} ride${missing.size === 1 ? "" : "s"} no longer on the phone — marked deleted`);
        onMissing([...missing]);
      }
    }
    return results;
  }

  // -- GPX export --------------------------------------------------------

  /**
   * Open each ride in `keys`, drive Beeline's native "Options → Share/download →
   * download GPX" flow, and pull the resulting file off the device. `onGpx` fires
   * per ride so callers can persist/download each file as it arrives; `onMissing`
   * reports keys that are no longer on the phone.
   */
  async downloadGpx(
    keys: Set<string>,
    progress: Progress = noop,
    onGpx: (file: GpxFile) => void = () => {},
    onMissing: (keys: string[]) => void = () => {},
  ): Promise<GpxFile[]> {
    const results: GpxFile[] = [];
    const missing: string[] = [];
    for (const key of keys) {
      if (await progress(`finding ride: ${key}`)) break;
      const opened = await this.findAndOpen(key);
      if (!opened) {
        missing.push(key);
        continue;
      }
      const file = await this.exportCurrentGpx(key, progress);
      await this.closeDetail();
      if (file) {
        results.push(file);
        onGpx(file);
      }
    }
    if (missing.length) onMissing(missing);
    return results;
  }

  /** List the `.gpx` filenames currently in the device Downloads folder. */
  private async listGpxDownloads(): Promise<Set<string>> {
    const out = await this.adb.shell(`ls -1 ${DOWNLOAD_DIR}`);
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.toLowerCase().endsWith(".gpx")),
    );
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
   * Returns null if any screen fails to appear or the file never lands.
   */
  private async exportCurrentGpx(key: string, progress: Progress): Promise<GpxFile | null> {
    const before = await this.listGpxDownloads();

    const options = await this.pollFor(findOptionsButton, 4);
    if (!options) {
      await progress(`could not find Options for ${key}`);
      return null;
    }
    await this.tapBounds(options);

    const shareRow = await this.pollFor(findShareDownloadRow, 6);
    if (!shareRow) {
      await progress(`no Share/download option for ${key}`);
      return null;
    }
    await this.tapBounds(shareRow);

    const riddenRoute = await this.pollFor(findRiddenRouteRow, 6);
    if (!riddenRoute) {
      await progress(`no "ridden route" export for ${key}`);
      return null;
    }
    if (await progress(`exporting GPX: ${key}`)) return null;
    await this.tapBounds(riddenRoute);

    // Wait out the "Downloading GPX route" progress, then tap Save in the system dialog.
    const save = await this.pollFor(
      (xml) => (isDownloadingGpx(xml) ? null : findSaveButton(xml)),
      20,
    );
    if (!save) {
      await progress(`GPX export did not complete for ${key}`);
      return null;
    }
    await this.tapBounds(save);

    // The new file appears in Downloads; diff against the pre-export snapshot. We
    // renamed our own previous exports away from Beeline's default naming (below),
    // so Beeline always writes a fresh default-named file here — the diff stays
    // reliable even when the same ride is exported repeatedly.
    let newName: string | null = null;
    for (let i = 0; i < 20; i++) {
      const after = await this.listGpxDownloads();
      const fresh = [...after].filter((n) => !before.has(n));
      if (fresh.length) {
        newName = fresh[fresh.length - 1];
        break;
      }
      await this.sleep(this.timing.poll_interval);
    }
    if (!newName) {
      await progress(`could not find the exported GPX file for ${key}`);
      return null;
    }

    // Move the export to a stable, app-driven name so device files never collide
    // (and overwrite our own prior export of this same ride, never a different one).
    const finalName = gpxFilename(key);
    if (newName !== finalName) {
      const src = `${DOWNLOAD_DIR}/${newName}`;
      const dst = `${DOWNLOAD_DIR}/${finalName}`;
      await this.adb.shell(`rm -f ${shellQuote(dst)} && mv ${shellQuote(src)} ${shellQuote(dst)}`);
    }
    const bytes = await this.adb.readFile(`${DOWNLOAD_DIR}/${finalName}`);
    return { key, filename: finalName, bytes };
  }
}

function sameKeys(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
