/**
 * GPX Toolkit — job ticker + persistent error stack (the bottom-of-screen chrome).
 *
 * Owns two closely-related surfaces that both live off the Controller's job state:
 *  - the live **job bar** / minimized handle / "Up next" queue (what's running now
 *    and what's waiting), and
 *  - the **persistent error stack**: every failure — a failed job OR a standalone
 *    connection/import/storage error pushed via `pushError` — shown as its own
 *    dismissable card that survives the frequent job-ticker re-renders.
 *
 * All the per-surface UI state (queue expanded, handle minimized, which errors are
 * dismissed / expanded / already-flashed) is module-local here rather than in
 * `main.ts`, so the ticker's churn can't collapse an open panel. The module reads
 * job state through an injected `getJobs` (never a direct STATE import) and flashes
 * the newest error via the injected `toast`, keeping it a thin view over the seam.
 */

import type { AppState } from "./controller";
import { escHtml } from "./ui";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

export interface JobsViewDeps {
  /** The Controller's live job state (current task, queue, active keys, history). */
  getJobs: () => AppState["jobs"];
  /** Flash a transient message (errors linger longer); the card is the durable record. */
  toast: (msg: string, err?: boolean) => void;
}

let deps: JobsViewDeps;
export function initJobsView(d: JobsViewDeps): void {
  deps = d;
}

// -- per-surface UI state (module-local so job-ticker re-renders don't reset it) --

// The "Up next" queue list is expanded by default so pending work is visible; kept
// at module scope so the frequent re-renders the job ticker triggers don't reset it.
let queueExpanded = true;
// Whether the user has minimized the live job pill to its small handle. Auto-resets
// when work ends so the next batch shows itself rather than staying hidden silently.
let jobHidden = false;

// Persistent error stack. Every error — failed jobs AND standalone connection /
// import / storage errors — is shown as its own card and only disappears when the
// user dismisses it (or, for a job, when that job is re-run and succeeds). We track
// dismissed/already-flashed ids by string so the two error sources share one model.
const dismissedErrIds = new Set<string>();
const shownErrIds = new Set<string>();
// Error cards the user has expanded ("Details"). Kept at module scope so the
// expansion survives the frequent re-renders the job ticker triggers — otherwise
// renderError() rebuilds the stack from scratch and the open panel collapses.
const expandedErrIds = new Set<string>();
interface PushedError {
  id: string;
  title: string;
  full: string;
  ts: number;
}
const pushedErrors: PushedError[] = [];
let errSeq = 0;

// Human verb for each task kind, used in the queue panel ("Checking", "Uploading"…).
const TASK_VERB: Record<string, string> = {
  scan: "Scanning",
  status: "Checking",
  upload: "Uploading",
  "download-gpx": "Downloading GPX",
  "fetch-weather": "Resolving wind",
};

type JobTask = NonNullable<AppState["jobs"]["current"]>;

/** One-line description of a task: verb + what it acts on (a ride count, or the
 *  scan window). The running task also shows live "done of total" progress. */
function taskTitle(t: JobTask): string {
  const verb = TASK_VERB[t.kind] || t.kind;
  if (t.kind === "scan") return t.label ? `${verb} ${t.label}` : verb;
  const p = t.progress;
  if (p && p.total > 0)
    return `${verb} ${p.done} of ${p.total} ride${p.total === 1 ? "" : "s"}`;
  return `${verb} ${t.count} ride${t.count === 1 ? "" : "s"}`;
}

/** A waiting-queue row: verb + count, with a per-item remove button. */
function queueItemHtml(t: JobTask): string {
  const verb = TASK_VERB[t.kind] || t.kind;
  const desc =
    t.kind === "scan"
      ? t.label
        ? `${verb} ${t.label}`
        : verb
      : `${verb} ${t.count} ride${t.count === 1 ? "" : "s"}`;
  return `<div class="job-item">
    <span class="ji-dot"></span>
    <span class="ji-text">${escHtml(desc)}</span>
    <button class="ji-x" data-cancel="${t.id}" title="Remove from queue" aria-label="Remove from queue">\u00d7</button>
  </div>`;
}

