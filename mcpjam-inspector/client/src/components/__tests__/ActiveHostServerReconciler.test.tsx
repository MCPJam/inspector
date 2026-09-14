import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { AppStateProvider } from "@/state/app-state-context";
import { ServerActionsProvider } from "@/state/server-actions-context";
import { AUTO_CONNECT_SERVERS_KEY } from "@/stores/preferences/preferences-store";
import { resetAutoConnectAttempts } from "@/hooks/useAutoConnectProjectServers";
import { ActiveHostServerReconciler } from "../ActiveHostServerReconciler";

const viewsMocks = vi.hoisted(() => ({
  servers: [] as Array<{ _id: string; name: string }>,
}));

vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: viewsMocks.servers }),
}));

function makeAppState(
  servers: Record<string, "connected" | "disconnected" | "connecting">,
  selectedMultipleServers: string[],
) {
  return {
    servers: Object.fromEntries(
      Object.entries(servers).map(([name, connectionStatus]) => [
        name,
        { name, connectionStatus },
      ]),
    ),
    selectedMultipleServers,
  } as any;
}

function renderReconciler({
  appState,
  setSelectedServerNames,
  ensureServersReady = vi.fn().mockResolvedValue({
    readyServerNames: [],
    failedServerNames: [],
    missingServerNames: [],
    reauthServerNames: [],
  }),
  activeHost,
  activeHostId = null,
}: {
  appState: ReturnType<typeof makeAppState>;
  setSelectedServerNames: (names: string[]) => void;
  ensureServersReady?: (names: string[]) => Promise<{
    readyServerNames: string[];
    failedServerNames: string[];
    missingServerNames: string[];
    reauthServerNames: string[];
  }>;
  activeHost?: { id: string; serverIds: string[] };
  activeHostId?: string | null;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <AppStateProvider appState={appState}>
        <ServerActionsProvider
          actions={{
            ensureServersReady,
            runtimeDisconnectServer: vi.fn(),
            reconnectServer: vi.fn().mockResolvedValue(undefined),
            setSelectedServerNames,
          }}
        >
          {children}
        </ServerActionsProvider>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );

  return {
    ensureServersReady,
    ...render(
      <ActiveHostServerReconciler
        projectId="proj-1"
        isAuthenticated
        activeHost={activeHost as any}
        activeHostId={activeHostId}
      />,
      { wrapper },
    ),
  };
}

const flush = () => act(() => Promise.resolve());

describe("ActiveHostServerReconciler — active-set mirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAutoConnectAttempts();
    viewsMocks.servers = [];
    localStorage.removeItem(AUTO_CONNECT_SERVERS_KEY);
  });

  it("mirrors connected and reconnecting servers into the multi-select", async () => {
    const setSelectedServerNames = vi.fn();
    renderReconciler({
      appState: makeAppState(
        {
          alpha: "connected",
          beta: "connecting",
          gamma: "disconnected",
        },
        [],
      ),
      setSelectedServerNames,
    });

    await flush();
    // Connected and reconnecting servers stay active; gamma is excluded.
    expect(setSelectedServerNames).toHaveBeenCalledTimes(1);
    expect(setSelectedServerNames.mock.calls[0][0].sort()).toEqual([
      "alpha",
      "beta",
    ]);
  });

  it("does not dispatch when the multi-select already matches (loop guard)", async () => {
    const setSelectedServerNames = vi.fn();
    renderReconciler({
      appState: makeAppState({ alpha: "connected", beta: "connected" }, [
        "beta",
        "alpha",
      ]),
      setSelectedServerNames,
    });

    await flush();
    // Already equal as a set (order-independent) → no write, no loop.
    expect(setSelectedServerNames).not.toHaveBeenCalled();
  });
});

describe("ActiveHostServerReconciler — auto-connect preference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAutoConnectAttempts();
    viewsMocks.servers = [
      { _id: "srv-alpha", name: "alpha" },
      { _id: "srv-beta", name: "beta" },
    ];
    localStorage.removeItem(AUTO_CONNECT_SERVERS_KEY);
  });

  it("connects every catalog server when Auto-connect is on, regardless of the host's serverIds", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["alpha", "beta"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });

    renderReconciler({
      appState: makeAppState(
        { alpha: "disconnected", beta: "disconnected" },
        [],
      ),
      setSelectedServerNames: vi.fn(),
      ensureServersReady,
      // The host claims only alpha; the catalog still wins.
      activeHost: { id: "host-1", serverIds: ["srv-alpha"] },
      activeHostId: "host-1",
    });

    await flush();
    expect(ensureServersReady).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("connects the catalog even when no host is active (fresh project)", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["alpha", "beta"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });

    renderReconciler({
      appState: makeAppState(
        { alpha: "disconnected", beta: "disconnected" },
        [],
      ),
      setSelectedServerNames: vi.fn(),
      ensureServersReady,
    });

    await flush();
    expect(ensureServersReady).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("does not auto-connect anything when Auto-connect is off", async () => {
    localStorage.setItem(AUTO_CONNECT_SERVERS_KEY, "false");
    const ensureServersReady = vi.fn();

    renderReconciler({
      appState: makeAppState(
        { alpha: "disconnected", beta: "disconnected" },
        [],
      ),
      setSelectedServerNames: vi.fn(),
      ensureServersReady,
      activeHost: { id: "host-1", serverIds: ["srv-alpha"] },
      activeHostId: "host-1",
    });

    await flush();
    expect(ensureServersReady).not.toHaveBeenCalled();
  });
});
