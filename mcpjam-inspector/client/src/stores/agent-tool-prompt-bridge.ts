import { create } from "zustand";

/**
 * One-shot bridge for "Ask agent to run" on a harness built-in tool.
 *
 * The built-in tool form lives in the left Tools rail, but the chat send path
 * (with all its ready/disabled/streaming guards) lives in `PlaygroundMain` — a
 * sibling subtree. Rather than thread a send callback through three layers, the
 * form `requestRun(prompt)`s here and `PlaygroundMain` consumes it. A monotonic
 * `nonce` makes each request distinct so the consumer fires exactly once per
 * click (and never re-fires the same request on re-render).
 */
export interface AgentToolPromptRequest {
  prompt: string;
  nonce: number;
}

interface AgentToolPromptBridgeState {
  pending: AgentToolPromptRequest | null;
  requestRun: (prompt: string) => void;
  consume: () => void;
}

let nonceCounter = 0;

export const useAgentToolPromptBridge = create<AgentToolPromptBridgeState>(
  (set) => ({
    pending: null,
    requestRun: (prompt) => set({ pending: { prompt, nonce: ++nonceCounter } }),
    consume: () => set({ pending: null }),
  }),
);
