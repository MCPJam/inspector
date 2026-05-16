import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { PreferencesStoreProvider } from "@/stores/preferences/preferences-provider";
import { AppStateProvider } from "@/state/app-state-context";
import { ServerActionsProvider } from "@/state/server-actions-context";
import {
  resetAutoConnectAttempts,
  useAutoConnectProjectServers,
} from "../useAutoConnectProjectServers";

function makeAppState(serverNames: string[]) {
  return {
    servers: Object.fromEntries(
      serverNames.map((name) => [
        name,
        { name, connectionStatus: "disconnected" },
      ]),
    ),
  } as any;
}

function wrapper({
  children,
  ensureServersReady,
  appState,
}: {
  children: ReactNode;
  ensureServersReady: (
    names: string[],
  ) => Promise<{
    readyServerNames: string[];
    failedServerNames: string[];
    missingServerNames: string[];
    reauthServerNames: string[];
  }>;
  appState: ReturnType<typeof makeAppState>;
}) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <AppStateProvider appState={appState}>
        <ServerActionsProvider actions={{ ensureServersReady }}>
          {children}
        </ServerActionsProvider>
      </AppStateProvider>
    </PreferencesStoreProvider>
  );
}

const flushMicrotasks = () => act(() => Promise.resolve());

describe("useAutoConnectProjectServers", () => {
  beforeEach(() => {
    resetAutoConnectAttempts();
    localStorage.removeItem("mcpjam-auto-connect-servers");
  });

  it("calls ensureServersReady once for the same (project, required set) across re-renders", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["alpha", "beta"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const appState = makeAppState(["alpha", "beta"]);

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-1",
          requiredServerNames: ["alpha", "beta"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    rerender();
    await flushMicrotasks();
    rerender();
    await flushMicrotasks();

    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("is a no-op when the required set is empty (host has no required servers)", async () => {
    const ensureServersReady = vi.fn();
    const appState = makeAppState(["alpha"]);

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-empty",
          requiredServerNames: [],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).not.toHaveBeenCalled();
  });

  it("does not call ensureServersReady when the toggle is disabled", async () => {
    localStorage.setItem("mcpjam-auto-connect-servers", "false");
    const ensureServersReady = vi.fn();
    const appState = makeAppState(["alpha"]);

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-disabled",
          requiredServerNames: ["alpha"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).not.toHaveBeenCalled();
  });

  it("skips servers already connected/connecting/oauth-flow", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["alpha"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "disconnected" },
        beta: { name: "beta", connectionStatus: "connected" },
        gamma: { name: "gamma", connectionStatus: "oauth-flow" },
        delta: { name: "delta", connectionStatus: "connecting" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-2",
          requiredServerNames: ["alpha", "beta", "gamma", "delta"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["alpha"]);
  });

  it("never re-attempts after a failure (refresh-keeps-failing guard)", async () => {
    const ensureServersReady = vi.fn().mockRejectedValue(new Error("nope"));
    const appState = makeAppState(["alpha"]);

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-3",
          requiredServerNames: ["alpha"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    rerender();
    await flushMicrotasks();
    rerender();
    await flushMicrotasks();

    expect(ensureServersReady).toHaveBeenCalledTimes(1);
  });
});
