import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { shareToolListing } from "../turn-tool-listing.js";

const listing = (name: string) => ({
  tools: [
    {
      name,
      inputSchema: { type: "object" as const },
      annotations: { readOnlyHint: true },
    },
  ],
});

/** A manager whose servers answer `tools/list` through the spied method. */
function managerListing() {
  const listTools = vi
    .spyOn(MCPClientManager.prototype, "listTools")
    .mockImplementation(async (serverId) => listing(`${serverId}_search`));
  return { manager: new MCPClientManager({}, { lazyConnect: true }), listTools };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shareToolListing", () => {
  it("lists each server once for the policy read and the model's tool set", async () => {
    const { manager, listTools } = managerListing();
    const shared = shareToolListing(manager);

    // The route's policy read, then `prepareChatV2`'s conversion.
    const declared = await manager.getTools(["a", "b"]);
    const converted = await manager.getToolsForAiSdkByServer(["a", "b"]);
    shared.end();

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(declared.map((tool) => tool.name)).toEqual(["a_search", "b_search"]);
    expect(Object.keys(converted.a ?? {})).toEqual(["a_search"]);
    expect(Object.keys(converted.b ?? {})).toEqual(["b_search"]);
  });

  it("asks the server again once the turn's preparation has ended", async () => {
    const { manager, listTools } = managerListing();
    const shared = shareToolListing(manager);
    await manager.getTools(["a"]);
    shared.end();

    await manager.getTools(["a"]);

    expect(listTools).toHaveBeenCalledTimes(2);
    expect(Object.hasOwn(manager, "listTools")).toBe(false);
  });

  it("never shares a page or a listing made with request options", async () => {
    const { manager, listTools } = managerListing();
    const shared = shareToolListing(manager);
    await manager.listTools("a");
    await manager.listTools("a", { cursor: "page-2" });
    await manager.listTools("a", undefined, { timeout: 5_000 });
    shared.end();

    expect(listTools).toHaveBeenCalledTimes(3);
  });

  it("keeps no failed listing, so the next one reaches the server", async () => {
    const { manager, listTools } = managerListing();
    listTools.mockRejectedValueOnce(new Error("tools/list failed"));
    const shared = shareToolListing(manager);

    await expect(manager.listTools("a")).rejects.toThrow("tools/list failed");
    await expect(manager.listTools("a")).resolves.toEqual(listing("a_search"));
    shared.end();

    expect(listTools).toHaveBeenCalledTimes(2);
  });

  it("restores a listTools the manager carried itself", async () => {
    const own = vi.fn(async () => listing("own"));
    const manager = Object.assign(new MCPClientManager({}, { lazyConnect: true }), {
      listTools: own,
    });
    const shared = shareToolListing(manager);
    await manager.listTools("a");
    await manager.listTools("a");
    shared.end();
    shared.end();

    expect(own).toHaveBeenCalledTimes(1);
    expect(manager.listTools).toBe(own);
  });
});
