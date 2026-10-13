/**
 * GPX Toolkit — request deadlines that tell a slow answer from a stalled one.
 *
 * Open-Meteo under load can take a minute to stream a large multi-point answer while
 * staying healthy, and occasionally stops sending altogether. A fixed timeout would
 * either cut off the slow-but-working case or wait forever on the stalled one, so an
 * attempt is aborted when NO bytes arrive for `idleMs` (the wait for the first byte
 * included), or when it outlives `totalMs` regardless. The caller's own signal still
 * cancels at any time, and `timedOut()` tells the two kinds of abort apart.
 */

export interface Deadline {
  /** Pass to `fetch`: aborted on idle / total timeout or by the caller's signal. */
  readonly signal: AbortSignal;
  /** Bytes arrived: restart the idle clock. */
  progress(): void;
  /** True when the abort came from a timeout (not the caller). */
  timedOut(): boolean;
  /** Clear the timers and the caller-signal listener. Always call it. */
  dispose(): void;
}

export function deadline(idleMs: number, totalMs: number, outer?: AbortSignal): Deadline {
  const ctl = new AbortController();
  let timedOut = false;
  const expire = (): void => {
    timedOut = true;
    ctl.abort();
  };
  let idle = setTimeout(expire, idleMs);
  const total = setTimeout(expire, totalMs);
  const onOuter = (): void => ctl.abort(outer?.reason);
  if (outer?.aborted) onOuter();
  else outer?.addEventListener("abort", onOuter, { once: true });
  return {
    signal: ctl.signal,
    progress: () => {
      clearTimeout(idle);
      idle = setTimeout(expire, idleMs);
    },
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(idle);
      clearTimeout(total);
      outer?.removeEventListener("abort", onOuter);
    },
  };
}

/** Read a body as JSON, telling the deadline about every chunk so a slow stream lives. */
export async function readJson(response: Response, d: Deadline): Promise<unknown> {
  const reader = response.body?.getReader?.();
  if (!reader) return response.json();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    d.progress();
    chunks.push(value);
    size += value.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
