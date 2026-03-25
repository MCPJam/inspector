import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppStateProvider } from "@/state/app-state-context";
import { createServer } from "@/test/factories";
import { createMockAppState, createMockRuntimeApi } from "@/test/mocks";
import {
  DEFAULT_LEARNING_SERVER_URL,
  useLearningServer,
} from "../use-learning-server";

describe("useLearningServer", () => {
  it("auto-connects the hidden runtime server through the shared runtime API", async () => {
    const runtimeApi = createMockRuntimeApi();

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider appState={createMockAppState()} runtimeApi={runtimeApi}>
        {children}
      </AppStateProvider>
    );

    renderHook(() => useLearningServer(), { wrapper });

    await waitFor(() => {
      expect(runtimeApi.connectRuntimeServer).toHaveBeenCalledWith({
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
    const runtimeApi = createMockRuntimeApi();

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider appState={createMockAppState()} runtimeApi={runtimeApi}>
        {children}
      </AppStateProvider>
    );

    const { unmount } = renderHook(
      () => useLearningServer({ autoConnect: false }),
      { wrapper },
    );

    unmount();

    await waitFor(() => {
      expect(runtimeApi.disconnectRuntimeServer).toHaveBeenCalledWith(
        "__learning__",
      );
    });
  });

  it("surfaces the connected runtime entry from shared app state", () => {
    const initInfo = {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
    };
    const appState = createMockAppState({
      servers: {
        __learning__: createServer({
          name: "__learning__",
          config: { url: DEFAULT_LEARNING_SERVER_URL } as any,
          connectionStatus: "connected",
          enabled: true,
          surface: "learning",
          initializationInfo: initInfo,
        }),
      },
    });
    const runtimeApi = createMockRuntimeApi({
      getServerEntry: (name) => appState.servers[name],
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider appState={appState} runtimeApi={runtimeApi}>
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

  it("reconnects when the requested learning server URL changes", async () => {
    let appState = createMockAppState({
      servers: {
        __learning__: createServer({
          name: "__learning__",
          config: { url: DEFAULT_LEARNING_SERVER_URL } as any,
          connectionStatus: "connected",
          enabled: true,
          surface: "learning",
        }),
      },
    });
    const runtimeApi = createMockRuntimeApi({
      getServerEntry: (name) => appState.servers[name],
    });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppStateProvider appState={appState} runtimeApi={runtimeApi}>
        {children}
      </AppStateProvider>
    );

    const { rerender } = renderHook(
      ({ serverUrl }) => useLearningServer({ serverUrl }),
      {
        initialProps: { serverUrl: DEFAULT_LEARNING_SERVER_URL },
        wrapper,
      },
    );

    vi.mocked(runtimeApi.connectRuntimeServer).mockClear();
    appState = createMockAppState({
      servers: {
        __learning__: createServer({
          name: "__learning__",
          config: { url: DEFAULT_LEARNING_SERVER_URL } as any,
          connectionStatus: "connected",
          enabled: true,
          surface: "learning",
        }),
      },
    });
    rerender({ serverUrl: "https://learn.mcpjam.com/alternate" });

    await waitFor(() => {
      expect(runtimeApi.connectRuntimeServer).toHaveBeenCalledWith({
        name: "__learning__",
        config: { url: "https://learn.mcpjam.com/alternate" },
        surface: "learning",
        silent: true,
        select: false,
      });
    });
  });
});
