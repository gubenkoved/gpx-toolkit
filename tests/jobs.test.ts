import { describe, expect, it, vi } from "vitest";

import { JobQueue, type Report, type Task } from "../src/jobs";

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("JobQueue", () => {
  it("runs tasks in order", async () => {
    const seen: string[] = [];
    const q = new JobQueue(async (task: Task) => {
      seen.push(task.label);
    });
    q.submit("upload", { label: "a", keys: ["k1"] });
    q.submit("scan", { label: "b", payload: { preset: "all" } });
    await vi.waitFor(() => expect(seen).toEqual(["a", "b"]));
  });

  it("coalesces consecutive uploads into one pass", async () => {
    const processed: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new JobQueue(async (task: Task) => {
      await gate;
      processed.push([...task.keys]);
    });
    q.submit("upload", { keys: ["a"] });
    q.submit("upload", { keys: ["b"] });
    q.submit("upload", { keys: ["c"] });
    await tick(10); // worker picks up the first and coalesces the rest
    release();
    await vi.waitFor(() => expect(processed.length).toBeGreaterThanOrEqual(1));
    expect(new Set(processed[0])).toEqual(new Set(["a", "b", "c"]));
    expect(processed).toHaveLength(1);
  });

  it("coalesces consecutive download-gpx tasks into one pass", async () => {
    const processed: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new JobQueue(async (task: Task) => {
      await gate;
      processed.push([...task.keys]);
    });
    q.submit("download-gpx", { keys: ["a"] });
    q.submit("download-gpx", { keys: ["b"] });
    await tick(10);
    release();
    await vi.waitFor(() => expect(processed.length).toBeGreaterThanOrEqual(1));
    expect(new Set(processed[0])).toEqual(new Set(["a", "b"]));
    expect(processed).toHaveLength(1);
  });

  it("does not coalesce GPX preview and save tasks together", async () => {
    const processed: { keys: string[]; save: unknown }[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new JobQueue(async (task: Task) => {
      await gate;
      processed.push({ keys: [...task.keys], save: task.payload.saveToDisk });
    });
    // A preview-only download and a save-to-disk download behave differently, so
    // they must stay as two separate passes even though both are "download-gpx".
    q.submit("download-gpx", { keys: ["a"], payload: { saveToDisk: false } });
    q.submit("download-gpx", { keys: ["b"], payload: { saveToDisk: true } });
    await tick(10);
    release();
    await vi.waitFor(() => expect(processed.length).toBe(2));
    expect(processed[0]).toEqual({ keys: ["a"], save: false });
    expect(processed[1]).toEqual({ keys: ["b"], save: true });
  });

  it("clear() drops queued tasks but not the running one", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new JobQueue(async () => {
      await gate;
    });
    q.submit("scan", { payload: { preset: "all" } }); // occupies the worker
    await tick(10);
    q.submit("scan", { payload: { preset: "week" } });
    q.submit("scan", { payload: { preset: "year" } });
    expect(q.clear()).toBe(2);
    release();
  });

  it("cancellation is surfaced to the runner via report()", async () => {
    let observed = false;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const q = new JobQueue(async (_task: Task, report: Report) => {
      started();
      await gate;
      observed = report("still going?");
    });
    const snap = q.submit("upload", { keys: ["x"] });
    await startedP;
    q.cancel(snap.id);
    release();
    await vi.waitFor(() => expect(observed).toBe(true));
  });
});
