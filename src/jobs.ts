/**
 * Background work queue for phone automation.
 *
 * Port of `beeline_uploader.jobs` (Python) to a single-threaded async model: the
 * phone is a single shared resource, so all work (scan / status / upload) runs on
 * one async worker that drains the queue in order. Consecutive upload/status tasks
 * are *coalesced* into one pass over the ride list, so clicking "Upload" on many
 * rides in a row results in one efficient sweep rather than many.
 */

// runner(task, report) executes a task. `report(msg)` updates progress and returns
// true when cancellation has been requested for the running task.
export type Report = (msg: string) => boolean;
export type Runner = (task: Task, report: Report) => Promise<void>;

const COALESCE_KINDS = new Set(["upload", "status", "download-gpx"]);

export type TaskKind = "scan" | "status" | "upload" | "download-gpx";
export type TaskStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface TaskSnapshot {
  id: number;
  kind: string;
  label: string;
  count: number;
  /** Per-ride progress while running (done / total). null until a runner sets it. */
  progress: { done: number; total: number } | null;
  status: TaskStatus;
  message: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string;
}

export interface JobsSnapshot {
  current: TaskSnapshot | null;
  current_keys: string[];
  queue: TaskSnapshot[];
  history: TaskSnapshot[];
  active_keys: string[];
  busy: boolean;
}

export class Task {
  status: TaskStatus = "queued";
  message = "";
  // Live per-ride progress (done / total) set by the runner as each ride completes,
  // so the UI can show an accurate "3 of 12" instead of just a spinner. null while
  // queued or for kinds (scan) whose total isn't known up front.
  progress: { done: number; total: number } | null = null;
  created_at: number = Date.now() / 1000;
  started_at: number | null = null;
  finished_at: number | null = null;
  error = "";

  constructor(
    readonly id: number,
    readonly kind: TaskKind,
    public label: string = "",
    public keys: string[] = [],
    public payload: Record<string, unknown> = {},
  ) {}

  snapshot(): TaskSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      label: this.label,
      count: this.keys.length,
      progress: this.progress ? { ...this.progress } : null,
      status: this.status,
      message: this.message,
      created_at: this.created_at,
      started_at: this.started_at,
      finished_at: this.finished_at,
      error: this.error,
    };
  }
}

export class JobQueue {
  private queue: Task[] = [];
  private current: Task | null = null;
  private history: Task[] = [];
  private counter = 0;
  private cancelCurrent = false;
  private draining = false;

  constructor(
    private readonly runner: Runner,
    private readonly onChange: () => void = () => {},
  ) {}

  // -- public API --------------------------------------------------------

  submit(
    kind: TaskKind,
    opts: { label?: string; keys?: string[]; payload?: Record<string, unknown> } = {},
  ): TaskSnapshot {
    const task = new Task(
      ++this.counter,
      kind,
      opts.label ?? "",
      [...(opts.keys ?? [])],
      { ...(opts.payload ?? {}) },
    );
    this.queue.push(task);
    this.onChange();
    // Defer draining to a microtask so a synchronous burst of submits accumulates
    // in the queue first and coalesces, instead of the first task starting alone.
    queueMicrotask(() => void this.drain());
    return task.snapshot();
  }

  /** Cancel a queued task, or the running task if it is current. */
  cancel(taskId: number): boolean {
    if (this.current && this.current.id === taskId) {
      this.cancelCurrent = true;
      this.current.message = "cancelling…";
      this.onChange();
      return true;
    }
    const idx = this.queue.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      const [t] = this.queue.splice(idx, 1);
      t.status = "cancelled";
      t.finished_at = Date.now() / 1000;
      this.history.unshift(t);
      this.onChange();
      return true;
    }
    return false;
  }

  /** Drop all queued (not-yet-started) tasks. Returns how many were dropped. */
  clear(): number {
    const dropped = this.queue;
    this.queue = [];
    for (const t of dropped) {
      t.status = "cancelled";
      t.finished_at = Date.now() / 1000;
      this.history.unshift(t);
    }
    if (dropped.length) this.onChange();
    return dropped.length;
  }

  /** Clear the queue and cancel the running task. */
  cancelAll(): void {
    this.clear();
    if (this.current) {
      this.cancelCurrent = true;
      this.onChange();
    }
  }

  private activeKeys(): string[] {
    const keys: string[] = [];
    if (this.current) keys.push(...this.current.keys);
    for (const t of this.queue) keys.push(...t.keys);
    return keys;
  }

  snapshot(): JobsSnapshot {
    return {
      current: this.current ? this.current.snapshot() : null,
      current_keys: this.current ? [...this.current.keys] : [],
      queue: this.queue.map((t) => t.snapshot()),
      history: this.history.slice(0, 8).map((t) => t.snapshot()),
      active_keys: this.activeKeys(),
      busy: this.current !== null || this.queue.length > 0,
    };
  }

  // -- worker ------------------------------------------------------------

  private nextTask(): Task | null {
    if (!this.queue.length) return null;
    const task = this.queue.shift()!;
    // Coalesce consecutive same-kind upload/status tasks into this one.
    if (COALESCE_KINDS.has(task.kind)) {
      const seen = new Set(task.keys);
      while (
        this.queue.length &&
        this.queue[0].kind === task.kind &&
        // Don't merge GPX previews with GPX file-saves: they behave differently
        // (only saves emit a file), so a mixed sweep would drop or add downloads.
        this.queue[0].payload.saveToDisk === task.payload.saveToDisk
      ) {
        const nxt = this.queue.shift()!;
        for (const k of nxt.keys) {
          if (!seen.has(k)) {
            seen.add(k);
            task.keys.push(k);
          }
        }
        nxt.status = "done";
        nxt.message = `merged into #${task.id}`;
        nxt.finished_at = Date.now() / 1000;
        this.history.unshift(nxt);
      }
    }
    task.status = "running";
    task.started_at = Date.now() / 1000;
    this.current = task;
    this.cancelCurrent = false;
    return task;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const task = this.nextTask();
        if (task === null) break;
        this.onChange();

        const report: Report = (msg) => {
          task.message = msg;
          this.onChange();
          return this.cancelCurrent;
        };

        try {
          await this.runner(task, report);
          task.status = this.cancelCurrent ? "cancelled" : "done";
        } catch (exc) {
          task.status = "error";
          task.error = exc instanceof Error ? `${exc.message}\n${exc.stack ?? ""}` : String(exc);
        } finally {
          task.finished_at = Date.now() / 1000;
          this.history.unshift(task);
          this.current = null;
          this.onChange();
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
