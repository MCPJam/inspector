import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APP_LEASE_MS,
  APP_LEASE_RENEW_INTERVAL_MS,
  useThreadAppWorkspace,
} from "../ThreadAppPanel";
import { ThreadAppError } from "../thread-app-api";
const f = vi.hoisted(() => ({
  discover: vi.fn(),
  open: vi.fn(),
  invoke: vi.fn(),
  close: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../extension-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../extension-log")>()),
  logExtensionEvent: f.log,
}));
vi.mock("../thread-app-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../thread-app-api")>()),
  createThreadAppApi: () => ({
    ...f,
    // Discovery reads entries and the server's own facts in one call.
    discoverServer: async (...args: unknown[]) => ({
      entries: await f.discover(...args),
      mentions: { available: false },
      mentionsReported: true,
    }),
  }),
}));
vi.mock("@mcpjam/widget-react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mcpjam/widget-react")>()),
  WidgetWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
  WidgetWorkspaceSurfaceHost: () => null,
  useWidgetWorkspace: () => ({}),
  closeWorkspaceSurface: vi.fn(),
  useWidgetSurfaceAdmissionError: () => null,
}));
vi.mock("@/components/chat-v2/thread/mcp-apps/use-widget-host", () => ({
  useWidgetHost: () => ({}),
}));
vi.mock("@/components/tools/ResultsPanel", () => ({
  ResultsPanel: () => null,
}));
vi.mock("../server-settings-api", () => ({
  createServerSettingsApi: () => ({ discover: async () => false }),
}));
const scope = {
  projectId: "project",
  hostId: "client",
  threadId: "thread",
  pluginWorkspace: { version: 1 as const, workspaceId: "workspace" },
};
const servers = [{ serverId: "saved", name: "Saved server" }];
const declaration = { toolName: "app", title: "App", kind: "thread" as const };
const handle = {
  instanceToken: "original",
  instanceId: "instance",
  operationId: "operation",
};
describe("caller-owned thread App lifetime", () => {
  afterEach(async () => {
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  beforeEach(() => {
    vi.clearAllMocks();
    f.discover.mockResolvedValue([declaration]);
    f.open.mockResolvedValue(handle);
    f.invoke.mockResolvedValue({ content: [] });
    f.close.mockResolvedValue(undefined);
  });
  it("acknowledges local navigation after admission while slow activation remains owned", async () => {
    let finish!: (value: { content: never[] }) => void;
    f.invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    const file = {
      ...declaration,
      kind: "file" as const,
      resourceUri: "cad://part",
    };
    await act(async () => {
      await result.current.launch(servers[0], file, undefined, true);
    });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    // An unresolved activation can exceed any guest RPC budget: its acceptance
    // has already returned, without mounting/executing a second destination.
    await act(async () => {
      await result.current.launch(servers[0], file, undefined, true);
    });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish({ content: [] });
    });
    await act(async () => result.current.launch(servers[0], file));
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("refuses failed destination admission before activation", async () => {
    f.open.mockRejectedValueOnce(new Error("Denied target"));
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await expect(
        result.current.launch(servers[0], declaration, undefined, true),
      ).rejects.toThrow("Denied target");
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("observes late activation failure in its retained error row", async () => {
    let fail!: (error: Error) => void;
    f.invoke.mockImplementation(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () =>
      result.current.launch(servers[0], declaration, undefined, true),
    );
    await act(async () => {
      fail(new Error("App loading failed"));
    });
    const panel = result.current.panel as any;
    const row = panel.props.children[0].props.children.props.apps[0];
    expect(row.status).toBe("error");
    expect(row.error).toBe("Couldn’t open this App. Try again.");
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("keeps accepted loading navigation cancellable by explicit close", async () => {
    let fail!: (error: Error) => void;
    let executionSignal!: AbortSignal;
    f.invoke.mockImplementation((_handle, signal) => {
      executionSignal = signal;
      return new Promise((_, reject) => {
        fail = reject;
      });
    });
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () =>
      result.current.launch(servers[0], declaration, undefined, true),
    );
    const panel = result.current.panel as any;
    const row = panel.props.children[0].props.children.props.apps[0];
    await act(async () => {
      await result.current.close(row);
    });
    expect(executionSignal.aborted).toBe(true);
    expect(f.close).toHaveBeenCalledWith(handle, expect.any(AbortSignal));
    await act(async () => {
      fail(new Error("Cancelled loading"));
    });
    expect(result.current.open).toBe(false);
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
  it("refuses admission delivered after the original owner closes", async () => {
    let finish!: (value: typeof handle) => void;
    f.open.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ owner }) => useThreadAppWorkspace(owner, servers),
      { initialProps: { owner: scope } },
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.launch(servers[0], declaration, undefined, true);
    });
    const refusal = expect(pending).rejects.toBeDefined();
    rerender({ owner: { ...scope, hostId: "replacement" } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await act(async () => {
      finish(handle);
      await refusal;
    });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("navigates the retained global instance without another activation", async () => {
    const global = { ...declaration, kind: "global" as const };
    f.discover.mockResolvedValue([global]);
    f.open.mockImplementation(async (_server, _tool, _signal, _kind, link) => ({
      ...handle,
      generation: 1,
      ...(link ? { deepLink: { url: "/parts" } } : {}),
    }));
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await waitFor(() =>
      expect(result.current.menus[servers[0].name]).toBeDefined(),
    );
    await act(async () => {
      await result.current.launch(servers[0], global);
    });
    await act(async () => {
      await result.current.navigateDeepLink(
        servers[0],
        "chatgpt://plugins/p/app/app?path=%2Fparts",
      );
    });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
  });
  it("keeps flag-off renders inert when callers project fresh server arrays", () => {
    const { result, rerender } = renderHook(() =>
      useThreadAppWorkspace(null, [...servers]),
    );
    for (let i = 0; i < 5; i++) rerender();
    expect(result.current.menus).toEqual({});
    expect(result.current.open).toBe(false);
    expect(f.discover).not.toHaveBeenCalled();
    expect(f.open).not.toHaveBeenCalled();
  });
  it("does not rediscover or close retained Apps for equivalent server projections", async () => {
    const { result, rerender } = renderHook(() =>
      useThreadAppWorkspace(
        scope,
        servers.map((server) => ({ ...server })),
      ),
    );
    await waitFor(() => expect(f.discover).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    for (let i = 0; i < 5; i++) rerender();
    expect(f.discover).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    expect(result.current.open).toBe(true);
  });
  it("coalesces concurrent launch and cached reopen without repeated execution", async () => {
    const { result, unmount } = renderHook(() =>
      useThreadAppWorkspace(scope, servers),
    );
    await waitFor(() =>
      expect(result.current.menus[servers[0].name]).toBeDefined(),
    );
    await act(async () => {
      await Promise.all([
        result.current.launch(servers[0], declaration),
        result.current.launch(servers[0], declaration),
      ]);
    });
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.close).not.toHaveBeenCalled();
    unmount();
    await waitFor(() =>
      expect(f.close).toHaveBeenCalledWith(handle, expect.any(AbortSignal)),
    );
  });
  it("retains separate global and thread instances of the same tool", async () => {
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    const global = { ...declaration, kind: "global" as const };
    const selected = () =>
      result.current.apps.find((row) => row.key === result.current.active)
        ?.declaration.kind;
    await act(async () => result.current.launch(servers[0], global));
    expect(selected()).toBe("global");
    await act(async () => result.current.launch(servers[0], declaration));
    expect(selected()).toBe("thread");
    await act(async () => result.current.launch(servers[0], global));
    expect(selected()).toBe("global");
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    expect(f.open.mock.calls.map((call) => call[3])).toEqual([
      "global",
      "thread",
    ]);
  });
  it("retries failed delivery with the original immutable handle", async () => {
    f.invoke
      .mockRejectedValueOnce(new Error("response unknown"))
      .mockResolvedValue({ content: [] });
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls.map((call) => call[0])).toEqual([
      handle,
      handle,
    ]);
  });
  it("keeps deliberate approval denial terminal until the App is closed", async () => {
    f.invoke.mockRejectedValue(new ThreadAppError("APPROVAL_DENIED"));
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => result.current.launch(servers[0], declaration));
    await act(async () => result.current.launch(servers[0], declaration));
    expect(f.open).toHaveBeenCalledTimes(1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(result.current.open).toBe(true);
    expect(f.close).not.toHaveBeenCalled();
  });
  it("ends ownership when the server is removed, while stale discovery is ignored", async () => {
    let deliver!: (value: unknown) => void;
    f.discover.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deliver = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ enabled }) => useThreadAppWorkspace(scope, enabled),
      { initialProps: { enabled: servers } },
    );
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    rerender({ enabled: [] });
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    await act(async () => deliver([declaration]));
    expect(result.current.menus).toEqual({});
  });
  it("ignores a late discovery retry after the owner or enabled servers change", async () => {
    for (const change of ["servers", "owner"] as const) {
      let deliver!: (value: unknown) => void;
      f.discover
        .mockRejectedValueOnce(new Error("discovery unavailable"))
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              deliver = resolve;
            }),
        );
      const { result, rerender, unmount } = renderHook(
        ({ owner, enabled }) => useThreadAppWorkspace(owner, enabled),
        { initialProps: { owner: scope, enabled: servers } },
      );
      await waitFor(() =>
        expect(result.current.menus[servers[0].name]).toBeDefined(),
      );
      let retry!: Promise<void>;
      act(() => {
        retry = result.current.retryDiscovery(servers[0].serverId);
      });
      const signal = f.discover.mock.calls.at(-1)![1] as AbortSignal;
      rerender({
        owner: change === "owner" ? { ...scope, hostId: "replacement" } : scope,
        enabled: [],
      });
      expect(signal.aborted).toBe(true);
      await act(async () => {
        deliver([declaration]);
        await retry;
      });
      expect(result.current.menus).toEqual({});
      unmount();
    }
  });
  it("does not reopen an old failed close inside a replacement owner", async () => {
    let reject!: (error: Error) => void;
    f.close.mockImplementationOnce(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const { result, rerender } = renderHook(
      ({ owner, enabled }) => useThreadAppWorkspace(owner, enabled),
      { initialProps: { owner: scope, enabled: servers } },
    );
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    rerender({ owner: scope, enabled: [] });
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    rerender({ owner: { ...scope, hostId: "replacement" }, enabled: [] });
    await act(async () => {
      reject(new Error("cleanup unavailable"));
    });
    expect(result.current.open).toBe(false);
  });
  it("keeps one owner through StrictMode effect replay and closes on identity change", async () => {
    const { result, rerender } = renderHook(
      ({ owner }) => useThreadAppWorkspace(owner, servers),
      {
        initialProps: { owner: scope },
        wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
      },
    );
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    expect(f.close).not.toHaveBeenCalled();
    rerender({
      owner: {
        ...scope,
        hostId: "another-client",
        pluginWorkspace: { version: 1, workspaceId: "another-workspace" },
      },
    });
    await waitFor(() => expect(f.close).toHaveBeenCalledTimes(1));
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
});

describe("retained App leases", () => {
  const fakeClock = () =>
    vi.useFakeTimers({
      toFake: [
        "setInterval",
        "clearInterval",
        "setTimeout",
        "clearTimeout",
        "Date",
      ],
    });
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const leased = (extra: Record<string, unknown> = {}) => ({
    ...handle,
    expiresAt: Date.now() + APP_LEASE_MS,
    ...extra,
  });
  beforeEach(() => {
    vi.clearAllMocks();
    f.discover.mockResolvedValue([declaration]);
    f.open.mockResolvedValue(handle);
    f.invoke.mockResolvedValue({ content: [] });
    f.close.mockResolvedValue(undefined);
  });
  afterEach(async () => {
    vi.useRealTimers();
    cleanup();
    // Let the owner's deferred close finish inside this test.
    await new Promise((resolve) => setTimeout(resolve, 10));
    delete (f as Record<string, unknown>).renew;
  });
  it("renews every retained App (shown or hidden) until it closes or its owner goes", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const renew = vi.fn(async () => ({ expiresAt: Date.now() + APP_LEASE_MS }));
    (f as Record<string, unknown>).renew = renew;
    const { result, rerender } = renderHook(
      ({ owner }) => useThreadAppWorkspace(owner, servers),
      { initialProps: { owner: scope } },
    );
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    // File viewers and quick-action Apps renew like thread Apps.
    const file = { ...handle, instanceToken: "file-token" };
    const action = { ...handle, instanceToken: "action-token" };
    f.open.mockResolvedValueOnce(file).mockResolvedValueOnce(action);
    await act(async () => {
      await result.current.launch(servers[0], {
        ...declaration,
        kind: "file",
        resourceUri: "cad://part",
      });
    });
    await act(async () => {
      await result.current.launch(servers[0], {
        ...declaration,
        toolName: "action",
        kind: "quick-action",
      });
    });
    // Hidden, still renewed.
    act(() => result.current.select(null));
    await act(async () => {
      vi.advanceTimersByTime(APP_LEASE_RENEW_INTERVAL_MS);
    });
    expect(renew.mock.calls.map((call) => call[0])).toEqual([
      handle,
      file,
      action,
    ]);
    for (const row of [...result.current.apps])
      await act(async () => {
        await result.current.close(row);
      });
    await act(async () => {
      vi.advanceTimersByTime(APP_LEASE_RENEW_INTERVAL_MS);
    });
    expect(renew).toHaveBeenCalledTimes(3);
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    rerender({ owner: { ...scope, hostId: "another-client" } });
    await act(async () => {
      vi.advanceTimersByTime(APP_LEASE_RENEW_INTERVAL_MS * 3);
    });
    // The new owner has nothing retained; the old one stopped.
    expect(renew).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["quick-action App", { toolName: "action", kind: "quick-action" as const }, {}],
    [
      "read-only file viewer",
      { kind: "file" as const, resourceUri: "cad://part" },
      { fileCapabilities: { write: false, subscribe: false } },
    ],
    [
      // Its file grant renews with its lease: unsaved edits survive.
      "writable file viewer",
      { kind: "file" as const, resourceUri: "cad://part" },
      { fileCapabilities: { write: true, subscribe: false } },
    ],
  ])(
    "keeps a %s live past 30 minutes on its first activation",
    async (_, entry, extra) => {
      fakeClock();
      const renew = vi.fn(async () => ({
        expiresAt: Date.now() + APP_LEASE_MS,
      }));
      (f as Record<string, unknown>).renew = renew;
      f.open.mockResolvedValue(leased(extra));
      const { result } = renderHook(() =>
        useThreadAppWorkspace(scope, servers),
      );
      const app = { ...declaration, ...entry };
      await act(async () => {
        await result.current.launch(servers[0], app);
      });
      act(() => result.current.select(null));
      await advance(APP_LEASE_RENEW_INTERVAL_MS * 5);
      expect(renew).toHaveBeenCalledTimes(5);
      act(() => result.current.select(result.current.apps[0].key));
      await advance(0);
      expect(result.current.apps[0]).toMatchObject({
        status: "live",
        handle: { instanceToken: handle.instanceToken },
      });
      expect(f.open).toHaveBeenCalledOnce();
      expect(f.invoke).toHaveBeenCalledOnce();
      expect(f.close).not.toHaveBeenCalled();
    },
  );

  it.each(["deadline", "INSTANCE_UNAVAILABLE"])(
    "keeps a writable file viewer mounted with its edits when its session ends (%s)",
    async (cause) => {
      fakeClock();
      (f as Record<string, unknown>).renew = vi.fn(async () => {
        throw cause === "deadline"
          ? new Error("offline")
          : new ThreadAppError("INSTANCE_UNAVAILABLE");
      });
      const writable = { fileCapabilities: { write: true, subscribe: false } };
      f.open.mockResolvedValueOnce(
        leased({ ...writable, instanceToken: "file-1" }),
      );
      const { result } = renderHook(() =>
        useThreadAppWorkspace(scope, servers),
      );
      const viewer = {
        ...declaration,
        kind: "file" as const,
        resourceUri: "cad://part",
      };
      await act(async () => {
        await result.current.launch(servers[0], viewer);
      });
      const key = result.current.apps[0].key;
      await advance(
        cause === "deadline" ? APP_LEASE_MS + 1 : APP_LEASE_RENEW_INTERVAL_MS,
      );
      // Still mounted on the same activation: the edits live in the App.
      expect(result.current.apps[0]).toMatchObject({
        status: "live",
        leaseEnded: true,
        handle: { instanceToken: "file-1" },
      });
      expect(f.log).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "lease",
          level: "warning",
          message: expect.stringContaining("unsaved changes are still in the viewer"),
        }),
      );
      expect(f.close).not.toHaveBeenCalled();
      // Nothing replaces it behind the user's back: not selecting it, not
      // opening the same file again, not more time passing.
      act(() => result.current.select(null));
      act(() => result.current.select(key));
      await act(async () => {
        await result.current.launch(servers[0], viewer);
      });
      await advance(APP_LEASE_RENEW_INTERVAL_MS * 3);
      expect(f.open).toHaveBeenCalledOnce();
      expect(result.current.apps[0].handle?.instanceToken).toBe("file-1");
      expect(
        f.log.mock.calls.filter(([event]) => event.label === "lease"),
      ).toHaveLength(1);
      // Closing it is the user's call; the file then opens fresh.
      f.close.mockRejectedValueOnce(new ThreadAppError("INSTANCE_UNAVAILABLE"));
      await act(async () => {
        await result.current.close(result.current.apps[0]);
      });
      f.open.mockResolvedValueOnce(
        leased({ ...writable, instanceToken: "file-2" }),
      );
      await act(async () => {
        await result.current.launch(servers[0], viewer);
      });
      expect(result.current.apps[0]).toMatchObject({
        status: "live",
        handle: { instanceToken: "file-2" },
      });
    },
  );

  it.each(["deadline", "INSTANCE_UNAVAILABLE"])(
    "relaunches an expired tab when it is selected (%s)",
    async (cause) => {
      fakeClock();
      (f as Record<string, unknown>).renew = vi.fn(async () => {
        throw cause === "deadline"
          ? new Error("offline")
          : new ThreadAppError("INSTANCE_UNAVAILABLE");
      });
      f.open.mockResolvedValueOnce(leased({ instanceToken: "first" }));
      const { result } = renderHook(() =>
        useThreadAppWorkspace(scope, servers),
      );
      await act(async () => {
        await result.current.launch(servers[0], declaration);
      });
      const key = result.current.apps[0].key;
      act(() => result.current.select(null));
      await advance(
        cause === "deadline" ? APP_LEASE_MS + 1 : APP_LEASE_RENEW_INTERVAL_MS,
      );
      // Hidden and expired: unmounted, nothing reopened behind the user's back.
      expect(result.current.apps[0].handle).toBeUndefined();
      expect(f.open).toHaveBeenCalledOnce();
      f.open.mockResolvedValueOnce(leased({ instanceToken: "second" }));
      act(() => result.current.select(key));
      await advance(0);
      expect(f.open).toHaveBeenCalledTimes(2);
      expect(result.current.apps[0]).toMatchObject({
        status: "live",
        handle: { instanceToken: "second" },
      });
      expect(f.invoke.mock.calls.map((call) => call[0].instanceToken)).toEqual(
        ["first", "second"],
      );
    },
  );

  it("never reuses an expired handle when the App is launched again", async () => {
    fakeClock();
    (f as Record<string, unknown>).renew = vi.fn(async () => {
      throw new Error("offline");
    });
    f.open.mockResolvedValueOnce(leased({ instanceToken: "first" }));
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    // Past the deadline before its timer could run (a sleeping laptop).
    vi.setSystemTime(Date.now() + APP_LEASE_MS + 1);
    f.open.mockResolvedValueOnce(leased({ instanceToken: "second" }));
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    expect(f.open).toHaveBeenCalledTimes(2);
    expect(result.current.apps[0].handle?.instanceToken).toBe("second");
  });

  it("finishes closing an App whose session already ended", async () => {
    f.close.mockRejectedValueOnce(new ThreadAppError("INSTANCE_UNAVAILABLE"));
    const { result } = renderHook(() => useThreadAppWorkspace(scope, servers));
    await act(async () => {
      await result.current.launch(servers[0], declaration);
    });
    await act(async () => {
      await result.current.close(result.current.apps[0]);
    });
    expect(result.current.apps).toEqual([]);
  });
});
