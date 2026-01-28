import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import "dotenv/config";

// Use token in URL as per BrightData docs
const BRIGHTDATA_URL = `https://mcp.brightdata.com/mcp?token=${process.env.BRIGHTDATA_API_TOKEN}&groups=ecommerce`;
const BRIGHTDATA_CONFIG = {
  url: BRIGHTDATA_URL,
};

describe("SDK Feature: connectToServer", () => {
  test("connects to MCP server with URL + token param", async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN environment variable is required");
    }

    const clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata-ecommerce", BRIGHTDATA_CONFIG);

    expect(clientManager.getConnectionStatus("brightdata-ecommerce")).toBe("connected");

    await clientManager.disconnectServer("brightdata-ecommerce");
  });
});

describe("SDK Feature: getServerCapabilities", () => {
  test("returns server capabilities with tools", async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN environment variable is required");
    }

    const clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata-ecommerce", BRIGHTDATA_CONFIG);

    const capabilities = clientManager.getServerCapabilities("brightdata-ecommerce");
    expect(capabilities).toBeDefined();
    expect(typeof capabilities).toBe("object");
    expect(capabilities?.tools).toBeDefined();

    await clientManager.disconnectServer("brightdata-ecommerce");
  });
});

describe("SDK Features with shared connection", () => {
  let clientManager: MCPClientManager;

  beforeAll(async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN environment variable is required");
    }

    clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata-ecommerce", BRIGHTDATA_CONFIG);
  });

  afterAll(async () => {
    if (clientManager) {
      await clientManager.disconnectServer("brightdata-ecommerce");
    }
  });

  test("SDK Feature: getServerSummaries - lists all servers with id, status, config", () => {
    const summaries = clientManager.getServerSummaries();

    expect(summaries).toBeDefined();
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBeGreaterThan(0);

    const brightdataSummary = summaries.find((s) => s.id === "brightdata-ecommerce");
    expect(brightdataSummary).toBeDefined();
    expect(brightdataSummary?.status).toBe("connected");
    expect(brightdataSummary?.config).toBeDefined();
  });

  test("SDK Feature: pingServer - verifies server is responsive", () => {
    expect(() => clientManager.pingServer("brightdata-ecommerce")).not.toThrow();
  });

  test("SDK Feature: listTools - returns available ecommerce tools", async () => {
    const tools = await clientManager.listTools("brightdata-ecommerce");

    expect(tools).toBeDefined();
    expect(tools.tools).toBeDefined();
    expect(Array.isArray(tools.tools)).toBe(true);
    expect(tools.tools.length).toBeGreaterThan(0);

    // Verify ecommerce tools are present
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("web_data_amazon_product_search");
    expect(toolNames).toContain("web_data_amazon_product");
    expect(toolNames).toContain("web_data_amazon_product_reviews");
    expect(toolNames).toContain("web_data_walmart_product");
    expect(toolNames).toContain("web_data_walmart_seller");
    expect(toolNames).toContain("web_data_ebay_product");
    expect(toolNames).toContain("web_data_homedepot_products");
    expect(toolNames).toContain("web_data_zara_products");
    expect(toolNames).toContain("web_data_etsy_products");
    expect(toolNames).toContain("web_data_bestbuy_products");
    expect(toolNames).toContain("web_data_google_shopping");

    // Verify tool structure
    const amazonTool = tools.tools.find((t) => t.name === "web_data_amazon_product_search");
    expect(amazonTool).toHaveProperty("name");
    expect(amazonTool).toHaveProperty("description");
    expect(amazonTool).toHaveProperty("inputSchema");
  });

  test("SDK Feature: executeTool - runs web_data_amazon_product_search tool", async () => {
    const result = await clientManager.executeTool(
      "brightdata-ecommerce",
      "web_data_amazon_product_search",
      {
        keyword: "headphones",
        url: "https://www.amazon.com",
      },
    );

    // Verify SDK returns proper MCP response structure
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
    expect(typeof firstContent.text).toBe("string");
    expect(firstContent.text.length).toBeGreaterThan(0);

    // Verify tool executed successfully (no error)
    const hasError = (result as { isError?: boolean }).isError;
    expect(hasError).not.toBe(true);
  });
});
