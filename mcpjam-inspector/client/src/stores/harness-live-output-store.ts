import { create } from "zustand";

/**
 * What a running harness command has printed so far
 * (`data-harness-tool-output`, Codex), keyed by its tool call id. Only the
 * tail is kept: it is for watching a command work, and the full output
 * arrives as the tool call's result. Live only; a reload has none.
 */
export const HARNESS_LIVE_OUTPUT_TAIL_CHARS = 8 * 1024;

interface HarnessLiveOutputState {
  outputs: Record<string, string>;
  append: (toolCallId: string, delta: string) => void;
}

export const useHarnessLiveOutputStore = create<HarnessLiveOutputState>(
  (set) => ({
    outputs: {},
    append: (toolCallId, delta) =>
      set((state) => {
        const next = (state.outputs[toolCallId] ?? "") + delta;
        return {
          outputs: {
            ...state.outputs,
            [toolCallId]:
              next.length > HARNESS_LIVE_OUTPUT_TAIL_CHARS
                ? next.slice(-HARNESS_LIVE_OUTPUT_TAIL_CHARS)
                : next,
          },
        };
      }),
  }),
);

/** The output a command has printed so far, if any arrived. */
export function useHarnessLiveOutput(
  toolCallId: string | undefined,
): string | undefined {
  return useHarnessLiveOutputStore((state) =>
    toolCallId ? state.outputs[toolCallId] : undefined,
  );
}
