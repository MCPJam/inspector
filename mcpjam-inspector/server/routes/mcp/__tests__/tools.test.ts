import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import tools from "../tools.js";

// Mock MCPClientManager
const createMockMcpClientManager = (overrides: Record<string, any> = {}) => ({
  connectToServer: vi.fn().mockResolvedValue(undefined),
  disconnectServer: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      {
        name: "echo",
        description: "Echoes input back",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        name: "read_file",
        description: "Reads a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ],
  }),
  executeTool: vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "Tool executed successfully" }],
  }),
  getClient: vi.fn().mockReturnValue({}),
  listServers: vi.fn().mockReturnValue(["test-server"]),
  getAllToolsMetadata: vi.fn().mockReturnValue({}),
  setElicitationHandler: vi.fn(),
  clearElicitationHandler: vi.fn(),
  ...overrides,
});

function createApp(
  mcpClientManager: ReturnType<typeof createMockMcpClientManager>
) {
  const app = new Hono();

  // Middleware to inject mock mcpClientManager
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });

  app.route("/api/mcp/tools", tools);
  return app;
}

describe("POST /api/mcp/tools/list", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/tools/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("serverId is required");
    });
  });

  describe("success cases", () => {
    it("returns tools list for connected server", async () => {
      const res = await app.request("/api/mcp/tools/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.tools).toHaveLength(2);
      expect(data.tools[0].name).toBe("echo");
      expect(data.tools[1].name).toBe("read_file");
    });

    it("returns toolsMetadata from the manager", async () => {
      mcpClientManager.getAllToolsMetadata.mockReturnValue({
        echo: { executionCount: 5 },
      });

      const res = await app.request("/api/mcp/tools/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.toolsMetadata).toEqual({ echo: { executionCount: 5 } });
    });

    it("normalizes serverId case-insensitively", async () => {
      mcpClientManager.listServers.mockReturnValue(["Test-Server"]);

      const res = await app.request("/api/mcp/tools/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.listTools).toHaveBeenCalledWith("Test-Server");
    });
  });

  describe("error handling", () => {
    it("returns 500 when listTools fails", async () => {
      mcpClientManager.listTools.mockRejectedValue(
        new Error("Server disconnected")
      );

      const res = await app.request("/api/mcp/tools/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Server disconnected");
    });
  });
});

describe("POST /api/mcp/tools/execute", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolName: "echo" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("serverId is required");
    });

    it("returns 400 when toolName is missing", async () => {
      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("toolName is required");
    });

    it("returns 400 when server is not connected", async () => {
      mcpClientManager.getClient.mockReturnValue(null);

      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "disconnected-server",
          toolName: "echo",
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Server 'disconnected-server' is not connected");
    });
  });

  describe("success cases", () => {
    it("executes tool and returns completed result", async () => {
      mcpClientManager.executeTool.mockResolvedValue({
        content: [{ type: "text", text: "Hello, World!" }],
      });

      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "echo",
          parameters: { message: "Hello, World!" },
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("completed");
      expect(data.result.content[0].text).toBe("Hello, World!");

      expect(mcpClientManager.executeTool).toHaveBeenCalledWith(
        "test-server",
        "echo",
        { message: "Hello, World!" },
        undefined,
        undefined
      );
    });

    it("executes tool with default empty parameters", async () => {
      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "no-args-tool",
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.executeTool).toHaveBeenCalledWith(
        "test-server",
        "no-args-tool",
        {},
        undefined,
        undefined
      );
    });

    it("passes taskOptions when provided", async () => {
      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "long-running",
          parameters: {},
          taskOptions: { ttl: 30000 },
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.executeTool).toHaveBeenCalledWith(
        "test-server",
        "long-running",
        {},
        undefined,
        { ttl: 30000 }
      );
    });

    it("sets and clears elicitation handler", async () => {
      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "echo",
          parameters: {},
        }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.setElicitationHandler).toHaveBeenCalledWith(
        "test-server",
        expect.any(Function)
      );
      expect(mcpClientManager.clearElicitationHandler).toHaveBeenCalledWith(
        "test-server"
      );
    });
  });

  describe("MCP Tasks support", () => {
    it("returns task_created when server returns task result", async () => {
      mcpClientManager.executeTool.mockResolvedValue({
        task: {
          taskId: "task-123",
          status: "running",
          createdAt: "2024-01-01T00:00:00Z",
        },
      });

      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "background-task",
          parameters: {},
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("task_created");
      expect(data.task.taskId).toBe("task-123");
      expect(data.task.status).toBe("running");
    });

    it("returns task_created when task is in _meta", async () => {
      mcpClientManager.executeTool.mockResolvedValue({
        content: [{ type: "text", text: "Acknowledged" }],
        _meta: {
          "modelcontextprotocol.io/task": {
            taskId: "meta-task-456",
            status: "pending",
          },
        },
      });

      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "async-task",
          parameters: {},
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe("task_created");
      expect(data.task.taskId).toBe("meta-task-456");
    });
  });

  describe("error handling", () => {
    it("returns 500 when tool execution fails", async () => {
      mcpClientManager.executeTool.mockRejectedValue(
        new Error("Tool execution failed")
      );

      const res = await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "failing-tool",
          parameters: {},
        }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.error).toBe("Tool execution failed");
    });

    it("clears elicitation handler on error", async () => {
      mcpClientManager.executeTool.mockRejectedValue(new Error("Failed"));

      await app.request("/api/mcp/tools/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          toolName: "failing-tool",
          parameters: {},
        }),
      });

      expect(mcpClientManager.clearElicitationHandler).toHaveBeenCalled();
    });
  });
});

describe("POST /api/mcp/tools/respond", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when executionId is missing", async () => {
      const res = await app.request("/api/mcp/tools/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "req-123" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("executionId is required");
    });

    it("returns 404 when executionId is not found", async () => {
      const res = await app.request("/api/mcp/tools/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executionId: "nonexistent-exec",
          requestId: "req-123",
        }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("No active execution for executionId");
    });
  });
});

describe("POST /api/mcp/tools (deprecated)", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  it("returns 410 Gone for deprecated endpoint", async () => {
    const res = await app.request("/api/mcp/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(410);
    const data = await res.json();
    expect(data.error).toContain("Endpoint migrated");
    expect(data.error).toContain("/list, /execute, or /respond");
  });
});
