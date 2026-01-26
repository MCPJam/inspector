import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { MCPClientManager, TestAgent, EvalTest } from "@mcpjam/sdk";
import "dotenv/config";

describe("Bright Data MCP Evals", () => {
  let clientManager: MCPClientManager;
  let testAgent: TestAgent;

  beforeAll(async () => {
    if (!process.env.BRIGHTDATA_API_TOKEN) {
      throw new Error("BRIGHTDATA_API_TOKEN environment variable is required");
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }

    // Connect to Bright Data MCP server
    clientManager = new MCPClientManager();
    await clientManager.connectToServer("brightdata", {
      url: `https://mcp.brightdata.com/sse?token=${process.env.BRIGHTDATA_API_TOKEN}`,
    });

    // Create TestAgent with Anthropic Claude
    testAgent = new TestAgent({
      tools: await clientManager.getToolsForAiSdk(["brightdata"]),
      model: "anthropic/claude-sonnet-4-20250514",
      apiKey: process.env.ANTHROPIC_API_KEY!,
      systemPrompt:
        "You are an Anthropic Claude LLM model. You have access to web search and scraping tools.",
      maxSteps: 10,
      temperature: undefined,
    });
  }, 60000);

  afterAll(async () => {
    await clientManager.disconnectServer("brightdata");
  });

  describe("Search tool evals", () => {
    test("search_engine accuracy > 80%", async () => {
      const evalTest = new EvalTest({
        name: "search-engine",
        test: async (agent: TestAgent) => {
          const runResult = await agent.prompt(
            "Search the web for 'artificial intelligence news'",
          );
          return runResult.hasToolCall("search_engine");
        },
      });

      await evalTest.run(testAgent, {
        iterations: 5,
        concurrency: undefined,
        retries: 1,
        timeoutMs: 60000,
        onFailure: (report) => console.error(report),
      });

      expect(evalTest.accuracy()).toBeGreaterThan(0.8);
      expect(evalTest.averageTokenUse()).toBeLessThan(30000);
    });
  });

  describe("Scrape tool evals", () => {
    test("scrape_as_markdown accuracy > 80%", async () => {
      const evalTest = new EvalTest({
        name: "scrape-as-markdown",
        test: async (agent: TestAgent) => {
          const runResult = await agent.prompt(
            "Scrape the content from https://example.com",
          );
          return runResult.hasToolCall("scrape_as_markdown");
        },
      });

      await evalTest.run(testAgent, {
        iterations: 5,
        concurrency: undefined,
        retries: 1,
        timeoutMs: 60000,
        onFailure: (report) => console.error(report),
      });

      expect(evalTest.accuracy()).toBeGreaterThan(0.8);
      expect(evalTest.averageTokenUse()).toBeLessThan(30000);
    });
  });

  describe("Argument validation evals", () => {
    test("search_engine receives query argument accuracy > 80%", async () => {
      const evalTest = new EvalTest({
        name: "search-engine-args",
        test: async (agent: TestAgent) => {
          const runResult = await agent.prompt(
            "Search for TypeScript tutorials on the web",
          );
          const args = runResult.getToolArguments("search_engine");
          return (
            runResult.hasToolCall("search_engine") &&
            typeof args?.query === "string" &&
            args.query.length > 0
          );
        },
      });

      await evalTest.run(testAgent, {
        iterations: 5,
        concurrency: undefined,
        retries: 1,
        timeoutMs: 60000,
        onFailure: (report) => console.error(report),
      });

      expect(evalTest.accuracy()).toBeGreaterThan(0.8);
      expect(evalTest.averageTokenUse()).toBeLessThan(40000);
    });
  });

  describe("Multi-turn evals", () => {
    test("search then scrape a result accuracy > 30%", async () => {
      const evalTest = new EvalTest({
        name: "search-then-scrape",
        test: async (agent: TestAgent) => {
          // Turn 1: Search for something
          const r1 = await agent.prompt(
            "Search for Python documentation on the web",
          );
          if (!r1.hasToolCall("search_engine")) return false;

          // Turn 2: Ask to scrape one of the results (with context from turn 1)
          const r2 = await agent.prompt(
            "Now scrape the first URL from those search results",
            { context: [r1] },
          );
          if (!r2.hasToolCall("scrape_as_markdown")) return false;

          return true;
        },
      });

      await evalTest.run(testAgent, {
        iterations: 5,
        concurrency: undefined,
        retries: 1,
        timeoutMs: 60000,
        onFailure: (report) => console.error(report),
      });

      expect(evalTest.accuracy()).toBeGreaterThan(0.3);
      expect(evalTest.averageTokenUse()).toBeLessThan(90000);
    });
  });
});
