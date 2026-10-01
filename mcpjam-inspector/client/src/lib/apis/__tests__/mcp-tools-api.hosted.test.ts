import { beforeEach, describe, expect, it, vi } from "vitest";

const listHostedToolsMultiMock = vi.fn();
const resolveHostedServerIdMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/apis/web/tools-api", () => ({
  executeHostedTool: vi.fn(),
  listHostedTools: vi.fn(),
  listHostedToolsMulti: (...args: unknown[]) =>
    listHostedToolsMultiMock(...args),
}));

vi.mock("@/lib/apis/web/context", () => ({
  resolveHostedServerId: (...args: unknown[]) =>
    resolveHostedServerIdMock(...args),
}));

import { getToolsMetadata, listToolsForServers } from "../mcp-tools-api";

describe("mcp-tools-api hosted mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveHostedServerIdMock.mockImplementation(
      (name: string) => `srv-${name.toLowerCase()}`,
    );
  });

  it("lists a server set with one request and answers in the caller's names", async () => {
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: {
        "srv-excalidraw": {
          tools: [{ name: "draw", inputSchema: { type: "object" } }],
          toolsMetadata: { draw: { ui: { resourceUri: "ui://draw" } } },
        },
      },
      errors: { "srv-other": "connect ECONNREFUSED" },
    });

    const result = await listToolsForServers(["Excalidraw", "Other"], {
      modelId: "anthropic/claude",
    });

    expect(listHostedToolsMultiMock).toHaveBeenCalledTimes(1);
    expect(listHostedToolsMultiMock).toHaveBeenCalledWith({
      serverNamesOrIds: ["Excalidraw", "Other"],
      modelId: "anthropic/claude",
    });
    expect(Object.keys(result.results)).toEqual(["Excalidraw"]);
    // Inspector metadata lands on `_meta`, as it does on the single-server path.
    expect(result.results.Excalidraw.tools[0]._meta).toEqual({
      ui: { resourceUri: "ui://draw" },
    });
    expect(result.errors).toEqual({ Other: "connect ECONNREFUSED" });
  });

  it("reports a name the context does not know on its own and lists the rest", async () => {
    resolveHostedServerIdMock.mockImplementation((name: string) => {
      if (name === "Ghost")
        throw new Error('Hosted server not found for "Ghost"');
      return `srv-${name.toLowerCase()}`;
    });
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-excalidraw": { tools: [{ name: "draw" }] } },
    });

    const result = await listToolsForServers(["Excalidraw", "Ghost"]);

    expect(listHostedToolsMultiMock).toHaveBeenCalledWith({
      serverNamesOrIds: ["Excalidraw"],
      modelId: undefined,
    });
    expect(Object.keys(result.results)).toEqual(["Excalidraw"]);
    expect(result.errors).toEqual({
      Ghost: 'Hosted server not found for "Ghost"',
    });
  });

  it("makes no request when no name resolves", async () => {
    resolveHostedServerIdMock.mockImplementation(() => {
      throw new Error("Hosted server not found");
    });

    const result = await listToolsForServers(["Ghost"]);

    expect(listHostedToolsMultiMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      results: {},
      errors: { Ghost: "Hosted server not found" },
    });
  });

  it("answers every name that shares a hosted id", async () => {
    resolveHostedServerIdMock.mockReturnValue("srv-same");
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-same": { tools: [{ name: "draw" }] } },
    });

    const result = await listToolsForServers(["Notion", "srv-same"]);

    expect(Object.keys(result.results).sort()).toEqual(["Notion", "srv-same"]);
  });

  it("aggregates tools metadata from one batch request", async () => {
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: {
        "srv-a": {
          tools: [{ name: "shared" }, { name: "only_a" }],
          toolsMetadata: { shared: { from: "a" }, only_a: {} },
          tokenCount: 10,
        },
        "srv-b": {
          tools: [{ name: "shared" }],
          toolsMetadata: { shared: { from: "b" } },
          tokenCount: 5,
        },
      },
    });

    const aggregate = await getToolsMetadata(["A", "B"], "anthropic/claude");

    expect(listHostedToolsMultiMock).toHaveBeenCalledTimes(1);
    expect(aggregate.toolServerMap).toEqual({ shared: "B", only_a: "A" });
    expect(aggregate.collidingToolNames).toEqual(["shared"]);
    expect(aggregate.scopedMetadata).toEqual({
      "A:shared": { from: "a" },
      "A:only_a": {},
      "B:shared": { from: "b" },
    });
    expect(aggregate.tokenCounts).toEqual({ A: 10, B: 5 });
    expect(Object.keys(aggregate.serializedTools).sort()).toEqual([
      "only_a",
      "shared",
    ]);
  });

  it("fails the aggregate when any server in the batch failed", async () => {
    // Unchanged from the per-server days: the chat clears every tool on this
    // error rather than offering the model a partial set.
    listHostedToolsMultiMock.mockResolvedValueOnce({
      results: { "srv-a": { tools: [], toolsMetadata: {} } },
      errors: { "srv-b": "connect ECONNREFUSED" },
    });

    await expect(getToolsMetadata(["A", "B"])).rejects.toThrow(
      "connect ECONNREFUSED",
    );
  });
});
