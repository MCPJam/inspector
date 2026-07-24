import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import prompts from "../prompts.js";

// Mock MCPClientManager
const createMockMcpClientManager = (overrides: Record<string, any> = {}) => ({
  listPrompts: vi.fn().mockResolvedValue({
    prompts: [
      {
        name: "code-review",
        description: "Review code for best practices",
        arguments: [
          { name: "code", description: "The code to review", required: true },
          {
            name: "language",
            description: "Programming language",
            required: false,
          },
        ],
      },
      {
        name: "summarize",
        description: "Summarize text content",
        arguments: [
          { name: "text", description: "Text to summarize", required: true },
        ],
      },
    ],
  }),
  getPrompt: vi.fn().mockResolvedValue({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Please review this code..." },
      },
    ],
  }),
  ...overrides,
});

function createApp(
  mcpClientManager: ReturnType<typeof createMockMcpClientManager>,
) {
  const app = new Hono();

  // Middleware to inject mock mcpClientManager
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });

  app.route("/api/mcp/prompts", prompts);
  return app;
}

describe("POST /api/mcp/prompts/list", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/prompts/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverId is required");
    });
  });

  describe("success cases", () => {
    it("returns prompts list for connected server", async () => {
      const res = await app.request("/api/mcp/prompts/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prompts).toHaveLength(2);
      expect(data.prompts[0].name).toBe("code-review");
      expect(data.prompts[1].name).toBe("summarize");
    });

    it("returns empty list when no prompts available", async () => {
      mcpClientManager.listPrompts.mockResolvedValue({ prompts: [] });

      const res = await app.request("/api/mcp/prompts/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prompts).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("returns 500 when listPrompts fails", async () => {
      mcpClientManager.listPrompts.mockRejectedValue(
        new Error("Server not responding"),
      );

      const res = await app.request("/api/mcp/prompts/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Server not responding");
    });
  });
});

describe("POST /api/mcp/prompts/list — cursor parity", () => {
  // Small in-tree multi-page fixture: 5 prompts split into pages of 2, the
  // way a real MCP server would paginate `prompts/list`. The route itself
  // does no aggregation — it passes `cursor` straight through to the
  // manager and returns exactly whatever page comes back (mirroring the
  // already-shipped tools/resources routes). Default (no cursor) behavior
  // is unchanged: the official beta.4 client aggregates no-cursor calls
  // beneath the manager, so the manager mock here returns the complete set
  // directly for that case.
  const ALL_PROMPTS = Array.from({ length: 5 }, (_, i) => ({
    name: `prompt-${i + 1}`,
    description: `Prompt number ${i + 1}`,
  }));
  const PAGE_SIZE = 2;

  function pageStartingAt(cursor?: string) {
    const start = cursor ? Number(cursor) : 0;
    const slice = ALL_PROMPTS.slice(start, start + PAGE_SIZE);
    const next = start + PAGE_SIZE;
    return {
      prompts: slice,
      nextCursor: next < ALL_PROMPTS.length ? String(next) : undefined,
    };
  }

  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager({
      // No cursor → the manager (standing in for the real MCP client, which
      // auto-aggregates no-cursor calls) returns the COMPLETE set.
      listPrompts: vi.fn().mockImplementation(async (_serverId, params) => {
        if (!params?.cursor) {
          return { prompts: ALL_PROMPTS, nextCursor: undefined };
        }
        return pageStartingAt(params.cursor);
      }),
    });
    app = createApp(mcpClientManager);
  });

  it("returns the complete multi-page set by default (no cursor)", async () => {
    const res = await app.request("/api/mcp/prompts/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prompts).toHaveLength(5);
    expect(data.prompts.map((p: { name: string }) => p.name)).toEqual(
      ALL_PROMPTS.map((p) => p.name),
    );
    // Absence is semantic: no more pages, so nextCursor is omitted entirely.
    expect("nextCursor" in data).toBe(false);
    expect(mcpClientManager.listPrompts).toHaveBeenCalledWith(
      "test-server",
      undefined,
    );
  });

  it("returns exactly one raw page plus nextCursor when a cursor is passed", async () => {
    const res = await app.request("/api/mcp/prompts/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server", cursor: "2" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prompts).toHaveLength(2);
    expect(data.prompts.map((p: { name: string }) => p.name)).toEqual([
      "prompt-3",
      "prompt-4",
    ]);
    expect(data.nextCursor).toBe("4");
    expect(mcpClientManager.listPrompts).toHaveBeenCalledWith("test-server", {
      cursor: "2",
    });
  });

  it("omits nextCursor on the final page", async () => {
    const res = await app.request("/api/mcp/prompts/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server", cursor: "4" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.prompts).toHaveLength(1);
    expect(data.prompts[0].name).toBe("prompt-5");
    expect("nextCursor" in data).toBe(false);
  });
});

