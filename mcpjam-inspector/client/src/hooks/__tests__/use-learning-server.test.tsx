import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AppState } from "@/state/app-types";
import { AppStateProvider } from "@/state/app-state-context";
import {
  DEFAULT_LEARNING_SERVER_URL,
  useLearningServer,
} from "../use-learning-server";

function createAppState(overrides?: Partial<AppState>): AppState {
  return {
    servers: {},
    selectedServer: "none",
    selectedMultipleServers: [],
    isMultiSelectMode: false,
    workspaces: {
      default: {
        id: "default",
        name: "Default",
        servers: {},
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        isDefault: true,
      },
    },
    activeWorkspaceId: "default",
    ...overrides,
  };
}

describe("useLearningServer", () => {
  it("auto-connects the hidden runtime server through the shared runtime API", async () => {
    const connectRuntimeServer = vi.fn().mockResolvedValue(undefined);
    const disconnectRuntimeServer = vi.fn().mockResolvedValue(undefined);
    const getServerEntry = vi.fn();

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider
        appState={createAppState()}
        runtimeApi={{
          connectRuntimeServer,
          disconnectRuntimeServer,
          getServerEntry,
        }}
      >
        {children}
      </AppStateProvider>
    );

    renderHook(() => useLearningServer(), { wrapper });

    await waitFor(() => {
      expect(connectRuntimeServer).toHaveBeenCalledWith({
        name: "__learning__",
        config: {
          url: DEFAULT_LEARNING_SERVER_URL,
        },
        surface: "learning",
        silent: true,
        select: false,
      });
    });
  });

  it("disconnects the runtime server on unmount by default", async () => {
    const connectRuntimeServer = vi.fn().mockResolvedValue(undefined);
    const disconnectRuntimeServer = vi.fn().mockResolvedValue(undefined);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider
        appState={createAppState()}
        runtimeApi={{
          connectRuntimeServer,
          disconnectRuntimeServer,
          getServerEntry: vi.fn(),
        }}
      >
        {children}
      </AppStateProvider>
    );

    const { unmount } = renderHook(
      () => useLearningServer({ autoConnect: false }),
      { wrapper },
    );

    unmount();

    await waitFor(() => {
      expect(disconnectRuntimeServer).toHaveBeenCalledWith("__learning__");
    });
  });

  it("surfaces the connected runtime entry from shared app state", () => {
    const initInfo = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
    };
    const appState = createAppState({
      servers: {
        __learning__: {
          name: "__learning__",
          config: { url: DEFAULT_LEARNING_SERVER_URL } as any,
          connectionStatus: "connected",
          lastConnectionTime: new Date("2024-01-01T00:00:00.000Z"),
          retryCount: 0,
          enabled: true,
          surface: "learning",
          initializationInfo: initInfo,
        },
      },
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider
        appState={appState}
        runtimeApi={{
          connectRuntimeServer: vi.fn(),
          disconnectRuntimeServer: vi.fn(),
          getServerEntry: (name) => appState.servers[name],
        }}
      >
        {children}
      </AppStateProvider>
    );

    const { result } = renderHook(
      () => useLearningServer({ autoConnect: false }),
      { wrapper },
    );

    expect(result.current.isConnected).toBe(true);
    expect(result.current.status).toBe("connected");
    expect(result.current.initInfo).toEqual(initInfo);
  });
});
