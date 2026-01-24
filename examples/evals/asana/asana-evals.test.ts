import {
  MCPClientManager,
  TestAgent,
  EvalTest,
  EvalSuite,
} from "@mcpjam/sdk";

describe("Asana MCP Evals", () => {
  let clientManager: MCPClientManager;
  let testAgent: TestAgent;

  beforeAll(async () => {
    if (!process.env.ASANA_TOKEN) {
      throw new Error("ASANA_TOKEN environment variable is required");
    }
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY environment variable is required");
    }

    // Connect to Asana MCP server
    clientManager = new MCPClientManager();
    await clientManager.connectToServer("asana", {
      url: "https://mcp.asana.com/sse",
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
        },
      },
    });

    // Create TestAgent with Asana tools
    testAgent = new TestAgent({
      tools: await clientManager.getToolsForAiSdk(["asana"]),
      model: "openai/gpt-5-mini",
      apiKey: process.env.OPENAI_API_KEY!,
      systemPrompt:
        "You are an OpenAI gpt-5-mini LLM model. You have access to tools and apps.", // Configure custom system prompt here
      maxSteps: 10,
      temperature: undefined,
    });
  }, 60000);

  afterAll(async () => {
    await clientManager.disconnectServer("asana");
  });

  describe("Test workspace tools", () => {
    test("list-workspaces accuracy > 80%", async () => {
      const suite = new EvalSuite({ name: "Single-Turn Tool Selection" });
      suite.add(
        new EvalTest({
          name: "list-workspaces",
          test: async (agent: TestAgent) => {
            const runResult = await agent.prompt("Show me all my Asana workspaces");
            return runResult.hasToolCall("asana_list_workspaces");
          },
        }),
      );
      await suite.run(testAgent, {
        iterations: 1, // Number of test runs per eval
        concurrency: undefined, // Parallel executions
        retries: 1, // Retry on failure
        timeoutMs: 60000, // 60s timeout
      })
      expect(suite.get("list-workspaces")!.accuracy()).toBeGreaterThan(0.8);
      expect(suite.get("list-workspaces")!.averageTokenUse()).toBeLessThan(30000);
    });
  });

  describe("Test asana_get_user", () => {
    test("asana_get_user accuracy > 80%", async () => {
      const suite = new EvalSuite({ name: "asana_get_user" });
      suite.add(
        new EvalTest({
          name: "asana-get-user",
          test: async (agent: TestAgent) => {
            const runResult = await agent.prompt("Who am I in Asana?");
            return runResult.hasToolCall("asana_get_user");
          },
        }),
      );
      await suite.run(testAgent, {
        iterations: 1, // Number of test runs per eval
        concurrency: undefined, // Parallel executions
        retries: 1, // Retry on failure
        timeoutMs: 60000, // 60s timeout
      })
      expect(suite.get("asana-get-user")!.accuracy()).toBeGreaterThan(0.8);
      expect(suite.get("asana-get-user")!.averageTokenUse()).toBeLessThan(30000);
    });
  });

  describe("Test get_workspace_users", () => {
    test("get_workspace_users accuracy > 80%", async () => {
      const suite = new EvalSuite({ name: "get_workspace_users" });
      suite.add(
        new EvalTest({
          name: "get_workspace_users",
          test: async (agent: TestAgent) => {
            const runResult = await agent.prompt("Show me all users in my Asana workspace.");
            const getToolCallArguments = runResult.getToolArguments("asana_get_workspace_users");
            return runResult.hasToolCall("asana_get_workspace_users") && typeof getToolCallArguments?.workspace_gid === "string";
          },
        }),
      );
      await suite.run(testAgent, {
        iterations: 1, // Number of test runs per eval
        concurrency: undefined, // Parallel executions
        retries: 1, // Retry on failure
        timeoutMs: 60000, // 60s timeout
      })
      expect(suite.get("get_workspace_users")!.accuracy()).toBeGreaterThan(0.8);
      expect(suite.get("get_workspace_users")!.averageTokenUse()).toBeLessThan(40000);
    });
  });
});
