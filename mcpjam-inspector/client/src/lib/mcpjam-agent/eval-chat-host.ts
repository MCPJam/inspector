import { create } from "zustand";

/** The dashboard supplies its resolved project, not the app's bootstrap project. */
export const useEvalChatHost = create<{
  host: {
    element: HTMLElement;
    projectId: string | null;
    organizationId: string | null;
  } | null;
  setHost: (
    host: {
      element: HTMLElement;
      projectId: string | null;
      organizationId: string | null;
    } | null,
  ) => void;
}>((set) => ({ host: null, setHost: (host) => set({ host }) }));