describe("POST /api/mcp/prompts/list-multi", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverIds is missing", async () => {
      const res = await app.request("/api/mcp/prompts/list-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverIds must be a non-empty array");
    });

    it("returns 400 when serverIds is empty array", async () => {
      const res = await app.request("/api/mcp/prompts/list-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverIds: [] }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("serverIds must be a non-empty array");
    });
  });

  describe("success cases", () => {
    it("returns prompts from multiple servers", async () => {
      mcpClientManager.listPrompts
        .mockResolvedValueOnce({
          prompts: [{ name: "prompt-1", description: "First" }],
        })
        .mockResolvedValueOnce({
          prompts: [{ name: "prompt-2", description: "Second" }],
        });

      const res = await app.request("/api/mcp/prompts/list-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverIds: ["server-1", "server-2"] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prompts["server-1"]).toHaveLength(1);
      expect(data.prompts["server-2"]).toHaveLength(1);
      expect(data.prompts["server-1"][0].name).toBe("prompt-1");
      expect(data.prompts["server-2"][0].name).toBe("prompt-2");
    });

    it("handles partial failures gracefully", async () => {
      mcpClientManager.listPrompts
        .mockResolvedValueOnce({
          prompts: [{ name: "working-prompt" }],
        })
        .mockRejectedValueOnce(new Error("Server disconnected"));

      const res = await app.request("/api/mcp/prompts/list-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverIds: ["working-server", "failing-server"],
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.prompts["working-server"]).toHaveLength(1);
      expect(data.prompts["failing-server"]).toEqual([]);
      expect(data.errors["failing-server"]).toBe("Server disconnected");
    });

    it("does not include errors key when all servers succeed", async () => {
      const res = await app.request("/api/mcp/prompts/list-multi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverIds: ["server-1"] }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.errors).toBeUndefined();
    });
  });
});

describe("POST /api/mcp/prompts/get", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "code-review" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverId is required");
    });

    it("returns 400 when prompt name is missing", async () => {
      const res = await app.request("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Prompt name is required");
    });
  });

  describe("success cases", () => {
    it("returns prompt content for valid request", async () => {
      const res = await app.request("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          name: "code-review",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.content.messages).toHaveLength(1);
      expect(data.content.messages[0].role).toBe("user");

      expect(mcpClientManager.getPrompt).toHaveBeenCalledWith("test-server", {
        name: "code-review",
        arguments: undefined,
      });
    });

    it("passes prompt arguments when provided", async () => {
      const res = await app.request("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          name: "code-review",
          args: {
            code: "function hello() { return 'world'; }",
            language: "javascript",
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.getPrompt).toHaveBeenCalledWith("test-server", {
        name: "code-review",
        arguments: {
          code: "function hello() { return 'world'; }",
          language: "javascript",
        },
      });
    });

    it("converts non-string argument values to strings", async () => {
      const res = await app.request("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          name: "some-prompt",
          args: {
            count: 42,
            enabled: true,
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.getPrompt).toHaveBeenCalledWith("test-server", {
        name: "some-prompt",
        arguments: {
          count: "42",
          enabled: "true",
        },
      });
    });
  });

  describe("error handling", () => {
    it("returns 500 when getPrompt fails", async () => {
      mcpClientManager.getPrompt.mockRejectedValue(
        new Error("Prompt not found"),
      );

      const res = await app.request("/api/mcp/prompts/get", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          name: "nonexistent-prompt",
        }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Prompt not found");
    });
  });
});
