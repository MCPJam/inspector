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
    shippedNames: new Set(),
  });
}

describe("useUiToolsRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorUiToolToNativeMock.mockReturnValue(null);
    resetRegistry();
  });

  it("registers, resolves, and unregisters tools", () => {
    const def = makeTool("ui_navigate");
    const unregister = useUiToolsRegistry.getState().registerUiTool(def);

    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(def);
    unregister();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBeNull();
  });

  it("rejects names outside the reserved ui_ shape loudly", () => {
    expect(() =>
      useUiToolsRegistry.getState().registerUiTool(makeTool("navigate")),
    ).toThrow(/must match ui_/);
    expect(() =>
      useUiToolsRegistry.getState().registerUiTool(makeTool("ui_Bad-Name")),
    ).toThrow(/must match ui_/);
  });

  it("replaces a re-registered name with a warn (HMR/StrictMode)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = makeTool("ui_navigate");
    const second = makeTool("ui_navigate");
    useUiToolsRegistry.getState().registerUiTool(first);
    useUiToolsRegistry.getState().registerUiTool(second);

    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBe(second);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("re-registered"),
    );
    warn.mockRestore();
  });

  it("disposes the native mirror on unregister and on replacement", () => {
    const disposeFirst = vi.fn();
    const disposeSecond = vi.fn();
    mirrorUiToolToNativeMock
      .mockReturnValueOnce(disposeFirst)
      .mockReturnValueOnce(disposeSecond);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_navigate"));
    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_navigate"));
    expect(disposeFirst).toHaveBeenCalledTimes(1);

    useUiToolsRegistry.getState().unregisterUiTool("ui_navigate");
    expect(disposeSecond).toHaveBeenCalledTimes(1);
  });

  it("unregisters via an aborted signal and skips already-aborted ones", () => {
    const controller = new AbortController();
    useUiToolsRegistry
      .getState()
      .registerUiTool(makeTool("ui_navigate"), { signal: controller.signal });
    controller.abort();
    expect(useUiToolsRegistry.getState().resolve("ui_navigate")).toBeNull();

    const aborted = new AbortController();
    aborted.abort();
    useUiToolsRegistry
      .getState()
      .registerUiTool(makeTool("ui_select_server"), { signal: aborted.signal });
    expect(useUiToolsRegistry.getState().resolve("ui_select_server")).toBeNull();
  });

  it("snapshots the wire shape and truncates oversize descriptions", () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool("ui_navigate", { description: "x".repeat(600), readOnly: true }),
    );

    const snapshot = useUiToolsRegistry.getState().snapshotForChatBody();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toEqual({
      name: "ui_navigate",
      description: "x".repeat(512),
      inputSchema: { type: "object", properties: {} },
      readOnly: true,
    });
  });

  it("drops oversize schemas from the snapshot instead of truncating them", () => {
    useUiToolsRegistry.getState().registerUiTool(
      makeTool("ui_navigate", {
        inputSchema: { blob: "x".repeat(9 * 1024) },
      }),
    );
    useUiToolsRegistry.getState().registerUiTool(makeTool("ui_select_server"));

    const snapshot = useUiToolsRegistry.getState().snapshotForChatBody();
    expect(snapshot.map((t) => t.name)).toEqual(["ui_select_server"]);
  });

  it("remembers every shipped name for the page lifetime — no eviction", () => {
    const registry = useUiToolsRegistry.getState();
    registry.registerUiTool(makeTool("ui_navigate"));
    registry.snapshotForChatBody();

    registry.unregisterUiTool("ui_navigate");
    registry.registerUiTool(makeTool("ui_select_server"));
    // Many subsequent snapshots (e.g. other chat surfaces POSTing) must not
    // evict earlier-shipped names: an in-flight stream from the first POST
    // can still call ui_navigate, and dropping it would hang that stream.
    for (let i = 0; i < 50; i++) {
      registry.snapshotForChatBody();
    }

    expect(useUiToolsRegistry.getState().wasShipped("ui_navigate")).toBe(true);
    expect(useUiToolsRegistry.getState().wasShipped("ui_select_server")).toBe(
      true,
    );
    expect(useUiToolsRegistry.getState().wasShipped("ui_never_shipped")).toBe(
      false,
    );
  });
});
