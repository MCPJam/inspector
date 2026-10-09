import { create } from "zustand";
import type {
  HarnessBackgroundTaskInfo,
  HarnessSubagentStepInfo,
} from "@/shared/harness-session";

/**
 * What a harness's Agent call is doing while it runs, keyed by the Agent call's
 * tool call id: the subagent's steps (`data-harness-subagent-step`) and, for a
 * background agent, its task status (`data-harness-background-task`). The
 * Agent card reads it to show the work as it happens.
 *
 * Live only: both parts are transient, so a reload shows the Agent call's
 * result and nothing here. Kept for the life of the page; a step list is
 * capped so a long-running agent cannot grow it without bound.
 */
export interface HarnessAgentStep {
  toolUseId: string;
  toolName: string;
  input?: Record<string, string | number | boolean>;
  /** Unset while the step runs. */
  status?: "done" | "error";
  error?: string;
  /** True when a nested subagent took the step, not the Agent call's own. */
  nested: boolean;
}

export interface HarnessAgentActivity {
  steps: HarnessAgentStep[];
  /** A background agent's task status (`running`, `completed`, `failed`…). */
  backgroundStatus?: string;
}

/** Older steps drop off past this; the card says how many it hid. */
export const HARNESS_AGENT_STEPS_MAX = 200;

interface HarnessAgentActivityState {
  activities: Record<string, HarnessAgentActivity>;
  /** Steps dropped off the front of each activity, by Agent call id. */
  dropped: Record<string, number>;
  applyStep: (step: HarnessSubagentStepInfo) => void;
  applyBackgroundTask: (info: HarnessBackgroundTaskInfo) => void;
}

const EMPTY: HarnessAgentActivity = { steps: [] };

export const useHarnessAgentActivityStore = create<HarnessAgentActivityState>(
  (set) => ({
    activities: {},
    dropped: {},
    applyStep: (step) =>
      set((state) => {
        const key = step.rootToolUseId;
        const current = state.activities[key] ?? EMPTY;
        let steps: HarnessAgentStep[];
        if (step.kind === "tool-call") {
          if (current.steps.some((s) => s.toolUseId === step.toolUseId)) {
            return state;
          }
          steps = [
            ...current.steps,
            {
              toolUseId: step.toolUseId,
              toolName: step.toolName,
              ...(step.input ? { input: step.input } : {}),
              nested: step.parentToolUseId !== key,
            },
          ];
        } else {
          const at = current.steps.findIndex(
            (s) => s.toolUseId === step.toolUseId,
          );
          if (at < 0) return state;
          steps = current.steps.slice();
          steps[at] = {
            ...steps[at]!,
            status: step.isError ? "error" : "done",
            ...(step.error ? { error: step.error } : {}),
          };
        }
        const overflow = Math.max(0, steps.length - HARNESS_AGENT_STEPS_MAX);
        return {
          activities: {
            ...state.activities,
            [key]: {
              ...current,
              steps: overflow > 0 ? steps.slice(overflow) : steps,
            },
          },
          dropped:
            overflow > 0
              ? {
                  ...state.dropped,
                  [key]: (state.dropped[key] ?? 0) + overflow,
                }
              : state.dropped,
        };
      }),
    applyBackgroundTask: (info) =>
      set((state) => {
        if (info.kind !== "task" || !info.toolUseId) return state;
        const current = state.activities[info.toolUseId] ?? EMPTY;
        if (current.backgroundStatus === info.status) return state;
        return {
          activities: {
            ...state.activities,
            [info.toolUseId]: { ...current, backgroundStatus: info.status },
          },
        };
      }),
  }),
);

/** The live activity of one Agent call, if any arrived. */
export function useHarnessAgentActivity(toolCallId: string | undefined): {
  activity: HarnessAgentActivity | undefined;
  dropped: number;
} {
  const activity = useHarnessAgentActivityStore((state) =>
    toolCallId ? state.activities[toolCallId] : undefined,
  );
  const dropped = useHarnessAgentActivityStore((state) =>
    toolCallId ? (state.dropped[toolCallId] ?? 0) : 0,
  );
  return { activity, dropped };
}
