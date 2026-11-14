import { create } from "zustand";

interface BrowserLocation {
  projectId: string;
  sessionId: string;
  engine: "local" | "cloud";
}
interface PublishedChatSession {
  sessionId: string;
  appSessionScopeId: string;
  compareActive: boolean;
  viewOnly: boolean;
}
interface ActiveChatSessionState {
  restorationPending: boolean;
  setRestorationPending: (pending: boolean) => void;
  restoredSession: {
    sessionId: string;
    origin?: string;
    browser?: { browserSessionId: string; state: string } | null;
  } | null;
  setRestoredSession: (
    session: NonNullable<ActiveChatSessionState["restoredSession"]>,
  ) => void;
  approvalSettings: Record<string, boolean>;
  setApprovalSetting: (id: string, enabled: boolean) => void;
  /** Durable row / browser identity. Never use it to resolve live App tools. */
  sessionId: string | null;
  appSessionScopeId: string | null;
  publisher: symbol | null;
  publishSession: (owner: symbol, session: PublishedChatSession) => void;
  releaseSession: (owner: symbol) => void;
  compareActive: boolean;
  viewOnly: boolean;
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
    restorationPending: false,
    setRestorationPending: (restorationPending) => set({ restorationPending }),
    restoredSession: null,
    setRestoredSession: (restoredSession) =>
      set((state) => ({
        restoredSession,
        sessionId: restoredSession.sessionId,
        ...(state.sessionId !== restoredSession.sessionId
          ? { appSessionScopeId: null, publisher: null }
          : {}),
      })),
    approvalSettings: {},
    setApprovalSetting: (id, enabled) =>
      set((state) => ({
        approvalSettings: { ...state.approvalSettings, [id]: enabled },
      })),
    sessionId: null,
    appSessionScopeId: null,
    publisher: null,
    publishSession: (publisher, session) =>
      set((state) => ({
        ...session,
        publisher,
        ...(state.restoredSession?.sessionId !== session.sessionId &&
        state.sessionId !== session.sessionId
          ? { restoredSession: null }
          : {}),
      })),
    releaseSession: (publisher) =>
      set((state) =>
        state.publisher === publisher
          ? {
              sessionId: null,
              appSessionScopeId: null,
              publisher: null,
              compareActive: false,
              viewOnly: false,
            }
          : state,
      ),
    compareActive: false,
    viewOnly: false,
    browserLocation: null,
    setBrowserLocation: (browserLocation) => set({ browserLocation }),
    browserSessionId: null,
    setSessionId: (sessionId) =>
      set((state) => ({
        sessionId,
        ...(sessionId !== state.sessionId
          ? { appSessionScopeId: null, publisher: null }
          : {}),
        ...(sessionId !== state.sessionId &&
        state.restoredSession?.sessionId !== sessionId
          ? { restoredSession: null }
          : {}),
      })),
    markBrowserSessionActive: (sessionId) =>
      set({ browserSessionId: sessionId }),
  }),
);
