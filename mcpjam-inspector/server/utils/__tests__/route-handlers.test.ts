import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTools, listToolsMulti } from "../route-handlers.js";

// Mock tokenizer-helpers
vi.mock("../tokenizer-helpers.js", () => ({
  countToolsTokens: vi.fn().mockResolvedValue(150),
  mapModelIdToTokenizerBackend: vi
    .fn()
    .mockReturnValue("anthropic/claude-sonnet-4.5"),
}));

import {
  countToolsTokens,
  mapModelIdToTokenizerBackend,
} from "../tokenizer-helpers.js";

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    ...overrides,
  } as any;
}

describe("listTools (inspector enrichment)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes token count when modelId is present", async () => {
    const tools = [{ name: "echo" }];
    const manager = createMockManager({
      listTools: vi.fn().mockResolvedValue({ tools }),
      getAllToolsMetadata: vi.fn().mockReturnValue({ echo: { count: 1 } }),
    });

    const result = await listTools(manager, {
      serverId: "srv",
      modelId: "claude-sonnet-4-5",
    });

    expect(countToolsTokens).toHaveBeenCalledWith(tools, "claude-sonnet-4-5");
    expect(result.tokenCount).toBe(150);
    expect(result.toolsMetadata).toEqual({ echo: { count: 1 } });
  });

  it("skips token count when modelId is absent", async () => {
    const manager = createMockManager({
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
    });

    const result = await listTools(manager, { serverId: "srv" });

    expect(countToolsTokens).not.toHaveBeenCalled();
    expect(result.tokenCount).toBeUndefined();
  });

  it("reports unavailable token counting for unsupported models", async () => {
    vi.mocked(mapModelIdToTokenizerBackend).mockReturnValueOnce(null);
    const tools = [{ name: "echo" }];
    const manager = createMockManager({
      listTools: vi.fn().mockResolvedValue({ tools }),
    });

    const result = await listTools(manager, {
      serverId: "srv",
      modelId: "custom-provider/some-model",
    });

    expect(countToolsTokens).not.toHaveBeenCalled();
    expect(result.tokenCount).toBeUndefined();
    expect(result.tokenCountError).toBe(
      "Could not pre-calculate tool description tokens for this model."
    );
  });

  it("passes through metadata from manager", async () => {
    const meta = { tool1: { executionCount: 5 } };
    const manager = createMockManager({
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      getAllToolsMetadata: vi.fn().mockReturnValue(meta),
    });

    const result = await listTools(manager, { serverId: "srv" });
    expect(result.toolsMetadata).toEqual(meta);
  });
});

describe("listToolsMulti", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every server through the enriched listTools", async () => {
    const manager = createMockManager({
      listTools: vi.fn(async (serverId: string) => ({
        tools: [{ name: `${serverId}-tool` }],
      })),
      getAllToolsMetadata: vi.fn((serverId: string) => ({
        [`${serverId}-tool`]: { count: 1 },
      })),
    });

    const result = await listToolsMulti(manager, {
      serverIds: ["a", "b"],
      modelId: "claude-sonnet-4-5",
      cacheMode: "bypass",
    });

    expect(result.results.a).toMatchObject({
      tools: [{ name: "a-tool" }],
      toolsMetadata: { "a-tool": { count: 1 } },
      tokenCount: 150,
    });
    expect(result.results.b.tools).toEqual([{ name: "b-tool" }]);
    expect(result).not.toHaveProperty("failures");
    expect(manager.listTools).toHaveBeenCalledWith("b", undefined, {
      cacheMode: "bypass",
    });
  });

  it("hands back a failing server's throw and keeps the others", async () => {
    const refused = new Error("connect ECONNREFUSED");
    const manager = createMockManager({
      listTools: vi.fn(async (serverId: string) => {
        if (serverId === "down") throw refused;
        return { tools: [{ name: `${serverId}-tool` }] };
      }),
    });

    const result = await listToolsMulti(manager, {
      serverIds: ["up", "down"],
    });

    expect(Object.keys(result.results)).toEqual(["up"]);
    // The throw itself, so the route can map it as it maps a single call.
    expect(result.failures).toEqual({ down: refused });
  });
});