function shortError(text: string): string {
  if (!text) return "";
  const line = text.split("\n").find((l) => l.trim()) || text;
  // The full error is "header:\n  • per-ride detail" — when we show only this first
  // line as a summary (toast / collapsed card), the trailing colon promises detail
  // that isn't shown here, so drop it. The full text keeps the colon + bullets.
  return line.trim().replace(/:$/, "");
}

/** Repaint the live job bar / minimized handle / "Up next" queue from job state. */
export function renderJob(): void {
  const jobs = deps.getJobs();
  const cur = jobs.current;
  const queue = jobs.queue || [];
  // A month/year "Check" is ONE task carrying many ride keys, so counting tasks
  // would show "1 queued" for a 12-ride batch. Count the actual rides subject to
  // the operation instead (running + waiting, deduped via active_keys). Scans have
  // no ride keys, so each pending/running scan counts as a single item.
  const queuedTasks = queue.length;
  const rideCount = new Set(jobs.active_keys || []).size;
  const scanCount = [cur, ...queue].filter((t) => t && t.kind === "scan").length;
  const total = rideCount + scanCount;
  const busy = !!cur || queuedTasks > 0;
  if (!busy) jobHidden = false; // a finished batch clears the hide so the next one reappears
  $("#job").classList.toggle("show", busy && !jobHidden);
  $("#jobHandle").classList.toggle("show", busy && jobHidden);
  document.body.classList.toggle("job-active", busy);

  // -- current activity: what is being done right now -----------------------
  const titleEl = $("#jobTitle");
  const msgEl = $("#jobMsg");
  const bar = $("#jobBar") as HTMLElement;
  if (cur) {
    titleEl.textContent = taskTitle(cur);
    msgEl.textContent = cur.message || "working\u2026";
    const p = cur.progress;
    if (p && p.total > 0) {
      bar.style.display = "";
      ($("#jobBarFill") as HTMLElement).style.width =
        `${Math.round((p.done / p.total) * 100)}%`;
    } else {
      bar.style.display = "none";
    }
  } else if (busy) {
    titleEl.textContent = "Starting\u2026";
    msgEl.textContent = "waiting for the next item\u2026";
    bar.style.display = "none";
  } else {
    bar.style.display = "none";
  }

  // -- queued-ride count badge ----------------------------------------------
  const qc = $("#qcount");
  qc.textContent = total ? `${total} ride${total === 1 ? "" : "s"} queued` : "";
  qc.style.display = total ? "" : "none";

  // Minimized handle: keep it a tiny pill, but convey the NATURE of the work and the
  // PROGRESS, not just a bare count. Show the current verb ("Resolving wind") + a
  // done/total when the running task reports progress, and turn the spinner into a
  // determinate ring that fills as work completes (falls back to the indeterminate
  // spinner when no progress is known, e.g. a scan).
  const handleText = $("#jobHandleText");
  const handleSpin = $("#jobHandle .spin") as HTMLElement;
  const verb = cur ? TASK_VERB[cur.kind] || cur.kind : "Working";
  const hp = cur?.progress;
  if (hp && hp.total > 0) {
    handleSpin.classList.add("det");
    handleSpin.style.setProperty("--p", String(hp.done / hp.total));
    handleText.textContent = `${verb} · ${hp.done}/${hp.total}`;
  } else {
    handleSpin.classList.remove("det");
    handleSpin.style.removeProperty("--p");
    handleText.textContent = total
      ? `${verb} · ${total} ride${total === 1 ? "" : "s"}`
      : `${verb}\u2026`;
  }

  // -- the rest of the queue: what is to be done ----------------------------
  const toggle = $("#btnQueueToggle") as HTMLElement;
  toggle.style.display = queuedTasks ? "" : "none";
  toggle.textContent = `Up next (${queuedTasks})`;
  toggle.setAttribute("aria-expanded", String(queueExpanded));
  const list = $("#jobList");
  const showList = queueExpanded && queuedTasks > 0;
  list.classList.toggle("show", showList);
  list.innerHTML = showList ? queue.map(queueItemHtml).join("") : "";

  // Clear only drops not-yet-started tasks, so keep its visibility tied to the queue.
  ($("#btnClear") as HTMLElement).style.display = queuedTasks ? "" : "none";
  renderError();
}

