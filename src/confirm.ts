/**
 * GPX Toolkit — styled confirm / prompt / consent dialogs.
 *
 * A themed, promise-based replacement for the browser's native `confirm()` /
 * `prompt()`, reusing the app's modal vocabulary (`.scrim` + `.modal-card`, the
 * `#confirmModal` shell in index.html) so high-stakes actions read as on-brand
 * instead of a system popup. Only one dialog is open at a time.
 *
 * Self-contained: it owns its own state + DOM listeners (call `initConfirm()` once
 * at startup). Callers just `await confirmDialog(...)` / `promptDialog(...)` /
 * `consentDialog(...)`. Extracted from `main.ts` to shrink the monolith.
 */

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T =>
  document.querySelector(sel) as T;

// Resolver for the currently-open dialog (null when closed).
let confirmResolve: ((value: boolean | string | null) => void) | null = null;
// True while the open dialog is a prompt (collects text) rather than a yes/no.
let confirmIsPrompt = false;

/**
 * Show the styled confirmation modal and resolve to whether the user confirmed.
 */
export function confirmDialog(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
}): Promise<boolean> {
  const modal = document.getElementById("confirmModal");
  if (!modal) return Promise.resolve(true);
  confirmResolve?.(false); // abandon any prior pending dialog
  confirmIsPrompt = false;
  $("#confirmInput").classList.add("hidden");
  $("#confirmCheck").classList.add("hidden");
  $("#confirmTitle").textContent = opts.title;
  $("#confirmBody").textContent = opts.body;
  $("#confirmOk").textContent = opts.confirmLabel ?? "Confirm";
  modal.classList.remove("hidden");
  $<HTMLButtonElement>("#confirmOk").focus();
  return new Promise<boolean>((resolve) => {
    confirmResolve = resolve as (v: boolean | string | null) => void;
  });
}

/**
 * One-time consent prompt before routing a full-GPX download through the external
 * export gateway. Reuses the confirm modal — plus its checkbox row — so it matches
 * the app's dialog vocabulary. Resolves to whether the user agreed and whether they
 * ticked "don't ask again".
 */
export function consentDialog(opts: {
  title: string;
  body: string;
  confirmLabel?: string;
  checkLabel: string;
  checked?: boolean;
}): Promise<{ ok: boolean; dontAsk: boolean }> {
  const modal = document.getElementById("confirmModal");
  if (!modal) return Promise.resolve({ ok: true, dontAsk: false });
  confirmResolve?.(false); // abandon any prior pending dialog
  confirmIsPrompt = false;
  $("#confirmInput").classList.add("hidden");
  $("#confirmCheck").classList.remove("hidden");
  $("#confirmCheckLabel").textContent = opts.checkLabel;
  $<HTMLInputElement>("#confirmCheckBox").checked = opts.checked ?? true;
  $("#confirmTitle").textContent = opts.title;
  $("#confirmBody").textContent = opts.body;
  $("#confirmOk").textContent = opts.confirmLabel ?? "Continue";
  modal.classList.remove("hidden");
  $<HTMLButtonElement>("#confirmOk").focus();
  return new Promise<{ ok: boolean; dontAsk: boolean }>((resolve) => {
    confirmResolve = ((ok) => {
      const dontAsk = $<HTMLInputElement>("#confirmCheckBox").checked;
      resolve({ ok: ok === true, dontAsk });
    }) as (v: boolean | string | null) => void;
  });
}

/**
 * Like `confirmDialog`, but with a single text field — a themed replacement for
 * window.prompt. Resolves to the (trimmed) entered string, or null when cancelled.
 * Pre-fills `value` and selects it so the common "tweak then accept" is one gesture.
 */
export function promptDialog(opts: {
  title: string;
  body: string;
  value?: string;
  confirmLabel?: string;
}): Promise<string | null> {
  const modal = document.getElementById("confirmModal");
  if (!modal) return Promise.resolve(null);
  confirmResolve?.(false); // abandon any prior pending dialog
  confirmIsPrompt = true;
  $("#confirmCheck").classList.add("hidden");
  $("#confirmTitle").textContent = opts.title;
  $("#confirmBody").textContent = opts.body;
  $("#confirmOk").textContent = opts.confirmLabel ?? "Save";
  const input = $<HTMLInputElement>("#confirmInput");
  input.classList.remove("hidden");
  input.value = opts.value ?? "";
  modal.classList.remove("hidden");
  input.focus();
  input.select();
  return new Promise<string | null>((resolve) => {
    confirmResolve = resolve as (v: boolean | string | null) => void;
  });
}

/** Close the confirm/prompt modal and settle its promise with the user's choice. */
export function closeConfirm(ok: boolean): void {
  document.getElementById("confirmModal")?.classList.add("hidden");
  document.getElementById("confirmCheck")?.classList.add("hidden");
  const resolve = confirmResolve;
  const isPrompt = confirmIsPrompt;
  confirmResolve = null;
  confirmIsPrompt = false;
  if (!resolve) return;
  if (isPrompt) {
    const value = $<HTMLInputElement>("#confirmInput").value.trim();
    resolve(ok ? value : null);
  } else {
    resolve(ok);
  }
}

/** Wire the dialog's own DOM listeners (OK / Cancel / backdrop / Enter). Call once. */
export function initConfirm(): void {
  document.getElementById("confirmOk")?.addEventListener("click", () => closeConfirm(true));
  document
    .getElementById("confirmCancel")
    ?.addEventListener("click", () => closeConfirm(false));
  document.getElementById("confirmModal")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeConfirm(false);
  });
  // Enter in the prompt input accepts (Escape is handled by the app's global keydown).
  document.getElementById("confirmInput")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      e.preventDefault();
      closeConfirm(true);
    }
  });
}
