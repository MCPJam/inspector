import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import "dotenv/config";

const BRIGHTDATA_URL = `https://mcp.brightdata.com/sse?token=${process.env.BRIGHTDATA_API_TOKEN}`;

describe("Connection and Capabilities", () => {
  test("valid token connects and returns server capabilities", async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN environment variable is required");
    }

    const clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata", {
      url: BRIGHTDATA_URL,
    });

    // Verify connection status
    expect(clientManager.getConnectionStatus("brightdata")).toBe("connected");

    // Verify getServerCapabilities returns proper structure
    const capabilities = clientManager.getServerCapabilities("brightdata");
    expect(capabilities).toBeDefined();
    expect(typeof capabilities).toBe("object");
    // Capabilities should have tools (since Bright Data exposes tools)
    expect(capabilities?.tools).toBeDefined();

    await clientManager.disconnectServer("brightdata");
  });

  test("getConnectionStatus returns 'disconnected' for unknown server", () => {
    const clientManager = new MCPClientManager();
    // Unknown/unregistered server returns 'disconnected' status
    expect(clientManager.getConnectionStatus("unknown_server")).toBe(
      "disconnected",
    );
  });
});

describe("Server Introspection", () => {
  let clientManager: MCPClientManager;

  beforeAll(async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN environment variable is required");
    }

    clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata", {
      url: BRIGHTDATA_URL,
    });
  });

  afterAll(async () => {
    if (clientManager) {
      await clientManager.disconnectServer("brightdata");
    }
  });

  test("getServerSummaries returns server info", () => {
    const summaries = clientManager.getServerSummaries();

    expect(summaries).toBeDefined();
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBeGreaterThan(0);

    // ServerSummary has: id, status, config
    const brightdataSummary = summaries.find((s) => s.id === "brightdata");
    expect(brightdataSummary).toBeDefined();
    expect(brightdataSummary?.status).toBe("connected");
    expect(brightdataSummary?.config).toBeDefined();
  });

  test("pingServer responds without error", () => {
    // pingServer returns void and throws if there's an error
    // Just calling it without error means success
    expect(() => clientManager.pingServer("brightdata")).not.toThrow();
  });

  test("executeTool runs search_engine successfully", async () => {
    const result = await clientManager.executeTool(
      "brightdata",
      "search_engine",
      {
        query: "MCP protocol",
        count: 3,
      },
    );

    expect("content" in result).toBe(true);
    if (!("content" in result)) {
      throw new Error("Expected result to have content property");
    }

    const content = (
      result as { content: Array<{ type: string; text: string }> }
    ).content;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBeGreaterThan(0);

    const firstContent = content[0];
    expect(firstContent).toHaveProperty("type");
    expect(firstContent.type).toBe("text");
    expect(firstContent).toHaveProperty("text");

    // Verify the response is valid JSON
    const parsed = JSON.parse(firstContent.text);
    expect(parsed).toBeDefined();
  });
});
