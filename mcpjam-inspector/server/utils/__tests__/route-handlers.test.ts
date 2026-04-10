import { describe, it, expect, vi, beforeEach } from "vitest";
import { listTools } from "../route-handlers.js";

// Mock tokenizer-helpers
vi.mock("../tokenizer-helpers.js", () => ({
  countToolsTokens: vi.fn().mockResolvedValue(150),
}));

import { countToolsTokens } from "../tokenizer-helpers.js";

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
