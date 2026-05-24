import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  useAppToolsRegistry,
  type AppInstance,
  type AppToolDescriptor,
} from "../app-tools-registry";

function readonlyTool(name: string, extra?: Partial<AppToolDescriptor>): AppToolDescriptor {
  return {
    rawName: name,
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

function nonReadonlyTool(name: string): AppToolDescriptor {
  return {
    rawName: name,
    annotations: { readOnlyHint: false },
    inputSchema: { type: "object", properties: {} },
  };
}

function makeInstance(
  bridgeId: string,
  tools: AppToolDescriptor[],
  overrides?: Partial<AppInstance>,
): AppInstance {
  return {
    bridgeId,
    parentToolCallId: "call-1",
    serverId: "srv-1",
    appName: "Demo",
    appVersion: "1.0.0",
    surface: "inline",
    bridge: { callTool: vi.fn() } as unknown as AppInstance["bridge"],
    tools,
    registeredAtMs: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  useAppToolsRegistry.setState({
    instancesByBridgeId: new Map(),
    aliases: new Map(),
    activeBridgeByParent: new Map(),
  });
});

describe("useAppToolsRegistry (SEP-1865)", () => {
  it("registerInstance generates app_<8hex> aliases and resolve() returns them", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping")]),
    );
    const state = useAppToolsRegistry.getState();
    const aliases = [...state.aliases.keys()];
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatch(/^app_[a-f0-9]{8}$/);
    const resolved = state.resolve(aliases[0]);
    expect(resolved?.rawName).toBe("ping");
    expect(resolved?.readOnly).toBe(true);
  });

  it("snapshotForChatBody excludes non-readonly entries (defense in depth)", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping"), nonReadonlyTool("mutate")]),
    );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap).toHaveLength(1);
    expect(snap[0].rawName).toBe("ping");
    expect(snap[0].readOnly).toBe(true);
  });

  it("snapshotForChatBody never leaks the raw bridge ref", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping")]),
    );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    for (const entry of snap) {
      expect(entry).not.toHaveProperty("bridge");
    }
  });

  it("snapshotForChatBody drops oversized inputSchema entries", async () => {
    const big = { type: "object", properties: { x: { description: "y".repeat(9000) } } };
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [
        readonlyTool("ok"),
        readonlyTool("toobig", { inputSchema: big }),
      ]),
    );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap.map((e) => e.rawName).sort()).toEqual(["ok"]);
  });

  it("snapshotForChatBody truncates descriptions to 512 chars", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [
        readonlyTool("long", { description: "x".repeat(1000) }),
      ]),
    );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap[0].description?.length).toBe(512);
  });

  it("unregisterInstance removes aliases and clears active bridge", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping")]),
    );
    expect(useAppToolsRegistry.getState().aliases.size).toBe(1);
    expect(
      useAppToolsRegistry.getState().activeBridgeByParent.get("call-1"),
    ).toBe("b-1");

    useAppToolsRegistry.getState().unregisterInstance("b-1");
    expect(useAppToolsRegistry.getState().aliases.size).toBe(0);
    expect(
      useAppToolsRegistry.getState().activeBridgeByParent.has("call-1"),
    ).toBe(false);
  });

  it("resolve() returns null after unregister (closed app)", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping")]),
    );
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];
    useAppToolsRegistry.getState().unregisterInstance("b-1");
    expect(useAppToolsRegistry.getState().resolve(alias)).toBeNull();
  });

  it("resolve() returns null for an unknown alias", () => {
    expect(
      useAppToolsRegistry.getState().resolve("app_deadbeef"),
    ).toBeNull();
  });

  it("aliases are deterministic given identical inputs (sha256 over preimage)", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping")]),
    );
    const first = [...useAppToolsRegistry.getState().aliases.keys()][0];
    useAppToolsRegistry.getState().unregisterInstance("b-1");

    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("ping")]),
    );
    const second = [...useAppToolsRegistry.getState().aliases.keys()][0];
    expect(second).toBe(first);
  });
});
