// Shared "Chat UI" types — single source of truth for the chatUi envelope
// that wraps welcome/feedback dialogs (and future surfaces / branding).
// Consumed by the chatbox builder, the hosted chat runtime, and the
// playground bootstrap normalizer.

export interface ChatboxWelcomeDialogSettings {
  enabled: boolean;
  body?: string;
}

export interface ChatboxFeedbackDialogSettings {
  enabled: boolean;
  /** Completed tool calls between feedback prompts in hosted sessions (not user message count). */
  everyNToolCalls?: number;
  promptHint?: string;
}

export interface ChatUiSurfaces {
  welcome?: ChatboxWelcomeDialogSettings | null;
  feedback?: ChatboxFeedbackDialogSettings | null;
}

export interface ChatUiSettings {
  surfaces?: ChatUiSurfaces | null;
}
