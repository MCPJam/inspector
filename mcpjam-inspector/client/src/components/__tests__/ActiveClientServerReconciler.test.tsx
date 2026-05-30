import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { AppStateProvider } from "@/state/app-state-context";
import { ServerActionsProvider } from "@/state/server-actions-context";
import { ActiveClientServerReconciler } from "../ActiveClientServerReconciler";

// The reconciler reads the project catalog via this hook; the mirror under
// test doesn't need it, so stub it to "no servers, loaded".
vi.mock("@/hooks/useViews", () => ({
  useProjectServers: () => ({ servers: [] }),
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
}: {
  appState: ReturnType<typeof makeAppState>;
  setSelectedServerNames: (names: string[]) => void;
}) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <AppStateProvider appState={appState}>
        <ServerActionsProvider
          actions={{
            ensureServersReady: vi.fn().mockResolvedValue({
              readyServerNames: [],
              failedServerNames: [],
              missingServerNames: [],
              reauthServerNames: [],
            }),
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

  return render(
    // No active host → no recycle/auto-connect fires, isolating the mirror.
    <ActiveClientServerReconciler
      projectId="proj-1"
      isAuthenticated
      activeHost={undefined}
      activeHostId={null}
    />,
    { wrapper },
  );
}

const flush = () => act(() => Promise.resolve());

describe("ActiveClientServerReconciler — active-set mirror", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mirrors the connected set into the multi-select", async () => {
    const setSelectedServerNames = vi.fn();
    renderReconciler({
      appState: makeAppState(
        { alpha: "connected", beta: "connected", gamma: "disconnected" },
        [],
      ),
      setSelectedServerNames,
    });

    await flush();
    // Only connected servers become active; gamma (disconnected) is excluded.
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
