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
  reconnectServer = async () => {},
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
  reconnectServer?: (name: string) => Promise<void>;
  setSelectedServerNames?: (names: string[]) => void;
}) {
  return (
    <PreferencesStoreProvider themeMode="light" themePreset="default">
      <AppStateProvider appState={appState}>
        <ServerActionsProvider
          actions={{
            ensureServersReady,
            runtimeDisconnectServer,
            reconnectServer,
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

  it("re-attempts after the project auto-connect toggle resets attempts", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["alpha"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const appState = makeAppState(["alpha"]);

    const { rerender } = renderHook(
      ({ requiredServerNames }: { requiredServerNames: string[] }) =>
        useAutoConnectProjectServers({
          projectId: "proj-toggle",
          hostScopeKey: "host-a",
          requiredServerNames,
        }),
      {
        initialProps: { requiredServerNames: ["alpha"] },
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      },
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);

    rerender({ requiredServerNames: [] });
    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);

    resetAutoConnectAttempts("proj-toggle");
    rerender({ requiredServerNames: ["alpha"] });
    await flushMicrotasks();

    expect(ensureServersReady).toHaveBeenCalledTimes(2);
    expect(ensureServersReady).toHaveBeenLastCalledWith(["alpha"]);
  });

  it("reconnects ALL connected servers on client switch, not just the required ones", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const reconnectServer = vi.fn().mockResolvedValue(undefined);
    // Three servers connected from a prior client; current client requires
    // only "alpha". Switching clients must re-handshake EVERY connected server
    // under the new client identity — so all three reconnect, regardless of
    // whether the host declares them required.
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
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      },
    );

    await flushMicrotasks();
    expect(reconnectServer).toHaveBeenCalledTimes(3);
    const reconnected = reconnectServer.mock.calls.map((c) => c[0]).sort();
    expect(reconnected).toEqual(["alpha", "beta", "gamma"]);
    // alpha is already connected, so the connect-required candidate path has
    // nothing to do (reconnect, not connect, handles it).
    expect(ensureServersReady).not.toHaveBeenCalled();
  });

  it("reconnects connected servers even when the active host requires none", async () => {
    const ensureServersReady = vi.fn();
    const reconnectServer = vi.fn().mockResolvedValue(undefined);
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
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      },
    );

    await flushMicrotasks();
    // Recycle is gated on a client being active (hostScopeKey non-null), not on
    // the required set. Both connected servers re-handshake.
    expect(reconnectServer).toHaveBeenCalledTimes(2);
    const reconnected = reconnectServer.mock.calls.map((c) => c[0]).sort();
    expect(reconnected).toEqual(["alpha", "beta"]);
  });

  it("still auto-connects required-but-disconnected servers on top of the recycle", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["needed"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const reconnectServer = vi.fn().mockResolvedValue(undefined);
    // "up" is connected (gets reconnected); "needed" is required but not
    // connected (gets connected via the candidate path).
    const appState = {
      servers: {
        up: { name: "up", connectionStatus: "connected" },
        needed: { name: "needed", connectionStatus: "disconnected" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-mixed",
          hostScopeKey: "host-a",
          requiredServerNames: ["needed"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      },
    );

    await flushMicrotasks();
    expect(reconnectServer).toHaveBeenCalledTimes(1);
    expect(reconnectServer).toHaveBeenCalledWith("up");
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["needed"]);
  });

  it("does not recycle again on a same-scope re-render (only lead changes recycle)", async () => {
    // Adding/removing a SECONDARY compare client doesn't change hostScopeKey
    // (only the lead does), so a same-scope re-render must not re-reconnect.
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const reconnectServer = vi.fn().mockResolvedValue(undefined);
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "connected" },
        beta: { name: "beta", connectionStatus: "connected" },
      },
    } as any;

    const { rerender } = renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-same-scope",
          hostScopeKey: "host-lead",
          requiredServerNames: ["alpha"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      },
    );

    await flushMicrotasks();
    expect(reconnectServer).toHaveBeenCalledTimes(2);

    rerender();
    await flushMicrotasks();
    // Same scope → no second recycle.
    expect(reconnectServer).toHaveBeenCalledTimes(2);
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

  it("does NOT reconnect a server the user manually connects after the scope's recycle pass already ran", async () => {
    // When the user adds a new server from the Servers tab while sitting on a
    // host, it connected fresh under the CURRENT client — so the recycle must
    // not re-handshake it. The recycle fires AT MOST ONCE per scope.
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["learn"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const reconnectServer = vi.fn().mockResolvedValue(undefined);

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
            reconnectServer,
          }),
      },
    );

    await flushMicrotasks();
    // First pass: the connected server re-handshakes under the new client.
    expect(reconnectServer).toHaveBeenCalledTimes(1);
    expect(reconnectServer).toHaveBeenCalledWith("learn");

    // User manually connects "bench" from the Servers tab — fresh under the
    // current client, so it must NOT be recycled.
    appStateHolder.current = {
      servers: {
        learn: { name: "learn", connectionStatus: "connected" },
        bench: { name: "bench", connectionStatus: "connected" },
      },
    };

    rerender();
    await flushMicrotasks();

    // Recycle must NOT re-fire — bench is left alone, learn isn't reconnected
    // twice.
    expect(reconnectServer).toHaveBeenCalledTimes(1);
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
