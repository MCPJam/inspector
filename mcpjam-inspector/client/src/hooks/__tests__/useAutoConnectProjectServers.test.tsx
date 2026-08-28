import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { errorToastMessage } from "@/test/utils";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  PreferencesStoreProvider,
  usePreferencesStore,
} from "@/stores/preferences/preferences-provider";
import { AppStateProvider } from "@/state/app-state-context";
import { ServerActionsProvider } from "@/state/server-actions-context";
import {
  resetAutoConnectAttempts,
  useAutoConnectProjectServers,
} from "../useAutoConnectProjectServers";

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastLoading: vi.fn(() => "reconnect-toast"),
  toastSuccess: vi.fn(),
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    context: "AutoConnectProjectServers",
  },
}));

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    loading: mocks.toastLoading,
    success: mocks.toastSuccess,
  },
}));

vi.mock("@/hooks/use-logger", () => ({
  useLogger: () => mocks.logger,
}));

function makeAppState(serverNames: string[]) {
  return {
    servers: Object.fromEntries(
      serverNames.map((name) => [
        name,
        { name, connectionStatus: "disconnected" },
      ])
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
  markServerRetrying = () => {},
}: {
  children: ReactNode;
  ensureServersReady: (names: string[]) => Promise<{
    readyServerNames: string[];
    failedServerNames: string[];
    missingServerNames: string[];
    reauthServerNames: string[];
  }>;
  appState: ReturnType<typeof makeAppState>;
  runtimeDisconnectServer?: (name: string) => void;
  reconnectServer?: (name: string) => Promise<void>;
  setSelectedServerNames?: (names: string[]) => void;
  markServerRetrying?: (name: string) => void;
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
            markServerRetrying,
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
    mocks.toastError.mockClear();
    mocks.toastLoading.mockClear();
    mocks.toastSuccess.mockClear();
    mocks.logger.error.mockClear();
    mocks.logger.warn.mockClear();
    mocks.logger.info.mockClear();
    mocks.logger.debug.mockClear();
    mocks.logger.trace.mockClear();
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
      }
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
      }
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
      }
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
      }
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["alpha"]);
  });

  it("skips servers parked on needs-auth (only a human can move them)", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: ["alpha"],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "disconnected" },
        // Already established as waiting on authorization. A second
        // non-interactive attempt would take the same 401 and land right
        // back here, so it is pure noise.
        beta: { name: "beta", connectionStatus: "needs-auth" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-needs-auth",
          hostScopeKey: "host-a",
          requiredServerNames: ["alpha", "beta"],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState }),
      }
    );

    await flushMicrotasks();
    expect(ensureServersReady).toHaveBeenCalledTimes(1);
    expect(ensureServersReady).toHaveBeenCalledWith(["alpha"]);
  });

  describe("bounded retry", () => {
    // The retries live INSIDE one logical attempt: `markAttempted` still
    // fires before any connecting, so the "refresh-keeps-failing" guard is
    // untouched. What changes is that a transport blip gets three chances
    // before the card goes red.
    const okResult = (ready: string[] = []) => ({
      readyServerNames: ready,
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const failResult = (failed: string[]) => ({
      readyServerNames: [],
      failedServerNames: failed,
      missingServerNames: [],
      reauthServerNames: [],
    });

    // The backoff sleeps on FAKE timers (installed in beforeEach below);
    // advance them inside `act` so React commits each round without any
    // real waiting. Eight passes of 11s comfortably covers 1s/4s/10s.
    const runBackoff = async () => {
      for (let i = 0; i < 8; i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(11_000);
        });
      }
    };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("retries a transport failure and lands green", async () => {
      const ensureServersReady = vi
        .fn()
        .mockResolvedValueOnce(failResult(["alpha"]))
        .mockResolvedValueOnce(okResult(["alpha"]));
      const markServerRetrying = vi.fn();
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError: "fetch failed",
          },
        },
      } as any;

      renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-retry",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying,
            }),
        }
      );

      await runBackoff();

      expect(ensureServersReady).toHaveBeenCalledTimes(2);
      expect(ensureServersReady).toHaveBeenNthCalledWith(2, ["alpha"]);
      // Counts the attempt so the card can say "Failed (1)". It does not
      // change the server's status — see the reducer test pinning that.
      expect(markServerRetrying).toHaveBeenCalledWith("alpha");
    });

    it("survives the re-render its own connect causes", async () => {
      // THE REGRESSION THIS FILE PREVIOUSLY MISSED. In production
      // `ensureServersReady` moves each server to `connecting` before its
      // request settles. That drops the server out of `candidateNamesKey`,
      // React re-runs this effect, and the old effect's cleanup set a
      // `cancelled` flag — killing the in-flight retry loop before the
      // first backoff had elapsed. Retries were dead in the real app and
      // alive only under fixed-state mocks like the ones around this test.
      const ensureServersReady = vi
        .fn()
        .mockResolvedValueOnce(failResult(["alpha"]))
        .mockResolvedValueOnce(okResult(["alpha"]));

      const failedState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError: "fetch failed",
          },
        },
      } as any;
      // What the reducer actually produces once the connect starts: the
      // server is `connecting`, the candidate filter excludes it, and the
      // memo key flips to null.
      const connectingState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "connecting",
            config: { url: "https://example.com/mcp" },
            lastError: "fetch failed",
          },
        },
      } as any;

      let appState = failedState;
      const { rerender } = renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-rerender",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      // The connect has fired; now the state moves under it.
      appState = connectingState;
      rerender();

      await runBackoff();

      expect(ensureServersReady).toHaveBeenCalledTimes(2);
      expect(ensureServersReady).toHaveBeenNthCalledWith(2, ["alpha"]);
    });

    it("stops retrying when auto-connect is switched off mid-backoff", async () => {
      // A backoff window is up to ten seconds of wall time, and the user
      // can act inside it. Flipping the per-device switch off does not
      // change the project or host scope, so the abandonment token does
      // not fire — without an explicit re-check the loop would finish its
      // wait and dial anyway, overriding what the user just did.
      const ensureServersReady = vi
        .fn()
        .mockResolvedValue(failResult(["alpha"]));
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError: "fetch failed",
          },
        },
      } as any;

      let setEnabled: ((next: boolean) => void) | null = null;
      function PreferenceHandle() {
        setEnabled = usePreferencesStore((s) => s.setAutoConnectServersEnabled);
        return null;
      }

      renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-disabled-midflight",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children: (
                <>
                  <PreferenceHandle />
                  {children}
                </>
              ),
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      // Let the first attempt fail and the first retry be scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      act(() => {
        setEnabled?.(false);
      });
      await runBackoff();

      expect(ensureServersReady).toHaveBeenCalledTimes(1);
    });

    it("drops a server the host stopped requiring mid-backoff", async () => {
      // Same window, different user action: the host's required set can
      // change while we wait. Retrying a server the host no longer wants
      // connects something nobody asked for.
      const ensureServersReady = vi
        .fn()
        .mockResolvedValue(failResult(["alpha", "beta"]));
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/a" },
            lastError: "fetch failed",
          },
          beta: {
            name: "beta",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/b" },
            lastError: "fetch failed",
          },
        },
      } as any;

      let required = ["alpha", "beta"];
      const { rerender } = renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-dropped-midflight",
            hostScopeKey: "host-a",
            requiredServerNames: required,
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      required = ["alpha"];
      rerender();
      await runBackoff();

      // Every retry round is alpha-only; beta is never dialed again.
      const retryCalls = ensureServersReady.mock.calls.slice(1);
      expect(retryCalls.length).toBeGreaterThan(0);
      for (const [names] of retryCalls) {
        expect(names).toEqual(["alpha"]);
      }
    });

    it("re-screens retriability against live state, not the pre-wait reading", async () => {
      // The eligibility re-check is not only about what the HOST wants —
      // the server itself can change during the wait. Here the failure
      // resolves into a protocol-version pin while we sleep, which no
      // retry can fix; the same line also catches a URL edited from
      // https:// to http:// in cloud mode. Screening only before the
      // backoff would spend a round producing the exact red card the
      // pre-batch filter exists to avoid.
      const ensureServersReady = vi
        .fn()
        .mockResolvedValue(failResult(["alpha"]));
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError: "fetch failed",
          },
        },
      } as any;

      const { rerender } = renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-restated-failure",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      // First attempt fails as retriable, so a retry gets scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      // Now the state moves under the sleeping loop.
      appState.servers.alpha = {
        ...appState.servers.alpha,
        lastNormalizedError: { slug: "sdk/protocol_version_pin_unsupported" },
      };
      rerender();
      await runBackoff();

      expect(ensureServersReady).toHaveBeenCalledTimes(1);
    });

    it("stops retrying when the surface unmounts mid-backoff", async () => {
      // Unmount (or a host switch) during the wait genuinely abandons the
      // loop: the user is no longer looking at this project/host, and
      // dialing servers for a surface that is gone is pure waste.
      //
      // Nothing needs un-parking on the way out. The retry only ever bumped
      // a counter — the server is still sitting on `failed`, which is where
      // the last real attempt left it and a perfectly valid state to
      // abandon it in.
      const ensureServersReady = vi
        .fn()
        .mockResolvedValue(failResult(["alpha"]));
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError: "fetch failed",
          },
        },
      } as any;

      const { unmount } = renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-abandon",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      // Let the first attempt fail and the first retry be scheduled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      unmount();
      await runBackoff();

      // Only the original attempt ran; the three backoff rounds did not.
      expect(ensureServersReady).toHaveBeenCalledTimes(1);
    });

    it("gives up after the retry budget", async () => {
      const ensureServersReady = vi.fn().mockResolvedValue(failResult(["alpha"]));
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError: "connection refused",
          },
        },
      } as any;

      renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-retry-exhausted",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      await runBackoff();

      // One initial attempt plus the three-step backoff, then it settles.
      expect(ensureServersReady).toHaveBeenCalledTimes(4);
    });

    it("does NOT retry a protocol-version pin mismatch", async () => {
      // The server has already said it cannot speak the pinned version. It
      // will say the same thing in a second; retrying only delays the card
      // that offers to change the pin.
      const ensureServersReady = vi.fn().mockResolvedValue(failResult(["alpha"]));
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
            lastError:
              'Server "alpha" does not support MCP protocol version 2026-07-28.',
            lastNormalizedError: { slug: "sdk/protocol_version_pin_unsupported" },
          },
        },
      } as any;

      renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-pin",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      await runBackoff();

      expect(ensureServersReady).toHaveBeenCalledTimes(1);
    });

    it("does NOT retry a server that needs authorization", async () => {
      // `reauthServerNames` is its own bucket precisely so this cannot be
      // mistaken for a transport failure: no number of retries produces a
      // human clicking Authorize.
      const ensureServersReady = vi.fn().mockResolvedValue({
        readyServerNames: [],
        failedServerNames: [],
        missingServerNames: [],
        reauthServerNames: ["alpha"],
      });
      const appState = {
        servers: {
          alpha: {
            name: "alpha",
            connectionStatus: "disconnected",
            config: { url: "https://example.com/mcp" },
          },
        },
      } as any;

      renderHook(
        () =>
          useAutoConnectProjectServers({
            projectId: "proj-reauth",
            hostScopeKey: "host-a",
            requiredServerNames: ["alpha"],
          }),
        {
          wrapper: ({ children }) =>
            wrapper({
              children,
              ensureServersReady,
              appState,
              markServerRetrying: vi.fn(),
            }),
        }
      );

      await runBackoff();

      expect(ensureServersReady).toHaveBeenCalledTimes(1);
    });
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
      }
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
      }
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
      }
    );

    await flushMicrotasks();
    expect(reconnectServer).toHaveBeenCalledTimes(3);
    const reconnected = reconnectServer.mock.calls.map((c) => c[0]).sort();
    expect(reconnected).toEqual(["alpha", "beta", "gamma"]);
    // alpha is already connected, so the connect-required candidate path has
    // nothing to do (reconnect, not connect, handles it).
    expect(ensureServersReady).not.toHaveBeenCalled();
  });

  it("logs a single client-switch reconnect failure without toasting", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const reconnectServer = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("beta exploded"));
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "connected" },
        beta: { name: "beta", connectionStatus: "connected" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-reconnect-failure",
          hostScopeKey: "host-a",
          requiredServerNames: [],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      }
    );

    await flushMicrotasks();
    await flushMicrotasks();

    expect(reconnectServer).toHaveBeenCalledTimes(2);
    // The failure is still recorded for us...
    expect(mocks.logger.error).toHaveBeenCalledWith(
      "Failed to reconnect server after client switch",
      { serverName: "beta", error: "beta exploded" }
    );
    // ...but ONE server failing does not interrupt the user's navigation.
    // Its own row goes red, which is where they are already looking.
    expect(mocks.toastError).not.toHaveBeenCalled();
    expect(mocks.toastLoading).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
  });

  it("toasts only when MORE THAN ONE server fails the client-switch recycle", async () => {
    const ensureServersReady = vi.fn().mockResolvedValue({
      readyServerNames: [],
      failedServerNames: [],
      missingServerNames: [],
      reauthServerNames: [],
    });
    const reconnectServer = vi
      .fn()
      .mockRejectedValue(new Error("everything exploded"));
    const appState = {
      servers: {
        alpha: { name: "alpha", connectionStatus: "connected" },
        beta: { name: "beta", connectionStatus: "connected" },
      },
    } as any;

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-reconnect-multi-failure",
          hostScopeKey: "host-a",
          requiredServerNames: [],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      }
    );

    await flushMicrotasks();
    await flushMicrotasks();

    // Several at once usually means the network or the backend, not one bad
    // URL — worth saying out loud.
    expect(mocks.toastError).toHaveBeenCalledWith(
      errorToastMessage("Failed to reconnect 2 servers."),
      { duration: 8000 }
    );
  });

  it("stays silent on a fully successful client switch", async () => {
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

    renderHook(
      () =>
        useAutoConnectProjectServers({
          projectId: "proj-reconnect-progress",
          hostScopeKey: "host-a",
          requiredServerNames: [],
        }),
      {
        wrapper: ({ children }) =>
          wrapper({ children, ensureServersReady, appState, reconnectServer }),
      }
    );

    await flushMicrotasks();
    await flushMicrotasks();

    expect(reconnectServer).toHaveBeenCalledTimes(2);
    // Switching hosts is routine navigation. The rows animate through
    // `connecting` on their own; nothing needs announcing.
    expect(mocks.toastLoading).not.toHaveBeenCalled();
    expect(mocks.toastSuccess).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
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
      }
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
      }
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
      }
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
      }
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
      }
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
      }
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
      }
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
      }
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
