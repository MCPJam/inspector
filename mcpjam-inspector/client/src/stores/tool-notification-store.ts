import { create } from "zustand";
import type { ToolNotification } from "@/shared/tool-notification";

/**
 * What a running tool call's server has sent so far (`data-tool-notification`),
 * keyed by tool call id: its latest progress and the last log lines. They are
 * for watching a call work, and the result is what the call returns. Live
 * only; a reload has none.
 */
export const TOOL_LOG_LINES_KEPT = 20;

/**
 * Calls whose notes are kept. A call's notes show only while it runs, and a
 * running call keeps being heard from, so the calls dropped are those quiet
 * longest: finished, cancelled or abandoned ones.
 */
export const TOOL_RUNS_KEPT = 100;

export interface ToolRunNotes {
  progress?: { progress: number; total?: number; message?: string };
  logs: Array<{ level: string; logger?: string; text: string }>;
}

interface ToolNotificationState {
  runs: Record<string, ToolRunNotes>;
  apply: (notification: ToolNotification) => void;
}

export const useToolNotificationStore = create<ToolNotificationState>(
  (set) => ({
    runs: {},
    apply: (notification) =>
      set((state) => {
        const { [notification.toolCallId]: run = { logs: [] }, ...others } =
          state.runs;
        const next: ToolRunNotes =
          notification.kind === "progress"
            ? {
                ...run,
                progress: {
                  progress: notification.progress,
                  total: notification.total,
                  message: notification.message,
                },
              }
            : {
                ...run,
                logs: [
                  ...run.logs,
                  {
                    level: notification.level,
                    logger: notification.logger,
                    text: notification.text,
                  },
                ].slice(-TOOL_LOG_LINES_KEPT),
              };
        // The call just heard from goes last, so the first are the quietest.
        const earlier = Object.entries(others);
        const kept = earlier.slice(
          Math.max(0, earlier.length - (TOOL_RUNS_KEPT - 1)),
        );
        return {
          runs: { ...Object.fromEntries(kept), [notification.toolCallId]: next },
        };
      }),
  }),
);

export function useToolRunNotes(
  toolCallId: string | undefined,
): ToolRunNotes | undefined {
  return useToolNotificationStore((state) =>
    toolCallId ? state.runs[toolCallId] : undefined,
  );
}
