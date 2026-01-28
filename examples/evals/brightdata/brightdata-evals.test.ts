import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MCPClientManager, TestAgent, EvalTest } from "@mcpjam/sdk";
import "dotenv/config";

describe("Bright Data MCP Evals", () => {
  let clientManager: MCPClientManager;
  let testAgent: TestAgent;

  beforeAll(async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) throw new Error("BRIGHTDATA_API_TOKEN required");
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY required");

    clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata-ecommerce", {
      url: `https://mcp.brightdata.com/mcp?token=${process.env.BRIGHTDATA_API_TOKEN}&groups=ecommerce`,
    });

    const tools = await clientManager.getToolsForAiSdk(["brightdata-ecommerce"]);
    testAgent = new TestAgent({
      tools,
      model: "anthropic/claude-sonnet-4-20250514",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      systemPrompt: "You are a shopping assistant for Amazon, Walmart, eBay, and other e-commerce platforms.",
      maxSteps: 5,
      temperature: 0.1,
    });
  }, 60000);

  afterAll(async () => {
    if (clientManager) await clientManager.disconnectServer("brightdata-ecommerce");
  });

  // hasToolCall()
  test("hasToolCall() - verifies correct tool selection", async () => {
    const evalTest = new EvalTest({
      name: "hasToolCall-test",
      test: async (agent: TestAgent) => {
        const result = await agent.prompt("Search for wireless headphones on Amazon");
        return result.hasToolCall("web_data_amazon_product_search");
      },
    });
    await evalTest.run(testAgent, { iterations: 2, concurrency: 1, retries: 1, timeoutMs: 180000 });
    expect(evalTest.accuracy()).toBeGreaterThan(0.3);
  }, 600000);

  // getToolCalls()
  test("getToolCalls() - retrieves all tool calls array", async () => {
    const evalTest = new EvalTest({
      name: "getToolCalls-test",
      test: async (agent: TestAgent) => {
        const result = await agent.prompt("Find laptops on Amazon");
        const toolCalls = result.getToolCalls();
        return Array.isArray(toolCalls) && toolCalls.some((tc) => tc.toolName === "web_data_amazon_product_search");
      },
    });
    await evalTest.run(testAgent, { iterations: 2, concurrency: 1, retries: 1, timeoutMs: 180000 });
    expect(evalTest.accuracy()).toBeGreaterThan(0.3);
  }, 600000);

  // getToolArguments() + averageTokenUse()
  test("getToolArguments() + averageTokenUse() - validates arguments and tracks tokens", async () => {
    const evalTest = new EvalTest({
      name: "getToolArguments-tokenUse-test",
      test: async (agent: TestAgent) => {
        const result = await agent.prompt("Search Amazon for gaming keyboards");
        const args = result.getToolArguments("web_data_amazon_product_search");
        return args !== null && typeof args === "object" && "keyword" in args;
      },
    });
    await evalTest.run(testAgent, { iterations: 2, concurrency: 1, retries: 1, timeoutMs: 180000 });

    // Validate getToolArguments worked (via accuracy)
    expect(evalTest.accuracy()).toBeGreaterThan(0.3);

    // Validate averageTokenUse works
    const avgTokens = evalTest.averageTokenUse();
    expect(typeof avgTokens).toBe("number");
    expect(avgTokens).toBeGreaterThan(0);
  }, 600000);

  // context option (2-turn)
  test("context option - two-turn conversation", async () => {
    const evalTest = new EvalTest({
      name: "context-two-turn",
      test: async (agent: TestAgent) => {
        const r1 = await agent.prompt("Search for wireless earbuds on Amazon");
        if (!r1.hasToolCall("web_data_amazon_product_search")) return false;
        const r2 = await agent.prompt("Get details for the first product", { context: [r1] });
        return r2.hasToolCall("web_data_amazon_product");
      },
    });
    await evalTest.run(testAgent, { iterations: 2, concurrency: 1, retries: 1, timeoutMs: 300000 });
    expect(evalTest.accuracy()).toBeGreaterThan(0.3);
  }, 900000);
});