/** Rebuild the persistent error stack (failed jobs + standalone pushed errors). */
export function renderError(): void {
  const jobs = deps.getJobs();
  const stack = $("#errstack");

  // Combine the two error sources into one newest-first list, dropping any the user
  // has already dismissed. Job errors are keyed by task id; standalone errors carry
  // their own push id. Both expose a wall-clock `ts` so they interleave by recency.
  type ErrCard = { id: string; title: string; full: string; ts: number };
  const cards: ErrCard[] = [];
  const all = [...(jobs.history || [])];
  if (jobs.current) all.push(jobs.current);
  for (const t of all) {
    if (t.status !== "error" || !t.error) continue;
    cards.push({
      id: `job-${t.id}`,
      title: `${t.kind} failed${t.label ? ` — ${t.label}` : ""}`,
      full: t.error,
      ts: (t.finished_at ?? 0) * 1000,
    });
  }
  for (const p of pushedErrors) {
    cards.push({ id: p.id, title: p.title, full: p.full, ts: p.ts });
  }
  const visible = cards.filter((c) => !dismissedErrIds.has(c.id)).sort((a, b) => b.ts - a.ts);

  // Rebuild the stack from scratch each render; building via DOM (not innerHTML)
  // keeps user-supplied error text from being interpreted as markup.
  stack.textContent = "";
  for (const c of visible) {
    const card = document.createElement("div");
    card.className = "errcard";
    card.dataset.id = c.id;

    const bar = document.createElement("div");
    bar.className = "errbar show";

    const ico = document.createElement("span");
    ico.className = "ico";
    ico.textContent = "⚠";

    const etext = document.createElement("div");
    etext.className = "etext";
    const title = document.createElement("b");
    title.textContent = c.title;
    const msg = document.createElement("span");
    msg.textContent = shortError(c.full);
    etext.append(title, msg);

    const details = document.createElement("button");
    details.className = "small ghost";
    details.dataset.errDetails = "";
    details.textContent = "Details";

    const dismiss = document.createElement("button");
    dismiss.className = "small ghost";
    dismiss.dataset.errDismiss = "";
    dismiss.textContent = "Dismiss";

    bar.append(ico, etext, details, dismiss);

    const full = document.createElement("pre");
    full.className = "errfull";
    if (expandedErrIds.has(c.id)) full.classList.add("show");
    full.textContent = c.full;

    card.append(bar, full);
    stack.append(card);
  }

  // Flash the newest error as a toast the first time we see it, for immediacy — the
  // persistent card is the durable record, so the flash may safely fade.
  const newest = visible[0];
  if (newest && !shownErrIds.has(newest.id)) {
    shownErrIds.add(newest.id);
    deps.toast(shortError(newest.full), true);
  }
}

/**
 * Record a standalone error (connection, import, storage…) that lives outside the
 * job queue, so it persists in the error stack until the user dismisses it instead
 * of vanishing with the next status toast.
 */
export function pushError(title: string, full: string): void {
  pushedErrors.push({ id: `push-${++errSeq}`, title, full, ts: Date.now() });
  renderError();
}

/** Toggle the "Up next" queue list (btnQueueToggle). */
export function toggleQueue(): void {
  queueExpanded = !queueExpanded;
  renderJob();
}

/** Minimize the live job pill to its handle (btnJobHide). */
export function hideJob(): void {
  jobHidden = true;
  renderJob();
}

/** Restore the minimized job pill (clicking the handle). */
export function showJob(): void {
  jobHidden = false;
  renderJob();
}

/** Permanently dismiss an error card by its id. */
export function dismissError(id: string): void {
  dismissedErrIds.add(id);
  renderError();
}

/** Toggle an error card's expanded "Details" panel (persists across re-renders). */
export function toggleErrorDetails(id: string): void {
  if (expandedErrIds.has(id)) expandedErrIds.delete(id);
  else expandedErrIds.add(id);
  renderError();
}
