import {
  MCPClientManager,
  TestAgent,
  EvalTest,
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
      const test = new EvalTest({
        name: "list-workspaces",
        test: async (agent: TestAgent) => {
          const runResult = await agent.prompt("Show me all my Asana workspaces");
          return runResult.hasToolCall("asana_list_workspaces");
        },
      });
      await test.run(testAgent, {
        iterations: 5, // Number of test runs per eval
        concurrency: undefined, // Leave as undefined for max concurrency
        retries: 1, // Retry on failure
        timeoutMs: 60000, // 60s timeout
        onFailure: (report) => console.log(report), // Print trace on failure
      });
      expect(test.accuracy()).toBeGreaterThan(0.8);
      expect(test.averageTokenUse()).toBeLessThan(30000);
    });
  });

  describe("Test asana_get_user", () => {
    test("asana_get_user accuracy > 80%", async () => {
      const test = new EvalTest({
        name: "asana-get-user",
        test: async (agent: TestAgent) => {
          const runResult = await agent.prompt("Who am I in Asana?");
          return runResult.hasToolCall("asana_get_user");
        },
      });
      await test.run(testAgent, {
        iterations: 10, // Number of test runs per eval
        concurrency: undefined, // Leave as undefined for max concurrency
        retries: 1, // Retry on failure
        timeoutMs: 60000, // 60s timeout
        onFailure: (report) => console.error(report)
      });
      expect(test.accuracy()).toBeGreaterThan(0.8);
      expect(test.averageTokenUse()).toBeLessThan(30000);
    });
  });

  describe("Test get_workspace_users", () => {
    test("get_workspace_users accuracy > 80%", async () => {
      const test = new EvalTest({
        name: "get_workspace_users",
        test: async (agent: TestAgent) => {
          const runResult = await agent.prompt("Can you get me the users in my workspace?");
          const getToolCallArguments = runResult.getToolArguments("asana_get_workspace_users");
          return runResult.hasToolCall("asana_get_workspace_users") && typeof getToolCallArguments?.workspace_gid === "string";
        },
      });
      await test.run(testAgent, {
        iterations: 5, 
        concurrency: undefined,
        retries: 1, 
        timeoutMs: 60000, 
        onFailure: (report) => console.error(report)
      });
      expect(test.accuracy()).toBeGreaterThan(0.8);
      expect(test.averageTokenUse()).toBeLessThan(40000);
    });
  });

  describe("Multi-turn tests", () => {
    test("identify who I am in Asana, then list projects in my workspace", async () => {
      const test = new EvalTest({
        name: "user-projects-tasks-flow",
        test: async (agent: TestAgent) => {
          // Turn 1: Get current user info
          const r1 = await agent.prompt("Who am I in Asana? What's my user ID?");
          if (!r1.hasToolCall("asana_get_user")) return false;

          // Turn 2: List projects in workspace (with context from turn 1)
          const r2 = await agent.prompt(
            "Now list the projects in my workspace",
            { context: [r1] }
          );
          if (!r2.hasToolCall("asana_get_projects") && !r2.hasToolCall("asana_get_projects_for_workspace")) return false;
          return true;
        },
      });
      await test.run(testAgent, {
        iterations: 5,
        concurrency: undefined,
        retries: 1,
        timeoutMs: 60000,
        onFailure: (report) => console.error(report)
      });
      expect(test.accuracy()).toBeGreaterThan(0.7);
      expect(test.averageTokenUse()).toBeLessThan(90000);
    });
  });
});
