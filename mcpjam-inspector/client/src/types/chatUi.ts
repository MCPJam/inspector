// Shared "Chat UI" types — single source of truth for the chatUi envelope
// that wraps welcome/feedback dialogs (and future surfaces / branding).
// Consumed by the scenario builder, the hosted chat runtime, and the
// playground bootstrap normalizer.

export interface ScenarioWelcomeDialogSettings {
  enabled: boolean;
  body?: string;
}

/**
 * @deprecated The session-level feedback dialog. Its backend write path and
 * storage table are gone; per-turn ratings replaced it.
 *
 * As of the backend's Phase-3 deploy A, redeem and the settings response no
 * longer return this surface at all, and `chatUi.surfaces.feedback` is no
 * longer writable. Nothing in the client reads it. It survives only so a build
 * running against an older backend still typechecks, and goes away with the
 * backend's deploy B.
 */
export interface ScenarioFeedbackDialogSettings {
  enabled: boolean;
  /** Completed tool calls between feedback prompts in hosted sessions (not user message count). */
  everyNToolCalls?: number;
  promptHint?: string;
}

/**
 * Which per-turn widget a scenario shows. `stars` writes `sessionScores` under
 * the `user_rating` key (1–5); `thumbs` writes `user_thumb` (0|1). Both fold
 * into the same session rollup server-side, so the Sessions filters do not
 * branch on this.
 */
export type ScenarioPerTurnFeedbackStyle = "stars" | "thumbs";

/**
 * Per-turn ratings: a rating plus an optional comment under each assistant
 * response, written to `sessionScores` under the key the `style` selects.
 *
 * OFF by default and rolled out per scenario. The backend normalizer returns a
 * fully-defaulted envelope through redeem, so a `true` default would enable
 * this everywhere the moment the UI shipped.
 */
export interface ScenarioPerTurnFeedbackSettings {
  enabled: boolean;
  /** Absent ⇒ `stars`, which is what every scenario predating thumbs had. */
  style?: ScenarioPerTurnFeedbackStyle;
  /** Label above the widget. Empty ⇒ the widget's own copy. */
  prompt?: string;
  commentPlaceholder?: string;
  thanksMessage?: string;
}

export interface ChatUiSurfaces {
  welcome?: ScenarioWelcomeDialogSettings | null;
  /** @deprecated see `ScenarioFeedbackDialogSettings`. */
  feedback?: ScenarioFeedbackDialogSettings | null;
  perTurnFeedback?: ScenarioPerTurnFeedbackSettings | null;
}

export interface ChatUiSettings {
  surfaces?: ChatUiSurfaces | null;
}
