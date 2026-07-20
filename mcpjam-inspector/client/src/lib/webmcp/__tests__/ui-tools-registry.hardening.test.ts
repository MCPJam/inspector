import { beforeEach, describe, expect, it, vi } from "vitest";

const { mirrorUiToolToNativeMock } = vi.hoisted(() => ({
  mirrorUiToolToNativeMock: vi.fn(),
}));

vi.mock("../native-mirror", () => ({
  mirrorUiToolToNative: mirrorUiToolToNativeMock,
}));

import {
  useUiToolsRegistry,
  type UiToolDefinition,
} from "../ui-tools-registry";
import { waitForUiToolNames } from "../ui-tools-readiness";

function makeTool(name: string, extra?: Partial<UiToolDefinition>): UiToolDefinition {
  return {
    name,
    description: `Test tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    readOnly: false,
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }],
    })),
    ...extra,
  };
}

function resetRegistry() {
  useUiToolsRegistry.setState({
    tools: new Map(),
    nativeDisposers: new Map(),
    globalNames: new Set(),
    shippedNames: new Set(),
  });
}

describe("ownership-guarded unregistration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorUiToolToNativeMock.mockReturnValue(null);
    resetRegistry();
  });

  it("a stale unregister closure never removes the replacement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disposeA = vi.fn();
    const disposeB = vi.fn();
    mirrorUiToolToNativeMock
      .mockReturnValueOnce(disposeA)
      .mockReturnValueOnce(disposeB);
    const a = makeTool("ui_navigate");
    const b = makeTool("ui_navigate");
    const unregisterA = useUiToolsRegistry.getState().registerUiTool(a);
    const unregisterB = useUiToolsRegistry.getState().registerUiTool(b);
    expect(disposeA).toHaveBeenCalledTimes(1); // disposed at replace time

    unregisterA(); // stale: B owns the name now — must be a no-op
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(b);
    expect(disposeB).not.toHaveBeenCalled();

    unregisterB();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBeNull();
    expect(disposeB).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("a stale abort never removes the replacement", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const disposeB = vi.fn();
    mirrorUiToolToNativeMock
      .mockReturnValueOnce(vi.fn())
      .mockReturnValueOnce(disposeB);
    const controllerA = new AbortController();
    const a = makeTool("ui_navigate");
    const b = makeTool("ui_navigate");
    useUiToolsRegistry
      .getState()
      .registerUiTool(a, { signal: controllerA.signal });
    const unregisterB = useUiToolsRegistry.getState().registerUiTool(b);

    controllerA.abort(); // A's abort fires after B replaced it
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(b);
    expect(disposeB).not.toHaveBeenCalled();

    unregisterB();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBeNull();
    expect(disposeB).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("StrictMode setup→cleanup→setup leaves one live registration, no warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // StrictMode/HMR rebuild the definition object on each setup; cleanup
    // runs BEFORE the re-setup, so no live collision (and no throw/warn).
    const cleanup = useUiToolsRegistry
      .getState()
      .registerUiTool(makeTool("ui_navigate"));
    cleanup();
    const second = makeTool("ui_navigate");
    useUiToolsRegistry.getState().registerUiTool(second);

    expect(useUiToolsRegistry.getState().tools.size).toBe(1);
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(second);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("globals-first snapshot ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorUiToolToNativeMock.mockReturnValue(null);
    resetRegistry();
  });

  it("emits all global-scope tools before any surface-scope tools", () => {
    const registry = useUiToolsRegistry.getState();
    // Surface tools register FIRST (a surface's useLayoutEffect can beat
    // App's useEffect); globals must still lead the snapshot.
    registry.registerUiTool(makeTool("ui_surface_a"));
    registry.registerUiTool(makeTool("ui_surface_b"), { scope: "surface" });
    registry.registerUiTool(makeTool("ui_global_a"), { scope: "global" });
    registry.registerUiTool(makeTool("ui_global_b"), { scope: "global" });

    expect(registry.snapshotForChatBody().map((t) => t.name)).toEqual([
      "ui_global_a",
      "ui_global_b",
      "ui_surface_a",
      "ui_surface_b",
    ]);
  });

  it("overflow keeps ALL globals inside the surviving 64", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = useUiToolsRegistry.getState();
    for (let i = 0; i < 60; i++) {
      registry.registerUiTool(makeTool(`ui_surface_${i}`));
    }
    for (let i = 0; i < 10; i++) {
      registry.registerUiTool(makeTool(`ui_global_${i}`), { scope: "global" });
    }

    const names = registry.snapshotForChatBody().map((t) => t.name);
    expect(names).toHaveLength(64);
    expect(names.slice(0, 10)).toEqual(
      Array.from({ length: 10 }, (_, i) => `ui_global_${i}`),
    );
    expect(names.slice(10)).toEqual(
      Array.from({ length: 54 }, (_, i) => `ui_surface_${i}`),
    );
    warn.mockRestore();
  });

  it("a replacement's scope wins over the replaced registration's", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const registry = useUiToolsRegistry.getState();
    registry.registerUiTool(makeTool("ui_navigate"), { scope: "global" });
    registry.registerUiTool(makeTool("ui_navigate")); // replace as surface
    registry.registerUiTool(makeTool("ui_select_server"), { scope: "global" });

    expect(registry.snapshotForChatBody().map((t) => t.name)).toEqual([
      "ui_select_server",
      "ui_navigate",
    ]);
    warn.mockRestore();
  });
});

describe("waitForUiToolNames", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorUiToolToNativeMock.mockReturnValue(null);
    resetRegistry();
  });

  /** Wrap subscribe so tests can assert every subscription was detached. */
  function trackSubscriptions() {
    const realSubscribe = useUiToolsRegistry.subscribe.bind(useUiToolsRegistry);
    const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
    const spy = vi
      .spyOn(useUiToolsRegistry, "subscribe")
      .mockImplementation((listener) => {
        const unsubscribe = vi.fn(realSubscribe(listener));
        unsubscribers.push(unsubscribe);
        return unsubscribe;
      });
    return { spy, unsubscribers };
  }

  it("resolves true immediately (no subscription) when already present", async () => {
    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_navigate"));
    const { spy } = trackSubscriptions();
    await expect(waitForUiToolNames(["ui_navigate"], 1000)).resolves.toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resolves true immediately for an empty name list", async () => {
    await expect(waitForUiToolNames([], 5)).resolves.toBe(true);
  });

  it("resolves true when the last missing name registers, and unsubscribes", async () => {
    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_navigate"));
    const { spy, unsubscribers } = trackSubscriptions();
    const wait = waitForUiToolNames(["ui_navigate", "ui_select_server"], 1000);
    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_select_server"));

    await expect(wait).resolves.toBe(true);
    expect(unsubscribers).toHaveLength(1);
    expect(unsubscribers[0]).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("resolves false after the timeout, and unsubscribes", async () => {
    const { unsubscribers, spy } = trackSubscriptions();
    await expect(waitForUiToolNames(["ui_never_mounts"], 25)).resolves.toBe(
      false,
    );
    expect(unsubscribers).toHaveLength(1);
    expect(unsubscribers[0]).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it("ignores unrelated registrations while waiting", async () => {
    const wait = waitForUiToolNames(["ui_never_mounts"], 25);
    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_navigate"));
    await expect(wait).resolves.toBe(false);
  });

  it("a shared def object registered twice: stale cleanup doesn't remove the live one", () => {
    // Two registrars share ONE UiToolDefinition object (module-level def).
    const shared = makeTool("ui_navigate");
    const unregA = useUiToolsRegistry.getState().registerUiTool(shared);
    // B re-registers the SAME object (prod warn+replace path, MODE!=development).
    const unregB = useUiToolsRegistry.getState().registerUiTool(shared);
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(shared);
    // A's stale cleanup must NOT remove B's live registration (token guard).
    unregA();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(shared);
    // B's own cleanup removes it.
    unregB();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBeNull();
  });
});
