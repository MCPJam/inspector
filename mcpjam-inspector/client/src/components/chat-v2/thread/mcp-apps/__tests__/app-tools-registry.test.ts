import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  useAppToolsRegistry,
  type AppInstance,
  type AppToolDescriptor,
} from "../app-tools-registry";

function readonlyTool(
  name: string,
  extra?: Partial<AppToolDescriptor>,
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
    pendingControllers: new Map(),
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
        makeInstance("b-1", [readonlyTool("ping"), nonReadonlyTool("mutate")]),
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
        ]),
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
        ]),
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
      useAppToolsRegistry.getState().activeBridgeByParent.get("call-1"),
    ).toBe("b-1");

    useAppToolsRegistry.getState().unregisterInstance("b-1");
    expect(useAppToolsRegistry.getState().aliases.size).toBe(0);
    expect(
      useAppToolsRegistry.getState().activeBridgeByParent.has("call-1"),
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

  // ── SEP-1865 in-flight teardown cancellation ────────────────────────────
  it("unregisterInstance aborts pending controllers only for the matching bridgeId", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-2", [readonlyTool("ping")], {
        parentToolCallId: "call-2",
      }),
    );
    const c1 = new AbortController();
    const c2 = new AbortController();
    useAppToolsRegistry.getState().registerPendingCall("b-1", c1);
    useAppToolsRegistry.getState().registerPendingCall("b-2", c2);
    useAppToolsRegistry.getState().unregisterInstance("b-1");
    expect(c1.signal.aborted).toBe(true);
    expect(c2.signal.aborted).toBe(false);
    // The aborted bridge's pending set is cleared; the survivor stays.
    const state = useAppToolsRegistry.getState();
    expect(state.pendingControllers.has("b-1")).toBe(false);
    expect(state.pendingControllers.get("b-2")?.has(c2)).toBe(true);
  });

  it("pendingControllers selector reflects register/unregister of in-flight calls", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(makeInstance("b-1", [readonlyTool("ping")]));
    const c1 = new AbortController();
    const c2 = new AbortController();
    useAppToolsRegistry.getState().registerPendingCall("b-1", c1);
    useAppToolsRegistry.getState().registerPendingCall("b-1", c2);
    expect(
      useAppToolsRegistry.getState().pendingControllers.get("b-1")?.size,
    ).toBe(2);
    useAppToolsRegistry.getState().unregisterPendingCall("b-1", c1);
    expect(
      useAppToolsRegistry.getState().pendingControllers.get("b-1")?.size,
    ).toBe(1);
    useAppToolsRegistry.getState().unregisterPendingCall("b-1", c2);
    expect(useAppToolsRegistry.getState().pendingControllers.has("b-1")).toBe(
      false,
    );
  });

  // ── SEP-1865 multi-instance disambiguation ──────────────────────────────
  it("snapshotForChatBody decorates colliding (appName, rawName) entries with instance hints", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("move", { description: "Move" })], {
        parentToolCallId: "call-A",
        appName: "TicTacToe",
      }),
    );
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-2", [readonlyTool("move", { description: "Move" })], {
        parentToolCallId: "call-B",
        appName: "TicTacToe",
      }),
    );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap.map((e) => e.description).sort()).toEqual([
      "Move (from tool call call-A; instance 1 of 2)",
      "Move (from tool call call-B; instance 2 of 2)",
    ]);
  });

  it("snapshotForChatBody leaves singleton (appName, rawName) groups untouched", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-1", [readonlyTool("solo", { description: "Solo" })], {
        appName: "OnlyOne",
      }),
    );
    const snap = useAppToolsRegistry.getState().snapshotForChatBody();
    expect(snap).toHaveLength(1);
    expect(snap[0].description).toBe("Solo");
  });

  it("snapshotForChatBody and resolve are scoped to the active chat session", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-chat-1", [readonlyTool("move")], {
        chatSessionId: "chat-1",
      }),
    );
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-chat-2", [readonlyTool("move")], {
        chatSessionId: "chat-2",
      }),
    );

    const state = useAppToolsRegistry.getState();
    const aliasByBridge = new Map(
      [...state.aliases.values()].map((alias) => [alias.bridgeId, alias.alias]),
    );
    const chat1Alias = aliasByBridge.get("b-chat-1");
    const chat2Alias = aliasByBridge.get("b-chat-2");

    expect(chat1Alias).toBeDefined();
    expect(chat2Alias).toBeDefined();
    expect(chat1Alias).not.toBe(chat2Alias);
    expect(state.instancesByBridgeId.has("b-chat-1")).toBe(true);
    expect(state.instancesByBridgeId.has("b-chat-2")).toBe(true);
    expect(state.snapshotForChatBody("chat-1").map((e) => e.alias)).toEqual([
      chat1Alias,
    ]);
    expect(state.snapshotForChatBody("chat-2").map((e) => e.alias)).toEqual([
      chat2Alias,
    ]);
    expect(state.resolve(chat1Alias!, "chat-1")?.instance.bridgeId).toBe(
      "b-chat-1",
    );
    expect(state.resolve(chat1Alias!, "chat-2")).toBeNull();
  });

  // ── SEP-1865 inline ↔ modal coexistence ─────────────────────────────────
  // The renderer mounts a second AppBridge when a modal opens over a still-
  // mounted inline app under the same parent tool call. Registry state for
  // the inline bridge must survive across that mount/unmount cycle.
  it("modal registration under the same parent preserves the inline bridge's instance and aliases", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-inline", [readonlyTool("inline_tool")], {
        surface: "inline",
      }),
    );
    const inlineAlias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-modal", [readonlyTool("modal_tool")], {
        surface: "modal",
      }),
    );

    const state = useAppToolsRegistry.getState();
    // Both bridges coexist under call-1.
    expect(state.instancesByBridgeId.has("b-inline")).toBe(true);
    expect(state.instancesByBridgeId.has("b-modal")).toBe(true);
    // Inline alias is NOT clobbered by modal registration.
    expect(state.aliases.has(inlineAlias)).toBe(true);
    expect(state.aliases.get(inlineAlias)?.bridgeId).toBe("b-inline");
    // Modal wins as the active provider while open — snapshot/resolve
    // route to modal tools.
    expect(state.activeBridgeByParent.get("call-1")).toBe("b-modal");
    expect(state.resolve(inlineAlias)).toBeNull();
  });

  it("modal registration with the same raw tool name does not clobber the inline alias", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-inline", [readonlyTool("move")], {
        surface: "inline",
      }),
    );
    const inlineAlias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-modal", [readonlyTool("move")], {
        surface: "modal",
      }),
    );

    const modalState = useAppToolsRegistry.getState();
    const modalAlias = [...modalState.aliases.values()].find(
      (alias) => alias.bridgeId === "b-modal",
    )?.alias;
    expect(modalState.aliases.has(inlineAlias)).toBe(true);
    expect(modalAlias).toBeDefined();
    expect(modalAlias).not.toBe(inlineAlias);
    expect(modalState.resolve(inlineAlias)).toBeNull();
    expect(modalState.resolve(modalAlias!)?.instance.bridgeId).toBe("b-modal");

    useAppToolsRegistry.getState().unregisterInstance("b-modal");

    const restoredState = useAppToolsRegistry.getState();
    expect(restoredState.aliases.has(inlineAlias)).toBe(true);
    expect(restoredState.resolve(inlineAlias)?.instance.bridgeId).toBe(
      "b-inline",
    );
    expect(restoredState.snapshotForChatBody().map((e) => e.alias)).toEqual([
      inlineAlias,
    ]);
  });

  it("inline → modal → inline: closing the modal restores the inline bridge as active and resolvable", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-inline", [readonlyTool("inline_tool")], {
        surface: "inline",
      }),
    );
    const inlineAlias = [...useAppToolsRegistry.getState().aliases.keys()][0];

    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-modal", [readonlyTool("modal_tool")], {
        surface: "modal",
      }),
    );

    useAppToolsRegistry.getState().unregisterInstance("b-modal");

    const state = useAppToolsRegistry.getState();
    expect(state.instancesByBridgeId.has("b-modal")).toBe(false);
    expect(state.instancesByBridgeId.has("b-inline")).toBe(true);
    // Active fallback promoted inline back to the provider slot.
    expect(state.activeBridgeByParent.get("call-1")).toBe("b-inline");
    // Inline tools are once again resolvable and snapshottable.
    const resolved = state.resolve(inlineAlias);
    expect(resolved?.rawName).toBe("inline_tool");
    expect(state.snapshotForChatBody().map((e) => e.alias)).toEqual([
      inlineAlias,
    ]);
  });

  it("same-surface re-register aborts in-flight controllers from the superseded bridge", async () => {
    await useAppToolsRegistry
      .getState()
      .registerInstance(
        makeInstance("b-1", [readonlyTool("ping")], { surface: "inline" }),
      );
    const inFlight = new AbortController();
    useAppToolsRegistry.getState().registerPendingCall("b-1", inFlight);

    // Same parent + same surface => b-1 is superseded.
    await useAppToolsRegistry
      .getState()
      .registerInstance(
        makeInstance("b-2", [readonlyTool("ping")], { surface: "inline" }),
      );

    expect(inFlight.signal.aborted).toBe(true);
    expect(useAppToolsRegistry.getState().pendingControllers.has("b-1")).toBe(
      false,
    );
  });

  it("modal registration does NOT abort the inline bridge's pending callTool", async () => {
    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-inline", [readonlyTool("inline_tool")], {
        surface: "inline",
      }),
    );
    const inFlight = new AbortController();
    useAppToolsRegistry.getState().registerPendingCall("b-inline", inFlight);

    await useAppToolsRegistry.getState().registerInstance(
      makeInstance("b-modal", [readonlyTool("modal_tool")], {
        surface: "modal",
      }),
    );

    // Different surface => inline bridge survives, in-flight call stays live.
    expect(inFlight.signal.aborted).toBe(false);
    expect(
      useAppToolsRegistry
        .getState()
        .pendingControllers.get("b-inline")
        ?.has(inFlight),
    ).toBe(true);
  });
});
