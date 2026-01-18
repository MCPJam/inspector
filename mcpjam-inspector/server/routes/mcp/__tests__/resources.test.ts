import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import resources from "../resources.js";

// Mock MCPClientManager
const createMockMcpClientManager = (overrides: Record<string, any> = {}) => ({
  listResources: vi.fn().mockResolvedValue({
    resources: [
      { uri: "file:///test.txt", name: "test.txt", mimeType: "text/plain" },
      { uri: "file:///data.json", name: "data.json", mimeType: "application/json" },
    ],
    nextCursor: undefined,
  }),
  readResource: vi.fn().mockResolvedValue({
    contents: [{ uri: "file:///test.txt", text: "Hello, World!", mimeType: "text/plain" }],
  }),
  ...overrides,
});

function createApp(mcpClientManager: ReturnType<typeof createMockMcpClientManager>) {
  const app = new Hono();

  // Middleware to inject mock mcpClientManager
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });

  app.route("/api/mcp/resources", resources);
  return app;
}

describe("POST /api/mcp/resources/list", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/resources/list", {
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
    it("returns resources list for connected server", async () => {
      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resources).toHaveLength(2);
      expect(data.resources[0].uri).toBe("file:///test.txt");
      expect(data.resources[1].uri).toBe("file:///data.json");
      expect(data.nextCursor).toBeUndefined();
    });

    it("passes cursor for pagination", async () => {
      mcpClientManager.listResources.mockResolvedValue({
        resources: [{ uri: "file:///page2.txt", name: "page2.txt" }],
        nextCursor: "cursor-page-3",
      });

      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server", cursor: "cursor-page-2" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.nextCursor).toBe("cursor-page-3");

      expect(mcpClientManager.listResources).toHaveBeenCalledWith(
        "test-server",
        { cursor: "cursor-page-2" }
      );
    });

    it("does not pass cursor option when cursor is undefined", async () => {
      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      expect(mcpClientManager.listResources).toHaveBeenCalledWith(
        "test-server",
        undefined
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 when listResources fails", async () => {
      mcpClientManager.listResources.mockRejectedValue(
        new Error("Resource listing failed")
      );

      const res = await app.request("/api/mcp/resources/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Resource listing failed");
    });
  });
});

describe("POST /api/mcp/resources/read", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uri: "file:///test.txt" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("serverId is required");
    });

    it("returns 400 when uri is missing", async () => {
      const res = await app.request("/api/mcp/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Resource URI is required");
    });
  });

  describe("success cases", () => {
    it("returns resource content for valid URI", async () => {
      const res = await app.request("/api/mcp/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          uri: "file:///test.txt",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.content.contents[0].text).toBe("Hello, World!");

      expect(mcpClientManager.readResource).toHaveBeenCalledWith("test-server", {
        uri: "file:///test.txt",
      });
    });

    it("returns binary content for blob resources", async () => {
      mcpClientManager.readResource.mockResolvedValue({
        contents: [
          {
            uri: "file:///image.png",
            blob: "iVBORw0KGgoAAAANSUhEUg==",
            mimeType: "image/png",
          },
        ],
      });

      const res = await app.request("/api/mcp/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          uri: "file:///image.png",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.content.contents[0].blob).toBeDefined();
      expect(data.content.contents[0].mimeType).toBe("image/png");
    });
  });

  describe("error handling", () => {
    it("returns 500 when readResource fails", async () => {
      mcpClientManager.readResource.mockRejectedValue(
        new Error("Resource not found")
      );

      const res = await app.request("/api/mcp/resources/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          uri: "file:///nonexistent.txt",
        }),
      });

      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe("Resource not found");
    });
  });
});
