import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import apps from "../apps.js";

const createMockMcpClientManager = (overrides: Record<string, unknown> = {}) =>
  ({
    readResource: vi.fn().mockResolvedValue({
      contents: [
        {
          uri: "ui://test/widget",
          mimeType: "text/html;profile=mcp-app",
          text: "<!doctype html><html><head></head><body><div>Widget</div></body></html>",
          _meta: {
            ui: {
              csp: { connectDomains: ["https://api.example.com"] },
              permissions: { clipboardWrite: {} },
              prefersBorder: false,
            },
          },
        },
      ],
    }),
    ...overrides,
  }) as {
    readResource: ReturnType<typeof vi.fn>;
  };

function createApp(
  mcpClientManager: ReturnType<typeof createMockMcpClientManager>,
) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    (c as any).mcpClientManager = mcpClientManager;
    await next();
  });
  app.route("/api/mcp/apps", apps);
  return app;
}

describe("POST /api/mcp/apps/widget-content", () => {
  let mcpClientManager: ReturnType<typeof createMockMcpClientManager>;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    mcpClientManager = createMockMcpClientManager();
    app = createApp(mcpClientManager);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await app.request("/api/mcp/apps/widget-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Missing required fields");
  });

  it("returns 400 when template is not ui://", async () => {
    const res = await app.request("/api/mcp/apps/widget-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: "test-server",
        resourceUri: "ui://test/widget",
        toolId: "call-1",
        toolName: "tool",
        template: "https://example.com/not-allowed",
      }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Template must use ui:// protocol");
  });

  it("reads resource and returns HTML payload with runtime injection", async () => {
    const res = await app.request("/api/mcp/apps/widget-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: "test-server",
        resourceUri: "ui://test/widget",
        toolInput: { q: "abc" },
        toolOutput: { ok: true },
        toolId: "call-1",
        toolName: "tool",
        theme: "dark",
        cspMode: "widget-declared",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.mimeTypeValid).toBe(true);
    expect(data.permissive).toBe(false);
    expect(data.prefersBorder).toBe(false);
    expect(data.html).toContain("openai-compat-config");
    expect(mcpClientManager.readResource).toHaveBeenCalledWith("test-server", {
      uri: "ui://test/widget",
    });
  });

  it("uses template uri override for modal-like requests", async () => {
    const res = await app.request("/api/mcp/apps/widget-content", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: "test-server",
        resourceUri: "ui://test/widget",
        template: "ui://test/modal",
        toolInput: {},
        toolOutput: null,
        toolId: "call-1",
        toolName: "tool",
      }),
    });

    expect(res.status).toBe(200);
    expect(mcpClientManager.readResource).toHaveBeenCalledWith("test-server", {
      uri: "ui://test/modal",
    });
  });
});
