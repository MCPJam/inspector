import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import resourceTemplates from "../resource-templates.js";

// Mock MCPClientManager
const createMockMcpClientManager = (overrides: Record<string, any> = {}) => ({
  listResourceTemplates: vi.fn().mockResolvedValue({
    resourceTemplates: [
      {
        uriTemplate: "file:///{path}",
        name: "file-template",
        mimeType: "text/plain",
      },
      {
        uriTemplate: "note://{id}",
        name: "note-template",
        mimeType: "text/plain",
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

  app.route("/api/mcp/resource-templates", resourceTemplates);
  return app;
}

describe("POST /api/mcp/resource-templates/list", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  describe("validation", () => {
    it("returns 400 when serverId is missing", async () => {
      const res = await app.request("/api/mcp/resource-templates/list", {
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
    it("returns resource templates for connected server", async () => {
      const res = await app.request("/api/mcp/resource-templates/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverId: "test-server" }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resourceTemplates).toHaveLength(2);
      expect(data.resourceTemplates[0].name).toBe("file-template");
      expect("nextCursor" in data).toBe(false);
      expect(mcpClientManager.listResourceTemplates).toHaveBeenCalledWith(
        "test-server",
        undefined,
        undefined,
      );
    });

    it("passes cursor through and surfaces nextCursor", async () => {
      mcpClientManager.listResourceTemplates.mockResolvedValue({
        resourceTemplates: [
          { uriTemplate: "page2://{id}", name: "page2-template" },
        ],
        nextCursor: "cursor-page-3",
      });

      const res = await app.request("/api/mcp/resource-templates/list", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serverId: "test-server",
          cursor: "cursor-page-2",
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.resourceTemplates).toHaveLength(1);
      expect(data.nextCursor).toBe("cursor-page-3");
      expect(mcpClientManager.listResourceTemplates).toHaveBeenCalledWith(
        "test-server",
        { cursor: "cursor-page-2" },
        undefined,
      );
    });
  });

  describe("error handling", () => {
    it("returns 500 when listResourceTemplates fails", async () => {
      mcpClientManager.listResourceTemplates.mockRejectedValue(
        new Error("Server not responding"),
      );

      const res = await app.request("/api/mcp/resource-templates/list", {
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

describe("POST /api/mcp/resource-templates/list — cursor parity", () => {
  // Small in-tree multi-page fixture: 5 resource templates split into pages
  // of 2, the way a real MCP server would paginate
  // `resources/templates/list`. The route does no aggregation itself — it
  // passes `cursor` straight through to the manager and returns exactly
  // whatever page comes back (mirroring the already-shipped
  // tools/resources routes). Default (no cursor) behavior is unchanged: the
  // official beta.4 client aggregates no-cursor calls beneath the manager,
  // so the manager mock here returns the complete set directly for that
  // case.
  const ALL_TEMPLATES = Array.from({ length: 5 }, (_, i) => ({
    uriTemplate: `note://{id-${i + 1}}`,
    name: `template-${i + 1}`,
  }));
  const PAGE_SIZE = 2;

  function pageStartingAt(cursor?: string) {
    const start = cursor ? Number(cursor) : 0;
    const slice = ALL_TEMPLATES.slice(start, start + PAGE_SIZE);
    const next = start + PAGE_SIZE;
    return {
      resourceTemplates: slice,
      nextCursor: next < ALL_TEMPLATES.length ? String(next) : undefined,
    };
  }

  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager({
      listResourceTemplates: vi
        .fn()
        .mockImplementation(async (_serverId, params) => {
          if (!params?.cursor) {
            return { resourceTemplates: ALL_TEMPLATES, nextCursor: undefined };
          }
          return pageStartingAt(params.cursor);
        }),
    });
    app = createApp(mcpClientManager);
  });

  it("returns the complete multi-page set by default (no cursor)", async () => {
    const res = await app.request("/api/mcp/resource-templates/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resourceTemplates).toHaveLength(5);
    expect(
      data.resourceTemplates.map((t: { name: string }) => t.name),
    ).toEqual(ALL_TEMPLATES.map((t) => t.name));
    expect("nextCursor" in data).toBe(false);
  });

  it("returns exactly one raw page plus nextCursor when a cursor is passed", async () => {
    const res = await app.request("/api/mcp/resource-templates/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server", cursor: "2" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resourceTemplates).toHaveLength(2);
    expect(
      data.resourceTemplates.map((t: { name: string }) => t.name),
    ).toEqual(["template-3", "template-4"]);
    expect(data.nextCursor).toBe("4");
  });

  it("omits nextCursor on the final page", async () => {
    const res = await app.request("/api/mcp/resource-templates/list", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverId: "test-server", cursor: "4" }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.resourceTemplates).toHaveLength(1);
    expect(data.resourceTemplates[0].name).toBe("template-5");
    expect("nextCursor" in data).toBe(false);
  });
});
