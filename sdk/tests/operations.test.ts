import {
  listResources,
  listAllPrompts,
  listAllResourceTemplates,
  listAllResources,
  listAllTools,
  readResource,
  listPrompts,
  listPromptsMulti,
  getPrompt,
  listTools,
  withEphemeralClient,
  withDisposableManager,
} from "../src/operations";

function createMockManager(overrides: Record<string, any> = {}) {
  return {
    listResources: jest
      .fn()
      .mockResolvedValue({ resources: [], nextCursor: undefined }),
    readResource: jest.fn().mockResolvedValue({ contents: [] }),
    listPrompts: jest
      .fn()
      .mockResolvedValue({ prompts: [], nextCursor: undefined }),
    listResourceTemplates: jest
      .fn()
      .mockResolvedValue({ resourceTemplates: [], nextCursor: undefined }),
    getPrompt: jest.fn().mockResolvedValue({ messages: [] }),
    listTools: jest.fn().mockResolvedValue({ tools: [] }),
    connectToServer: jest.fn().mockResolvedValue(undefined),
    disconnectAllServers: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as any;
}

// ── listResources ───────────────────────────────────────────────────

describe("listResources", () => {
  it("passes cursor when present", async () => {
    const manager = createMockManager({
      listResources: jest.fn().mockResolvedValue({
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
      listResources: jest.fn().mockResolvedValue({ nextCursor: undefined }),
    });

    const result = await listResources(manager, { serverId: "srv" });
    expect(result.resources).toEqual([]);
  });
});

// ── readResource ────────────────────────────────────────────────────

describe("readResource", () => {
  it("returns content from manager", async () => {
    const content = {
      contents: [{ uri: "file:///test.txt", text: "hello" }],
    };
    const manager = createMockManager({
      readResource: jest.fn().mockResolvedValue(content),
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

// ── listPrompts ─────────────────────────────────────────────────────

describe("listPrompts", () => {
  it("defaults prompts to empty array when undefined", async () => {
    const manager = createMockManager({
      listPrompts: jest.fn().mockResolvedValue({ nextCursor: undefined }),
    });

    const result = await listPrompts(manager, { serverId: "srv" });
    expect(result.prompts).toEqual([]);
  });
});

// ── listPromptsMulti ────────────────────────────────────────────────

describe("listPromptsMulti", () => {
  it("handles partial failures", async () => {
    const manager = createMockManager({
      listPrompts: jest
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
      listPrompts: jest.fn().mockRejectedValue(new Error("Down")),
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
      listPrompts: jest.fn().mockResolvedValue({ prompts: [{ name: "p" }] }),
    });

    const result = await listPromptsMulti(manager, {
      serverIds: ["s1"],
    });

    expect(result.errors).toBeUndefined();
  });
});

// ── getPrompt ───────────────────────────────────────────────────────

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

// ── listTools ───────────────────────────────────────────────────────

describe("listTools", () => {
  it("returns tools and nextCursor", async () => {
    const tools = [{ name: "echo" }];
    const manager = createMockManager({
      listTools: jest
        .fn()
        .mockResolvedValue({ tools, nextCursor: "next-page" }),
    });

    const result = await listTools(manager, { serverId: "srv" });

    expect(result.tools).toEqual(tools);
    expect(result.nextCursor).toBe("next-page");
  });

  it("passes cursor when present", async () => {
    const manager = createMockManager();

    await listTools(manager, { serverId: "srv", cursor: "cur" });

    expect(manager.listTools).toHaveBeenCalledWith("srv", { cursor: "cur" });
  });

  it("defaults tools to empty array when undefined", async () => {
    const manager = createMockManager({
      listTools: jest.fn().mockResolvedValue({ nextCursor: "next-page" }),
    });

    const result = await listTools(manager, { serverId: "srv" });

    expect(result.tools).toEqual([]);
    expect(result.nextCursor).toBe("next-page");
  });

  it("does not leak extra protocol fields", async () => {
    const manager = createMockManager({
      listTools: jest.fn().mockResolvedValue({
        tools: [{ name: "echo" }],
        nextCursor: "next-page",
        _meta: { protocol: "extra" },
      }),
    });

    const result = await listTools(manager, { serverId: "srv" });

    expect(result).toEqual({
      tools: [{ name: "echo" }],
      nextCursor: "next-page",
    });
  });
});

describe("listAllTools", () => {
  it("drains paginated tool pages and merges metadata from each page", async () => {
    const manager = createMockManager({
      listTools: jest
        .fn()
        .mockResolvedValueOnce({
          tools: [
            {
              name: "echo",
              _meta: { executionCount: 1 },
            },
          ],
          nextCursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          tools: [
            {
              name: "draw",
              _meta: { title: "Draw" },
            },
          ],
          nextCursor: undefined,
        }),
    });

    const result = await listAllTools(manager, { serverId: "srv" });

    expect(result.tools.map((tool) => tool.name)).toEqual(["echo", "draw"]);
    expect(result.toolsMetadata).toEqual({
      echo: { executionCount: 1 },
      draw: { title: "Draw" },
    });
    expect(manager.listTools).toHaveBeenNthCalledWith(1, "srv", undefined);
    expect(manager.listTools).toHaveBeenNthCalledWith(2, "srv", {
      cursor: "cursor-1",
    });
  });
});

describe("listAllResources", () => {
  it("drains all resource pages", async () => {
    const manager = createMockManager({
      listResources: jest
        .fn()
        .mockResolvedValueOnce({
          resources: [{ uri: "file:///a.txt" }],
          nextCursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          resources: [{ uri: "file:///b.txt" }],
          nextCursor: undefined,
        }),
    });

    const result = await listAllResources(manager, { serverId: "srv" });

    expect(result.resources).toEqual([
      { uri: "file:///a.txt" },
      { uri: "file:///b.txt" },
    ]);
  });
});

describe("listAllPrompts", () => {
  it("drains all prompt pages", async () => {
    const manager = createMockManager({
      listPrompts: jest
        .fn()
        .mockResolvedValueOnce({
          prompts: [{ name: "first" }],
          nextCursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          prompts: [{ name: "second" }],
          nextCursor: undefined,
        }),
    });

    const result = await listAllPrompts(manager, { serverId: "srv" });

    expect(result.prompts).toEqual([{ name: "first" }, { name: "second" }]);
  });
});

describe("listAllResourceTemplates", () => {
  it("drains all resource template pages", async () => {
    const manager = createMockManager({
      listResourceTemplates: jest
        .fn()
        .mockResolvedValueOnce({
          resourceTemplates: [{ uriTemplate: "note://{id}" }],
          nextCursor: "cursor-1",
        })
        .mockResolvedValueOnce({
          resourceTemplates: [{ uriTemplate: "todo://{id}" }],
          nextCursor: undefined,
        }),
    });

    const result = await listAllResourceTemplates(manager, { serverId: "srv" });

    expect(result.resourceTemplates).toEqual([
      { uriTemplate: "note://{id}" },
      { uriTemplate: "todo://{id}" },
    ]);
  });

  it("returns an empty list when the method is unavailable", async () => {
    const manager = createMockManager({
      listResourceTemplates: jest
        .fn()
        .mockRejectedValue(new Error("Method resources/templates not found")),
    });

    const result = await listAllResourceTemplates(manager, { serverId: "srv" });

    expect(result.resourceTemplates).toEqual([]);
    expect(result.unsupported).toBe(true);
  });
});

// ── withEphemeralClient ─────────────────────────────────────────────

describe("withEphemeralClient", () => {
  // We can't easily test the full lifecycle without mocking the constructor,
  // so we test withDisposableManager which covers the cleanup pattern.
});

// ── withDisposableManager ───────────────────────────────────────────

describe("withDisposableManager", () => {
  it("runs function and disconnects on success", async () => {
    const manager = createMockManager();

    const result = await withDisposableManager(manager, async (m) => {
      expect(m).toBe(manager);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("disconnects even when function throws", async () => {
    const manager = createMockManager();

    await expect(
      withDisposableManager(manager, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("preserves the function error when disconnect cleanup fails", async () => {
    const manager = createMockManager({
      disconnectAllServers: jest
        .fn()
        .mockRejectedValue(new Error("disconnect failed")),
    });

    await expect(
      withDisposableManager(manager, async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("ignores disconnect cleanup errors after success", async () => {
    const manager = createMockManager({
      disconnectAllServers: jest
        .fn()
        .mockRejectedValue(new Error("disconnect failed")),
    });

    const result = await withDisposableManager(manager, async () => "ok");

    expect(result).toBe("ok");
    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
  });

  it("resolves promise input", async () => {
    const manager = createMockManager();

    const result = await withDisposableManager(
      Promise.resolve(manager),
      async (m) => {
        expect(m).toBe(manager);
        return 42;
      }
    );

    expect(result).toBe(42);
    expect(manager.disconnectAllServers).toHaveBeenCalledTimes(1);
  });
});
