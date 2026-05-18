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
  runtimeDisconnectServer = () => {},
  setSelectedServerNames = () => {},
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
  runtimeDisconnectServer?: (name: string) => void;
  setSelectedServerNames?: (names: string[]) => void;
}) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <AppStateProvider appState={appState}>
        <ServerActionsProvider
          actions={{
            ensureServersReady,
            runtimeDisconnectServer,
            setSelectedServerNames,
          }}
        >
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
          hostScopeKey: "host-a",
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
          hostScopeKey: "host-a",
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
          hostScopeKey: "host-a",
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
          hostScopeKey: "host-a",
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
          hostScopeKey: "host-a",
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

  it("disconnects EVERY connected server on host switch (incl. ones the new host still requires)", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const runtimeDisconnectServer = vi.fn();
    // Three servers connected from a prior host; current host requires only
    // "alpha". With the reconnect-on-host-switch policy, alpha gets torn
    // down alongside beta/gamma; its reconnect fires on the next render
    // once the DISCONNECT dispatch propagates and it re-enters the
    // candidate set (see ensureServersReady call path in use-server-state).
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "connected" },
        beta: { name: "beta", connectionStatus: "connected" },
        gamma: { name: "gamma", connectionStatus: "connected" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-reconcile",
          hostScopeKey: "host-mcpjam-no-required",
          requiredServerNames: ["alpha"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({
            children,
            ensureServersReady,
            appState,
            runtimeDisconnectServer,
          }),
      },
    );

    await flushMicrotasks();
    // Connect side: alpha still looks "connected" in this render's app
    // state, so it's filtered out of the candidate set. In production the
    // next render (after DISCONNECT lands) would pick it up.
    expect(ensureServersReady).not.toHaveBeenCalled();
    // Disconnect side: every connected server comes down, alpha included.
    expect(runtimeDisconnectServer).toHaveBeenCalledTimes(3);
    const disconnected = runtimeDisconnectServer.mock.calls.map((c) => c[0]);
    expect(disconnected.sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  it("disconnects ALL connected servers when the active host requires none (e.g. MCPJam default)", async () => {
    const ensureServersReady = vi.fn();
    const runtimeDisconnectServer = vi.fn();
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "connected" },
        beta: { name: "beta", connectionStatus: "connected" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-empty-required",
          hostScopeKey: "host-mcpjam",
          requiredServerNames: [],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({
            children,
            ensureServersReady,
            appState,
            runtimeDisconnectServer,
          }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).not.toHaveBeenCalled();
    expect(runtimeDisconnectServer).toHaveBeenCalledTimes(2);
    const disconnected = runtimeDisconnectServer.mock.calls.map((c) => c[0]);
    expect(disconnected.sort()).toEqual(["alpha", "beta"]);
  });

  it("syncs setSelectedServerNames to the host's required set on each new scope", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const setSelectedServerNames = vi.fn();
    const appState = makeAppState(["alpha", "beta"]);

    const { rerender } = renderHook(
      ({
        hostScopeKey,
        requiredServerNames,
      }: {
        hostScopeKey: string;
        requiredServerNames: ReadonlyArray<string>;
      }) =>
        useAutoConnectProjectServers({
          projectId: "proj-selection",
          hostScopeKey,
          requiredServerNames,
        }),
      {
        initialProps: {
          hostScopeKey: "host-claude",
          requiredServerNames: ["alpha", "beta"],
        },
        wrapper: ({ children }) =>
          wrapper({
            children,
            ensureServersReady,
            appState,
            setSelectedServerNames,
          }),
      },
    );

    await flushMicrotasks();
    expect(setSelectedServerNames).toHaveBeenLastCalledWith(["alpha", "beta"]);

    // Switch to a host with empty required set → playground selection clears.
    rerender({ hostScopeKey: "host-mcpjam", requiredServerNames: [] });
    await flushMicrotasks();
    expect(setSelectedServerNames).toHaveBeenLastCalledWith([]);
  });

  it("re-attempts on every host transition, including returning to a previously-visited host", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: ["alpha"],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const appState = makeAppState(["alpha"]);

    const { rerender } = renderHook(
      ({ hostScopeKey }: { hostScopeKey: string }) =>
        useAutoConnectProjectServers({
          projectId: "proj-switch",
          hostScopeKey,
          requiredServerNames: ["alpha"],
        }),
      {
        initialProps: { hostScopeKey: "host-a" },
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);

    // Switch hosts: same project, same required names, different scope key.
    // Fresh attempt for the new host.
    rerender({ hostScopeKey: "host-b" });
    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(2);

    // Switching BACK to host-a should re-fire reconciliation — leaving and
    // returning is a user-intent signal to try again, not "already tried
    // forever." This is the bug the user hit: after going through several
    // hosts and coming back, auto-connect stopped firing.
    rerender({ hostScopeKey: "host-a" });
    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(3);
  });

  it("does NOT disconnect a server the user manually connects after the scope's tear-down pass already ran", async () => {
    // Regression: when the user adds a new server from the Servers tab
    // while sitting on a host, the reconciler used to see the freshly-
    // connected server as a fresh disconnect target and tear it down.
    // The host-switch tear-down must fire AT MOST ONCE per scope.
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["learn"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const runtimeDisconnectServer = vi.fn();

    // Mutable holder so we can simulate a server-state change between
    // renders without re-mounting the hook.
    const appStateHolder: { current: any } = {
      current: {
        servers: {
          learn: { name: "learn", connectionStatus: "connected" },
        },
      },
    };

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-manual-add",
          hostScopeKey: "host-learn-only",
          requiredServerNames: ["learn"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({
            children,
            ensureServersReady,
            appState: appStateHolder.current,
            runtimeDisconnectServer,
          }),
      },
    );

    await flushMicrotasks();
    // First pass: every connected server is torn down (including the
    // required `learn`, which will reconnect once its DISCONNECT lands).
    expect(runtimeDisconnectServer).toHaveBeenCalledTimes(1);
    expect(runtimeDisconnectServer).toHaveBeenCalledWith("learn");

    // User manually connects "bench" from the Servers tab — it's not in
    // the host's required list, but the user explicitly wants it connected.
    appStateHolder.current = {
      servers: {
        learn: { name: "learn", connectionStatus: "connected" },
        bench: { name: "bench", connectionStatus: "connected" },
      },
    };

    rerender();
    await flushMicrotasks();

    // Tear-down must NOT re-fire — bench stays connected, and `learn`
    // isn't double-disconnected.
    expect(runtimeDisconnectServer).toHaveBeenCalledTimes(1);
  });

  it("respects a user-initiated disconnect: a host-required server toggled off stays off in the same scope", async () => {
    // Regression: in a dev/inspector tool the user often disconnects a
    // server intentionally (e.g. reproducing a fallback path). The host
    // reconciler must not undo that. Each server in a scope gets at most
    // one auto-connect attempt; once attempted, status changes back to
    // "disconnected" don't re-fire reconciliation.
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["bart"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });

    const appStateHolder: { current: any } = {
      current: {
        servers: {
          bart: { name: "bart", connectionStatus: "disconnected" },
        },
      },
    };

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-user-disconnect",
          hostScopeKey: "host-bart",
          requiredServerNames: ["bart"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({
            children,
            ensureServersReady,
            appState: appStateHolder.current,
          }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["bart"]);

    // Auto-connect succeeded → bart is connected.
    appStateHolder.current = {
      servers: {
        bart: { name: "bart", connectionStatus: "connected" },
      },
    };
    rerender();
    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);

    // User toggles bart off in the Servers tab → status flips back to
    // "disconnected". This must NOT trigger a reconnect, even though bart
    // is in the host's required set.
    appStateHolder.current = {
      servers: {
        bart: { name: "bart", connectionStatus: "disconnected" },
      },
    };
    rerender();
    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
  });

  it("respects user disconnect of one server in a multi-server host (subset of attempted set)", async () => {
    // Regression for the per-set keying bug: with two required servers
    // [bart, foo], the boot batch attempted "bart\0foo". Disconnecting
    // bart left "foo" connected and the candidate set shrank to "bart".
    // Under per-set keying that was a new key and re-fired. Per-server
    // keying suppresses it.
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["bart", "foo"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });

    const appStateHolder: { current: any } = {
      current: {
        servers: {
          bart: { name: "bart", connectionStatus: "disconnected" },
          foo: { name: "foo", connectionStatus: "disconnected" },
        },
      },
    };

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-user-disconnect-multi",
          hostScopeKey: "host-multi",
          requiredServerNames: ["bart", "foo"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({
            children,
            ensureServersReady,
            appState: appStateHolder.current,
          }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["bart", "foo"]);

    // Both connected.
    appStateHolder.current = {
      servers: {
        bart: { name: "bart", connectionStatus: "connected" },
        foo: { name: "foo", connectionStatus: "connected" },
      },
    };
    rerender();
    await flushMicrotasks();

    // User disconnects bart only.
    appStateHolder.current = {
      servers: {
        bart: { name: "bart", connectionStatus: "disconnected" },
        foo: { name: "foo", connectionStatus: "connected" },
      },
    };
    rerender();
    await flushMicrotasks();

    expect(ensureServersReady).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-fire while sitting on the same host (refresh-keeps-failing guard preserved)", async () => {
    const ensureServersReady = vi.fn().mockRejectedValue(new Error("boom"));
    const appState = makeAppState(["alpha"]);

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-sit",
          hostScopeKey: "host-a",
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

    // Still only one attempt — re-renders without a scope change don't
    // re-fire, so a permanently-failing connection won't loop.
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
  });
});
