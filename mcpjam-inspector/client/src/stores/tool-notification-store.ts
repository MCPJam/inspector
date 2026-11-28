import { create } from "zustand";
import type { ToolNotification } from "@/shared/tool-notification";

/**
 * What a running tool call's server has sent so far (`data-tool-notification`),
 * keyed by tool call id: its latest progress and the last log lines. They are
 * for watching a call work, and the result is what the call returns. Live
 * only; a reload has none.
 */
export const TOOL_LOG_LINES_KEPT = 20;

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
        const run = state.runs[notification.toolCallId] ?? { logs: [] };
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
        return { runs: { ...state.runs, [notification.toolCallId]: next } };
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
