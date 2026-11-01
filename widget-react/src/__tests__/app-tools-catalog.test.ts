import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  createAppToolsRegistry,
  type AppInstance,
  type AppToolDescriptor,
} from "../app-tools-registry";
import { listAppToolCatalog } from "../app-tools-catalog";

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
const tool = (name: string): AppToolDescriptor => ({
  name,
  description: "Move",
  inputSchema: { type: "object" },
});
const instance = (id: string, tools: AppToolDescriptor[]): AppInstance => ({
  bridgeId: id,
  chatSessionId: "chat",
  parentToolCallId: id,
  serverId: "server",
  appName: "Chess",
  surface: "inline",
  bridge: new AppBridge(null, { name: "test", version: "1" }, {}),
  tools,
  registeredAtMs: 0,
});

describe("shared app catalog", () => {
  it("preserves snapshot bytes, duplicate suffixes, schema drops and re-registration order", async () => {
    const registry = createAppToolsRegistry();
    const cyclic: AppToolDescriptor["inputSchema"] = { type: "object" };
    cyclic.self = cyclic;
    const first = instance("first", [tool("move")]);
    await registry.getState().registerInstance(first);
    await registry
      .getState()
      .registerInstance(
        instance("second", [
          tool("move"),
          {
            ...tool("large"),
            inputSchema: { type: "object", description: "x".repeat(9000) },
          },
          { ...tool("cycle"), inputSchema: cyclic },
        ]),
      );
    await registry.getState().registerInstance(
      instance(
        "many",
        Array.from({ length: 65 }, (_, i) => ({
          ...tool(`t${i}`),
          description: "x".repeat(600),
        })),
      ),
    );
    // A re-registration moves its aliases to the end, even though its instance was first.
    await registry.getState().registerInstance(first);
    const state = registry.getState();
    const catalog = listAppToolCatalog(state, "chat");
    expect(catalog.offered).toHaveLength(64);
    expect(catalog.offered[0].instance.bridgeId).toBe("second");
    expect(catalog.offered.at(-1)?.rawName).toBe("t62");
    expect(
      catalog.dropped.map((entry) => [entry.rawName, entry.reason]),
    ).toEqual([
      ["large", "schema_too_large"],
      ["cycle", "schema_unserializable"],
      ["t63", "entry_cap"],
      ["t64", "entry_cap"],
      ["move", "entry_cap"],
    ]);
    const expected = catalog.offered.map((entry, index) => ({
      alias: entry.alias,
      appName: "Chess",
      serverId: "server",
      parentToolCallId: index ? "many" : "second",
      rawName: index ? `t${index - 1}` : "move",
      description: index ? "x".repeat(512) : "Move",
      inputSchema: { type: "object" },
      readOnly: false,
    }));
    expect(JSON.stringify(state.snapshotForChatBody("chat"))).toBe(
      JSON.stringify(expected),
    );
    const small = createAppToolsRegistry();
    await small.getState().registerInstance(instance("one", [tool("move")]));
    await small.getState().registerInstance(instance("two", [tool("move")]));
    expect(
      small
        .getState()
        .snapshotForChatBody("chat")
        .map((entry) => entry.description),
    ).toEqual([
      "Move (from tool call one; instance 1 of 2)",
      "Move (from tool call two; instance 2 of 2)",
    ]);
  });
  it("returns no entries for disabled, missing and unrelated sessions", async () => {
    const registry = createAppToolsRegistry();
    await registry.getState().registerInstance(instance("one", [tool("move")]));
    expect(listAppToolCatalog(registry.getState(), null)).toEqual({
      offered: [],
      dropped: [],
    });
    expect(listAppToolCatalog(registry.getState(), "").offered).toEqual([]);
    expect(listAppToolCatalog(registry.getState(), "other").offered).toEqual(
      [],
    );
    registry.getState().setEnabled(false);
    expect(listAppToolCatalog(registry.getState(), "chat").offered).toEqual([]);
  });
  it("offers only the active surface", async () => {
    const registry = createAppToolsRegistry();
    const inline = instance("inline", [tool("move")]);
    await registry.getState().registerInstance(inline);
    await registry
      .getState()
      .registerInstance({ ...inline, bridgeId: "modal", surface: "modal" });
    expect(
      listAppToolCatalog(registry.getState(), "chat").offered.map(
        (entry) => entry.bridgeId,
      ),
    ).toEqual(["modal"]);
  });
});
