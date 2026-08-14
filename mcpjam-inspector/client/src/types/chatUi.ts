// Shared "Chat UI" types — single source of truth for the chatUi envelope
// that wraps welcome/feedback dialogs (and future surfaces / branding).
// Consumed by the chatbox builder, the hosted chat runtime, and the
// playground bootstrap normalizer.

export interface ChatboxWelcomeDialogSettings {
  enabled: boolean;
  body?: string;
}

/**
 * @deprecated The session-level feedback dialog. Its backend write path and
 * storage table are gone; per-turn ratings replaced it. Kept because stored
 * chatbox docs still carry the object.
 */
export interface ChatboxFeedbackDialogSettings {
  enabled: boolean;
  /** Completed tool calls between feedback prompts in hosted sessions (not user message count). */
  everyNToolCalls?: number;
  promptHint?: string;
}

/**
 * Per-turn ratings: 1–5 stars plus an optional comment under each assistant
 * response, written to `sessionScores` under the `user_rating` key.
 *
 * OFF by default and rolled out per scenario. The backend normalizer returns a
 * fully-defaulted envelope through redeem, so a `true` default would enable
 * this everywhere the moment the UI shipped.
 */
export interface ChatboxPerTurnFeedbackSettings {
  enabled: boolean;
  /** Label above the stars. Empty ⇒ the widget's own copy. */
  prompt?: string;
  commentPlaceholder?: string;
  thanksMessage?: string;
}

export interface ChatUiSurfaces {
  welcome?: ChatboxWelcomeDialogSettings | null;
  /** @deprecated see `ChatboxFeedbackDialogSettings`. */
  feedback?: ChatboxFeedbackDialogSettings | null;
  perTurnFeedback?: ChatboxPerTurnFeedbackSettings | null;
}

export interface ChatUiSettings {
  surfaces?: ChatUiSurfaces | null;
}
