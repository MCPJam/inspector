import { create } from "zustand";
import type { PluginServerUnavailable } from "@/shared/plugin-server-unavailable";

/**
 * The plugin servers each chat's latest turn ran without
 * (`data-plugin-server-unavailable`, see `shared/plugin-server-unavailable.ts`),
 * keyed by chat session id. `seq` orders reports across chats, so a reader can
 * tell a new report from one it has already said something about.
 */
export interface PluginServerReport {
  servers: PluginServerUnavailable[];
  seq: number;
}

interface PluginServerNoticeState {
  reports: Record<string, PluginServerReport>;
  report: (chatSessionId: string, servers: PluginServerUnavailable[]) => void;
}

let nextSeq = 1;

export const usePluginServerNoticeStore = create<PluginServerNoticeState>(
  (set) => ({
    reports: {},
    report: (chatSessionId, servers) =>
      set((state) => ({
        reports: {
          ...state.reports,
          [chatSessionId]: { servers, seq: nextSeq++ },
        },
      })),
  }),
);
