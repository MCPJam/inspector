import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createMockMcpClientManager,
  createTestApp,
  postJson,
  expectJson,
  sampleData,
  type MockMCPClientManager,
} from "./helpers/index.js";
import type { Hono } from "hono";

describe("POST /api/mcp/tools/list", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager({
      listTools: vi.fn().mockResolvedValue({
        tools: [sampleData.tools.echo, sampleData.tools.readFile],
      }),
      listServers: vi.fn().mockReturnValue(["test-server"]),
    });
    app = createTestApp(manager, "tools");
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await postJson(app, "/api/mcp/tools/list", {});
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("serverId is required");
    });
  });

  describe("success cases", () => {
    it("returns tools list for connected server", async () => {
      const res = await postJson(app, "/api/mcp/tools/list", {
        serverId: "test-server",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(200);
      expect(data.tools).toHaveLength(2);
      expect(data.tools[0].name).toBe("echo");
      expect(data.tools[1].name).toBe("read_file");
    });

    it("returns toolsMetadata from the manager", async () => {
      manager.getAllToolsMetadata.mockReturnValue({
        echo: { executionCount: 5 },
      });

      const res = await postJson(app, "/api/mcp/tools/list", {
        serverId: "test-server",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(200);
      expect(data.toolsMetadata).toEqual({ echo: { executionCount: 5 } });
    });

    it("normalizes serverId case-insensitively", async () => {
      manager.listServers.mockReturnValue(["Test-Server"]);

      const res = await postJson(app, "/api/mcp/tools/list", {
        serverId: "test-server",
      });

      expect(res.status).toBe(200);
      expect(manager.listTools).toHaveBeenCalledWith("Test-Server");
    });
  });

  describe("error handling", () => {
    it("returns 500 when listTools fails", async () => {
      manager.listTools.mockRejectedValue(new Error("Server disconnected"));

      const res = await postJson(app, "/api/mcp/tools/list", {
        serverId: "test-server",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(500);
      expect(data.error).toBe("Server disconnected");
    });
  });
});

describe("POST /api/mcp/tools/execute", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager({
      executeTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "Tool executed successfully" }],
      }),
      getClient: vi.fn().mockReturnValue({}),
      listServers: vi.fn().mockReturnValue(["test-server"]),
    });
    app = createTestApp(manager, "tools");
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await postJson(app, "/api/mcp/tools/execute", {
        toolName: "echo",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("serverId is required");
    });

    it("returns 400 when toolName is missing", async () => {
      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("toolName is required");
    });

    it("returns 400 when server is not connected", async () => {
      manager.getClient.mockReturnValue(null);

      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "disconnected-server",
        toolName: "echo",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("Server 'disconnected-server' is not connected");
    });
  });

  describe("success cases", () => {
    it("executes tool and returns completed result", async () => {
      manager.executeTool.mockResolvedValue({
        content: [{ type: "text", text: "Hello, World!" }],
      });

      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "echo",
        parameters: { message: "Hello, World!" },
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(200);
      expect(data.status).toBe("completed");
      expect(data.result.content[0].text).toBe("Hello, World!");

      expect(manager.executeTool).toHaveBeenCalledWith(
        "test-server",
        "echo",
        { message: "Hello, World!" },
        undefined,
        undefined
      );
    });

    it("executes tool with default empty parameters", async () => {
      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "no-args-tool",
      });

      expect(res.status).toBe(200);
      expect(manager.executeTool).toHaveBeenCalledWith(
        "test-server",
        "no-args-tool",
        {},
        undefined,
        undefined
      );
    });

    it("passes taskOptions when provided", async () => {
      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "long-running",
        parameters: {},
        taskOptions: { ttl: 30000 },
      });

      expect(res.status).toBe(200);
      expect(manager.executeTool).toHaveBeenCalledWith(
        "test-server",
        "long-running",
        {},
        undefined,
        { ttl: 30000 }
      );
    });

    it("sets and clears elicitation handler", async () => {
      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "echo",
        parameters: {},
      });

      expect(res.status).toBe(200);
      expect(manager.setElicitationHandler).toHaveBeenCalledWith(
        "test-server",
        expect.any(Function)
      );
      expect(manager.clearElicitationHandler).toHaveBeenCalledWith("test-server");
    });
  });

  describe("MCP Tasks support", () => {
    it("returns task_created when server returns task result", async () => {
      manager.executeTool.mockResolvedValue({
        task: {
          taskId: "task-123",
          status: "running",
          createdAt: "2024-01-01T00:00:00Z",
        },
      });

      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "background-task",
        parameters: {},
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(200);
      expect(data.status).toBe("task_created");
      expect(data.task.taskId).toBe("task-123");
      expect(data.task.status).toBe("running");
    });

    it("returns task_created when task is in _meta", async () => {
      manager.executeTool.mockResolvedValue({
        content: [{ type: "text", text: "Acknowledged" }],
        _meta: {
          "modelcontextprotocol.io/task": {
            taskId: "meta-task-456",
            status: "pending",
          },
        },
      });

      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "async-task",
        parameters: {},
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(200);
      expect(data.status).toBe("task_created");
      expect(data.task.taskId).toBe("meta-task-456");
    });
  });

  describe("error handling", () => {
    it("returns 500 when tool execution fails", async () => {
      manager.executeTool.mockRejectedValue(new Error("Tool execution failed"));

      const res = await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "failing-tool",
        parameters: {},
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(500);
      expect(data.error).toBe("Tool execution failed");
    });

    it("clears elicitation handler on error", async () => {
      manager.executeTool.mockRejectedValue(new Error("Failed"));

      await postJson(app, "/api/mcp/tools/execute", {
        serverId: "test-server",
        toolName: "failing-tool",
        parameters: {},
      });

      expect(manager.clearElicitationHandler).toHaveBeenCalled();
    });
  });
});

describe("POST /api/mcp/tools/respond", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager();
    app = createTestApp(manager, "tools");
  });

  describe("validation", () => {
    it("returns 400 when executionId is missing", async () => {
      const res = await postJson(app, "/api/mcp/tools/respond", {
        requestId: "req-123",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(400);
      expect(data.error).toBe("executionId is required");
    });

    it("returns 404 when executionId is not found", async () => {
      const res = await postJson(app, "/api/mcp/tools/respond", {
        executionId: "nonexistent-exec",
        requestId: "req-123",
      });
      const { status, data } = await expectJson(res);

      expect(status).toBe(404);
      expect(data.error).toBe("No active execution for executionId");
    });
  });
});

describe("POST /api/mcp/tools (deprecated)", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager();
    app = createTestApp(manager, "tools");
  });

  it("returns 410 Gone for deprecated endpoint", async () => {
    const res = await postJson(app, "/api/mcp/tools", {});
    const { status, data } = await expectJson(res);

    expect(status).toBe(410);
    expect(data.error).toContain("Endpoint migrated");
    expect(data.error).toContain("/list, /execute, or /respond");
  });
});
