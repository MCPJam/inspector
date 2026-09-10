import { create } from "zustand";

interface BrowserLocation {
  projectId: string;
  sessionId: string;
  engine: "local" | "cloud";
}
interface ActiveChatSessionState {
  approvalSettings: Record<string, boolean>;
  setApprovalSetting: (id: string, enabled: boolean) => void;
  sessionId: string | null;
  browserLocation: BrowserLocation | null;
  setBrowserLocation: (location: BrowserLocation) => void;
  /** The current conversation has successfully opened a browser session. */
  browserSessionId: string | null;
  setSessionId: (sessionId: string | null) => void;
  markBrowserSessionActive: (sessionId: string) => void;
}

/**
 * The Playground center and right rail are siblings, so the browser panel
 * cannot receive the chat id through props without coupling the layout. This
 * tiny store publishes the currently mounted conversation identity and keeps
 * it out of the legacy browser path when the feature flag is off.
 */
export const useActiveChatSessionStore = create<ActiveChatSessionState>(
  (set) => ({
    approvalSettings: {},
    setApprovalSetting: (id, enabled) =>
      set((state) => ({
        approvalSettings: { ...state.approvalSettings, [id]: enabled },
      })),
    sessionId: null,
    browserLocation: null,
    setBrowserLocation: (browserLocation) => set({ browserLocation }),
    browserSessionId: null,
    setSessionId: (sessionId) => set({ sessionId }),
    markBrowserSessionActive: (sessionId) =>
      set({ browserSessionId: sessionId }),
  }),
);
