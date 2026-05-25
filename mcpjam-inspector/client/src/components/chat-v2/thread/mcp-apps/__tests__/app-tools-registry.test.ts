import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  useAppToolsRegistry,
  type AppInstance,
  type AppToolDescriptor,
} from "../app-tools-registry";

function readonlyTool(
  name: string,
  extra?: Partial<AppToolDescriptor>
): AppToolDescriptor {
  return {
    name,
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    ...extra,
  };
}

function nonReadonlyTool(name: string): AppToolDescriptor {
  return {
    name,
    annotations: { readOnlyHint: false },
    inputSchema: { type: "object", properties: {} },
  };
}

function makeInstance(
  bridgeId: string,
  tools: AppToolDescriptor[],
  overrides?: Partial<AppInstance>
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
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const state = useAppToolsRegistry.getState();
    const aliases = [...state.aliases.keys()];
    expect(aliases).toHaveLength(1);
    expect(aliases[0]).toMatch(/^app_[a-f0-9]{8}$/);
    const resolved = state.resolve(aliases[0]);
    expect(resolved?.rawName).toBe("ping");
    expect(resolved?.readOnly).toBe(true);
  });

  it("snapshotForChatBody includes non-readonly entries without forcing approvals", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(
        makeInstance("b-1", [readonlyTool("ping"), nonReadonlyTool("mutate")])
      );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap.map((e) => [e.rawName, e.readOnly]).sort()).toEqual([
      ["mutate", false],
      ["ping", true],
    ]);
  });

  it("snapshotForChatBody never leaks the raw bridge ref", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    for (const entry of snap) {
      expect(entry).not.toHaveProperty("bridge");
    }
  });

  it("snapshotForChatBody drops oversized inputSchema entries", async () => {
    const big = {
      type: "object",
      properties: { x: { description: "y".repeat(9000) } },
    };
    await useAppToolsRegistry
      .getState()
      .registerInstance(
        makeInstance("b-1", [
          readonlyTool("ok"),
          readonlyTool("toobig", { inputSchema: big }),
        ])
      );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap.map((e) => e.rawName).sort()).toEqual(["ok"]);
  });

  it("snapshotForChatBody truncates descriptions to 512 chars", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(
        makeInstance("b-1", [
          readonlyTool("long", { description: "x".repeat(1000) }),
        ])
      );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap[0].description?.length).toBe(512);
  });

  it("unregisterInstance removes aliases and clears active bridge", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    expect(useAppToolsRegistry.getState().aliases.size).toBe(1);
    expect(
      useAppToolsRegistry.getState().activeBridgeByParent.get("call-1")
    ).toBe("b-1");

    useAppToolsRegistry.getState().unregisterInstance("b-1");
    expect(useAppToolsRegistry.getState().aliases.size).toBe(0);
    expect(
      useAppToolsRegistry.getState().activeBridgeByParent.has("call-1")
    ).toBe(false);
  });

  it("re-registering the same bridge replaces old aliases instead of appending", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const firstAlias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("pong")]));

    const state = useAppToolsRegistry.getState();
    expect(state.aliases.size).toBe(1);
    expect(state.aliases.has(firstAlias)).toBe(false);
    const onlyAlias = [...state.aliases.values()][0];
    expect(onlyAlias.rawName).toBe("pong");
  });

  it("resolve() returns null after unregister (closed app)", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const alias = [...useAppToolsRegistry.getState().aliases.keys()][0];
    useAppToolsRegistry.getState().unregisterInstance("b-1");
    expect(useAppToolsRegistry.getState().resolve(alias)).toBeNull();
  });

  it("resolve() returns null for an unknown alias", () => {
    expect(useAppToolsRegistry.getState().resolve("app_deadbeef")).toBeNull();
  });

  // Regression for the `onToolCall` hang fix in use-chat-session.ts:
  // the snapshot is drained at chat-POST time, but the iframe can be
  // torn down before the model's tool call lands. The hook relies on
  // `resolve()` returning null for an alias that still appears in the
  // server-side tool set, so it can synthesize an error tool result
  // instead of leaving the conversation paused forever.
  it("snapshot-then-unregister: alias persists in snapshot but resolve() is null", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const snapshot = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snapshot).toHaveLength(1);
    const aliasInFlight = snapshot[0].alias;

    useAppToolsRegistry.getState().unregisterInstance("b-1");

    // The chat POST already shipped `aliasInFlight` to the server, so
    // the model can still pick it. resolve() must signal absence so
    // `onToolCall` reaches its error-tool-result branch.
    expect(useAppToolsRegistry.getState().resolve(aliasInFlight)).toBeNull();
    // And the alias still matches the regex the hook uses to
    // distinguish "app alias with no bridge" from "real server tool".
    expect(aliasInFlight).toMatch(/^app_[a-z0-9]{8}$/i);
  });

  it("aliases are deterministic given identical inputs (sha256 over preimage)", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const first = [...useAppToolsRegistry.getState().aliases.keys()][0];
    useAppToolsRegistry.getState().unregisterInstance("b-1");

    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const second = [...useAppToolsRegistry.getState().aliases.keys()][0];
    expect(second).toBe(first);
  });

  it("keeps the same alias when the same rendered app reconnects with a new bridge", async () => {
    const firstBridge = makeInstance("b-1", [readonlyTool("ping")]);
    await useAppToolsRegistry.getState().registerInstance(firstBridge);
    const firstAlias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    const secondBridge = makeInstance("b-2", [readonlyTool("ping")]);
    await useAppToolsRegistry.getState().registerInstance(secondBridge);

    const state = useAppToolsRegistry.getState();
    expect([...state.aliases.keys()]).toEqual([firstAlias]);
    const resolved = state.resolve(firstAlias);
    expect(resolved?.instance.bridgeId).toBe("b-2");
    expect(resolved?.bridge).toBe(secondBridge.bridge);
    expect(state.instancesByBridgeId.has("b-1")).toBe(false);
    expect(state.activeBridgeByParent.get("call-1")).toBe("b-2");
  });
});
