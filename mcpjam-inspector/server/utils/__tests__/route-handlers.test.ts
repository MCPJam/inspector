import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listResources,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
  listTools,
} from "../route-handlers.js";

// Mock tokenizer-helpers
vi.mock("../tokenizer-helpers.js", () => ({
  countToolsTokens: vi.fn().mockResolvedValue(150),
}));

import { countToolsTokens } from "../tokenizer-helpers.js";

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listResources: vi
      .fn()
      .mockResolvedValue({ resources: [], nextCursor: undefined }),
    readResource: vi.fn().mockResolvedValue({ contents: [] }),
    listPrompts: vi
      .fn()
      .mockResolvedValue({ prompts: [], nextCursor: undefined }),
    getPrompt: vi.fn().mockResolvedValue({ messages: [] }),
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    getAllToolsMetadata: vi.fn().mockReturnValue({}),
    ...overrides,
  } as any;
}

describe("listResources", () => {
  it("passes cursor when present", async () => {
    const manager = createMockManager({
      listResources: vi.fn().mockResolvedValue({
        resources: [{ uri: "file:///a.txt", name: "a.txt" }],
        nextCursor: "next",
      }),
    });

    const result = await listResources(manager, {
      serverId: "srv",
      cursor: "cur",
    });

    expect(manager.listResources).toHaveBeenCalledWith("srv", {
      cursor: "cur",
    });
    expect(result.resources).toHaveLength(1);
    expect(result.nextCursor).toBe("next");
  });

  it("passes undefined when cursor is absent", async () => {
    const manager = createMockManager();
    await listResources(manager, { serverId: "srv" });

    expect(manager.listResources).toHaveBeenCalledWith("srv", undefined);
  });

  it("defaults resources to empty array when undefined", async () => {
    const manager = createMockManager({
      listResources: vi.fn().mockResolvedValue({ nextCursor: undefined }),
    });

    const result = await listResources(manager, { serverId: "srv" });
    expect(result.resources).toEqual([]);
  });
});

describe("readResource", () => {
  it("returns content from manager", async () => {
    const content = { contents: [{ uri: "file:///test.txt", text: "hello" }] };
    const manager = createMockManager({
      readResource: vi.fn().mockResolvedValue(content),
    });

    const result = await readResource(manager, {
      serverId: "srv",
      uri: "file:///test.txt",
    });

    expect(manager.readResource).toHaveBeenCalledWith("srv", {
      uri: "file:///test.txt",
    });
    expect(result.content).toEqual(content);
  });
});

describe("listPrompts", () => {
  it("defaults prompts to empty array when undefined", async () => {
    const manager = createMockManager({
      listPrompts: vi.fn().mockResolvedValue({ nextCursor: undefined }),
    });

    const result = await listPrompts(manager, { serverId: "srv" });
    expect(result.prompts).toEqual([]);
  });
});

describe("listPromptsMulti", () => {
  it("handles partial failures", async () => {
    const manager = createMockManager({
      listPrompts: vi
        .fn()
        .mockResolvedValueOnce({ prompts: [{ name: "p1" }] })
        .mockRejectedValueOnce(new Error("Server disconnected")),
    });

    const result = await listPromptsMulti(manager, {
      serverIds: ["ok-server", "fail-server"],
    });

    expect((result.prompts as any)["ok-server"]).toHaveLength(1);
    expect((result.prompts as any)["fail-server"]).toEqual([]);
    expect((result.errors as any)["fail-server"]).toBe("Server disconnected");
  });

  it("handles all-error case", async () => {
    const manager = createMockManager({
      listPrompts: vi.fn().mockRejectedValue(new Error("Down")),
    });

    const result = await listPromptsMulti(manager, {
      serverIds: ["s1", "s2"],
    });

    expect((result.prompts as any)["s1"]).toEqual([]);
    expect((result.prompts as any)["s2"]).toEqual([]);
    expect((result.errors as any)["s1"]).toBe("Down");
    expect((result.errors as any)["s2"]).toBe("Down");
  });

  it("omits errors key when all servers succeed", async () => {
    const manager = createMockManager({
      listPrompts: vi.fn().mockResolvedValue({ prompts: [{ name: "p" }] }),
    });

    const result = await listPromptsMulti(manager, {
      serverIds: ["s1"],
    });

    expect(result.errors).toBeUndefined();
  });
});

describe("getPrompt", () => {
  it("stringifies non-string argument values", async () => {
    const manager = createMockManager();

    await getPrompt(manager, {
      serverId: "srv",
      name: "test-prompt",
      arguments: {
        count: 42 as unknown as string,
        flag: true as unknown as string,
      },
    });

    expect(manager.getPrompt).toHaveBeenCalledWith("srv", {
      name: "test-prompt",
      arguments: { count: "42", flag: "true" },
    });
  });

  it("passes undefined arguments when not provided", async () => {
    const manager = createMockManager();

    await getPrompt(manager, { serverId: "srv", name: "test" });

    expect(manager.getPrompt).toHaveBeenCalledWith("srv", {
      name: "test",
      arguments: undefined,
    });
  });
});

describe("listTools", () => {
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
