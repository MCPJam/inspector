/**
 * Playground agent-controls bridge
 *
 * The playground CHAT session — selected model, system prompt, message
 * history, streaming state, and the reset / stop / model-pick controls — lives
 * inside `PlaygroundMain`'s `useChatSession`. The global playground agent tools
 * (`ui_select_model` / `ui_set_system_prompt` / `ui_reset_chat` /
 * `ui_stop_generation`) are dispatched through inspector-command handlers
 * registered by `use-playground-state` (`PlaygroundTab`, a SIBLING subtree of
 * `PlaygroundMain`). Rather than thread a dozen callbacks up through the shell,
 * `PlaygroundMain` publishes a small controls object here and the command
 * handlers read it.
 *
 * Mirrors `playground-chat-history-bridge`: the object is replaced whole,
 * `PlaygroundMain` clears it to null on unmount, and it exposes the SAME
 * functions the composer controls use (the model picker's onChange, the
 * system-prompt setter, the Clear-chat reset flow, the stop control).
 *
 * TRANSCRIPT SAFETY: the published snapshot fields are already redacted — the
 * selected model is id + display name only, the system prompt is reduced to
 * presence + length (never its text), and the history is a bounded count +
 * last role (never message contents). `setSystemPrompt` takes the
 * user-directed prompt as an INPUT; nothing here ever surfaces it back.
 */
import { create } from "zustand";

/** Selected model, reduced to what a snapshot may safely carry. */
export interface PlaygroundAgentModelSummary {
  id: string;
  name: string;
}

export type PlaygroundModelSelectionResult =
  | { ok: true; model: PlaygroundAgentModelSummary }
  | { ok: false; error: string };

export interface PlaygroundAgentControls {
  // --- snapshot data (transcript-safe, derived) ---
  /** The chat model currently selected, or null before one resolves. */
  selectedModel: PlaygroundAgentModelSummary | null;
  /** Presence + length of the system prompt — never its text. */
  systemPrompt: { present: boolean; length: number };
  /** Bounded history summary — count + last role, never message contents. */
  history: { messageCount: number; lastRole: string | null };
  /** True while a generation (single or any compare lane) is in flight. */
  isGenerating: boolean;

  // --- actions (the same functions the composer controls call) ---
  /** Resolve `identifier` against the available models and select it. */
  selectModel: (identifier: string) => PlaygroundModelSelectionResult;
  /** Replace the system prompt with user-directed text (empty clears it). */
  setSystemPrompt: (prompt: string) => void;
  /** Reset / new the chat through the same flow the Clear-chat button uses. */
  resetChat: () => void;
  /** Stop an in-flight generation; no-op when idle. Reports whether it acted. */
  stopGeneration: () => { stopped: boolean };
}

interface BridgeStore {
  controls: PlaygroundAgentControls | null;
  setControls: (controls: PlaygroundAgentControls | null) => void;
}

export const usePlaygroundAgentControlsBridgeStore = create<BridgeStore>(
  (set) => ({
    controls: null,
    setControls: (controls) => set({ controls }),
  }),
);

/** Read the live controls at dispatch time (null when no chat is mounted). */
export function getPlaygroundAgentControls(): PlaygroundAgentControls | null {
  return usePlaygroundAgentControlsBridgeStore.getState().controls;
}

/**
 * Resolve a user/agent-supplied model identifier against a list of available
 * models. Matches an exact id first, then a case-insensitive display-name
 * match. Pure so the command handler's resolution is unit-testable without a
 * PlaygroundMain render.
 */
export function resolvePlaygroundModelIdentifier<
  M extends { id: unknown; name: string; disabled?: boolean },
>(identifier: string, models: readonly M[]): M | undefined {
  const trimmed = identifier.trim();
  if (!trimmed) return undefined;
  const byId = models.find((model) => String(model.id) === trimmed);
  if (byId) return byId;
  const lower = trimmed.toLowerCase();
  return models.find((model) => model.name.toLowerCase() === lower);
}

/**
 * Resolve an identifier AND apply the picker's availability policy: a disabled
 * row (guest lock, exhausted credits, no tool-calling support) is rejected the
 * same way the visible `ModelSelector` disables it, so an agent can't select a
 * model the UI deliberately locks. Pure, so the policy is unit-testable without
 * a PlaygroundMain render. The caller commits the change only on `ok: true`.
 */
export function resolveSelectablePlaygroundModel<
  M extends {
    id: unknown;
    name: string;
    disabled?: boolean;
    disabledReason?: string;
  },
>(
  identifier: string,
  models: readonly M[],
): { ok: true; model: M } | { ok: false; error: string } {
  const match = resolvePlaygroundModelIdentifier(identifier, models);
  if (!match) {
    return {
      ok: false,
      error: `Unknown model "${identifier}". It must match an available model's id or display name.`,
    };
  }
  if (match.disabled) {
    return {
      ok: false,
      error:
        match.disabledReason ??
        `The model "${match.name}" isn't available right now.`,
    };
  }
  return { ok: true, model: match };
}
