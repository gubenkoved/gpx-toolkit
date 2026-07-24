/**
 * GPX Toolkit — Sources & Settings dialogs.
 *
 * The connect/manage **Sources** dialog (Beeline account card + GPX card) and the
 * **Settings** dialog. These are pure view surfaces: they read connection/settings
 * state through the injected `getState` / `isDemo` / `rememberedEmail` seam and, on
 * dismissal, call back into the app via `onDismiss` so the auth flow's deferred
 * action (see `withBeelineAccess` in main) is cleared in one place. The actual
 * sign-in / demo / disconnect wiring stays in main; this module only shows, hides
 * and repaints the dialogs.
 */

import type { AppState } from "./controller";
import { setSliderFill } from "./slider";

export interface SourcesViewDeps {
  /** Live app state (connection, device label, settings). */
  getState: () => AppState;
  /** Whether the Beeline simulated (demo) account is active. */
  isDemo: () => boolean;
  /** The remembered Beeline email, to prefill the sign-in field. */
  rememberedEmail: () => string;
  /** Called when the Sources dialog is dismissed — clears any deferred sign-in action. */
  onDismiss: () => void;
}

let deps: SourcesViewDeps;
export function initSourcesView(d: SourcesViewDeps): void {
  deps = d;
}

/**
 * Show the Sources dialog (connect/manage data sources), prefilling the remembered
 * Beeline email if any. In `reauth` mode it focuses the Beeline sign-in (the user
 * already has a profile and just needs to re-enter the password — which a password
 * manager can inject). In `welcome` mode it leads with the onboarding intro.
 */
export function showSources(opts: { reauth?: boolean; welcome?: boolean } = {}): void {
  const picker = document.getElementById("srcPick");
  if (!picker) return;
  const reauth = opts.reauth === true;
  picker.classList.toggle("reauth", reauth);
  picker.classList.toggle("welcome", opts.welcome === true);

  const email = deps.rememberedEmail();
  const emailInput = document.getElementById("beelineEmail") as HTMLInputElement | null;
  if (email && emailInput && !emailInput.value) emailInput.value = email;

  const sub = picker.querySelector(".srcpick-sub");
  if (sub) {
    sub.textContent = reauth
      ? "Sign in to your Beeline account to sync."
      : "Connect the sources your rides come from. They all live together in one library.";
  }
  renderSources();

  setBeelineError("");
  picker.classList.remove("hidden");
  if (reauth) {
    const pass = document.getElementById("beelinePass") as HTMLInputElement | null;
    pass?.focus();
  }
}

export function hideSources(): void {
  const picker = document.getElementById("srcPick");
  picker?.classList.add("hidden");
  picker?.classList.remove("reauth", "welcome");
  // Dismissing the prompt abandons any action that was waiting on sign-in.
  deps.onDismiss();
}

/** Open the Settings dialog, syncing each control to the persisted setting. */
export function showSettings(): void {
  const modal = document.getElementById("settingsModal");
  if (!modal) return;
  const thresh = deps.getState().settings.movingThresholdKmh;
  const slider = document.getElementById("setMovingThresh") as HTMLInputElement | null;
  if (slider) slider.value = String(thresh);
  if (slider) setSliderFill(slider);
  const out = document.getElementById("setMovingThreshOut") as HTMLOutputElement | null;
  if (out) out.value = `${thresh} km/h`;
  const suggestTags = document.getElementById("setSuggestTags") as HTMLInputElement | null;
  if (suggestTags) suggestTags.checked = deps.getState().settings.suggestTagsAfterImport;
  modal.classList.remove("hidden");
}

export function hideSettings(): void {
  document.getElementById("settingsModal")?.classList.add("hidden");
}

export function setBeelineError(message: string): void {
  const el = document.getElementById("beelineErr");
  if (el) el.textContent = message;
}

/**
 * Populate the Beeline card in the Sources dialog from the live connection state:
 * when connected (or demo) it shows "Connected as …" + the per-source actions
 * (Pull from Beeline / Disconnect); otherwise the sign-in form. Driven by the
 * Controller's state, so it stays correct as the connection changes while open.
 */
export function renderSources(): void {
  const card = document.getElementById("srcBeeline");
  if (!card) return;
  const state = deps.getState();
  const connected = state.connected || deps.isDemo();
  card.classList.toggle("connected", connected);
  const status = document.getElementById("beelineStatus");
  if (status) {
    status.textContent = connected
      ? deps.isDemo()
        ? "Connected — demo account"
        : `Connected — ${state.device || "Beeline account"}`
      : "";
  }
}
