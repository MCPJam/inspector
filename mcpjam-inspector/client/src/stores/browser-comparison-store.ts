import { create } from "zustand";

export interface BrowserComparisonClient {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  clientId: string;
  name: string;
  logo?: string | null;
  order: number;
  clientCount: number;
  engine: "local" | "cloud";
  started?: boolean;
}

interface BrowserComparisonStore {
  clients: Record<string, BrowserComparisonClient>;
  selected: Record<string, string>;
  register: (client: BrowserComparisonClient) => void;
  unregister: (sessionId: string, workspaceId: string) => void;
  noteBrowsing: (sessionId: string) => string;
  select: (workspaceId: string, sessionId: string) => void;
}

/** Transient: comparison sessions belong to mounted cards, never to a project default. */
export const useBrowserComparisonStore = create<BrowserComparisonStore>(
  (set, get) => ({
    clients: {},
    selected: {},
    register: (client) =>
      set((state) => ({
        clients: {
          ...state.clients,
          [client.sessionId]: {
            ...client,
            started: state.clients[client.sessionId]?.started ?? false,
            engine: state.clients[client.sessionId]?.started
              ? state.clients[client.sessionId].engine
              : client.engine,
          },
        },
      })),
    unregister: (sessionId, workspaceId) =>
      set((state) => {
        if (state.clients[sessionId]?.workspaceId !== workspaceId) return state;
        const clients = { ...state.clients };
        delete clients[sessionId];
        const selected = { ...state.selected };
        if (selected[workspaceId] === sessionId) {
          const next = Object.values(clients)
            .filter(
              (client) => client.workspaceId === workspaceId && client.started,
            )
            .sort((a, b) => a.order - b.order)[0];
          if (next) selected[workspaceId] = next.sessionId;
          else delete selected[workspaceId];
        }
        return { clients, selected };
      }),
    noteBrowsing: (sessionId) => {
      const client = get().clients[sessionId];
      if (!client) return sessionId;
      set((state) => ({
        clients: client.started
          ? state.clients
          : {
              ...state.clients,
              [sessionId]: { ...client, started: true },
            },
        selected: state.selected[client.workspaceId]
          ? state.selected
          : {
              ...state.selected,
              [client.workspaceId]: sessionId,
            },
      }));
      return client.workspaceId;
    },
    select: (workspaceId, sessionId) =>
      set((state) =>
        state.clients[sessionId]?.workspaceId === workspaceId
          ? { selected: { ...state.selected, [workspaceId]: sessionId } }
          : state,
      ),
  }),
);
