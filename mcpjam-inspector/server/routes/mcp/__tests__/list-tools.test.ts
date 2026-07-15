import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hono } from "hono";
import {
  createMockMcpClientManager,
  createTestApp,
  expectJson,
  postJson,
  type MockMCPClientManager,
} from "./helpers/index.js";

describe("POST /api/mcp/list-tools", () => {
  let manager: MockMCPClientManager;
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createMockMcpClientManager({
      listTools: vi.fn().mockResolvedValue({
        tools: [
          {
            name: "search-products",
            description: "Search products",
            inputSchema: { type: "object" },
          },
          {
            name: "plain-tool",
            description: "Plain tool",
            inputSchema: { type: "object" },
            _meta: { ui: { visibility: ["model", "app"] } },
          },
        ],
      }),
      listServers: vi.fn().mockReturnValue(["amazon"]),
      getConnectionStatus: vi.fn().mockReturnValue("connected"),
    });
    app = createTestApp(manager, "list-tools");
  });

  it("merges manager sidecar metadata into returned tool _meta", async () => {
    manager.getAllToolsMetadata.mockReturnValue({
      "search-products": {
        ui: { resourceUri: "ui://amazon/search-products.html" },
      },
      "plain-tool": {
        ui: { resourceUri: "ui://amazon/plain-tool.html" },
      },
    });

    const res = await postJson(app, "/api/mcp/list-tools", {
      serverIds: ["amazon"],
    });
    const { status, data } = await expectJson(res);

    expect(status).toBe(200);
    expect(data.tools).toEqual([
      expect.objectContaining({
        name: "search-products",
        serverId: "amazon",
        _meta: {
          ui: { resourceUri: "ui://amazon/search-products.html" },
        },
      }),
      expect.objectContaining({
        name: "plain-tool",
        serverId: "amazon",
        _meta: {
          ui: {
            visibility: ["model", "app"],
            resourceUri: "ui://amazon/plain-tool.html",
          },
        },
      }),
    ]);
  });
});
