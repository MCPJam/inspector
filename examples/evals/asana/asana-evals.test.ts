import {
  MCPClientManager,
  TestAgent,
  EvalTest,
  EvalSuite,
  matchToolCallWithPartialArgs,
} from "@mcpjam/sdk";

// Run configuration for all evals
const runOptions = {
  iterations: 1, // Number of test runs per eval
  concurrency: 3, // Parallel executions
  retries: 1, // Retry on failure
  timeoutMs: 60000, // 60s timeout
};

// Extended timeout for Jest (5 minutes per suite)
const SUITE_TIMEOUT = 300000;

describe("Asana MCP Evals", () => {
  let clientManager: MCPClientManager;
  let testAgent: TestAgent;

  beforeAll(async () => {
    // Validate environment
    if (!process.env.ASANA_TOKEN) {
      throw new Error("ASANA_TOKEN environment variable is required");
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
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
        "You are an assistant with access to Asana project management tools. Use the available tools to help users manage their workspaces, projects, and tasks.",
      maxSteps: 5,
    });
  }, 60000);

  afterAll(async () => {
    await clientManager.disconnectServer("asana");
  });

  // ============================================
  // A. Single-Turn Tool Selection Tests
  // ============================================
  describe("Single-Turn Tool Selection", () => {
    let suite: EvalSuite;

    beforeAll(async () => {
      suite = new EvalSuite({ name: "Single-Turn Tool Selection" });

      suite.add(
        new EvalTest({
          name: "list-workspaces",
          prompt: "Show me all my Asana workspaces",
          expectTools: ["asana_list_workspaces"],
        }),
      );

      suite.add(
        new EvalTest({
          name: "get-current-user",
          prompt: "Who am I in Asana? Get my user information.",
          expectTools: ["asana_get_user"],
        }),
      );

      suite.add(
        new EvalTest({
          name: "list-projects",
          prompt: "List all projects in my workspace",
          expectTools: ["asana_get_projects"],
        }),
      );

      suite.add(
        new EvalTest({
          name: "search-tasks",
          prompt: "Search for tasks about 'onboarding' in my workspace",
          expectTools: ["asana_search_tasks"],
        }),
      );

      suite.add(
        new EvalTest({
          name: "get-teams",
          prompt: "What teams are in my workspace?",
          expectTools: ["asana_get_teams_for_workspace"],
        }),
      );

      suite.add(
        new EvalTest({
          name: "create-task",
          prompt:
            "Create a new task called 'Review budget' in my default workspace",
          expectTools: ["asana_create_task"],
        }),
      );

      await suite.run(testAgent, runOptions);
    }, SUITE_TIMEOUT);

    test("list-workspaces accuracy > 80%", () => {
      expect(suite.get("list-workspaces")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("get-current-user accuracy > 80%", () => {
      expect(suite.get("get-current-user")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("list-projects accuracy > 80%", () => {
      expect(suite.get("list-projects")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("search-tasks accuracy > 80%", () => {
      expect(suite.get("search-tasks")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("get-teams accuracy > 80%", () => {
      expect(suite.get("get-teams")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("create-task accuracy > 80%", () => {
      expect(suite.get("create-task")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("overall single-turn accuracy > 80%", () => {
      expect(suite.accuracy()).toBeGreaterThan(0.8);
    });
  });

  // ============================================
  // B. Multi-Turn Workflow Tests
  // ============================================
  describe("Multi-Turn Workflows", () => {
    let suite: EvalSuite;

    beforeAll(async () => {
      suite = new EvalSuite({ name: "Multi-Turn Workflows" });

      suite.add(
        new EvalTest({
          name: "workspace-to-projects",
          test: async (agent) => {
            // Step 1: List workspaces
            const step1 = await agent.prompt(
              "First, list all my Asana workspaces",
            );
            const hasWorkspaces = step1.hasToolCall("asana_list_workspaces");

            // Step 2: Get projects (agent should use workspace info from context)
            const step2 = await agent.prompt(
              "Now show me the projects in my first workspace",
            );
            const hasProjects =
              step2.hasToolCall("asana_get_projects") ||
              step2.hasToolCall("asana_get_projects_for_workspace");

            return hasWorkspaces && hasProjects;
          },
        }),
      );

      suite.add(
        new EvalTest({
          name: "search-and-get-task",
          test: async (agent) => {
            // Step 1: Search for tasks
            const step1 = await agent.prompt(
              "Search for tasks containing 'meeting' in my workspace",
            );
            const hasSearch = step1.hasToolCall("asana_search_tasks");

            // Step 2: Get details of a specific task
            const step2 = await agent.prompt(
              "Get the full details of the first task from the search results",
            );
            const hasGetTask = step2.hasToolCall("asana_get_task");

            return hasSearch && hasGetTask;
          },
        }),
      );

      suite.add(
        new EvalTest({
          name: "create-and-update-task",
          test: async (agent) => {
            // Step 1: Create a task
            const step1 = await agent.prompt(
              "Create a new task called 'Test task for evaluation'",
            );
            const hasCreate = step1.hasToolCall("asana_create_task");

            // Step 2: Update the task we just created
            const step2 = await agent.prompt(
              "Update that task to mark it as completed",
            );
            const hasUpdate = step2.hasToolCall("asana_update_task");

            return hasCreate && hasUpdate;
          },
        }),
      );

      await suite.run(testAgent, runOptions);
    }, SUITE_TIMEOUT);

    test("workspace-to-projects accuracy > 70%", () => {
      expect(suite.get("workspace-to-projects")!.accuracy()).toBeGreaterThan(
        0.7,
      );
    });

    test("search-and-get-task accuracy > 70%", () => {
      expect(suite.get("search-and-get-task")!.accuracy()).toBeGreaterThan(0.7);
    });

    test("create-and-update-task accuracy > 70%", () => {
      expect(suite.get("create-and-update-task")!.accuracy()).toBeGreaterThan(
        0.7,
      );
    });

    test("overall multi-turn accuracy > 70%", () => {
      expect(suite.accuracy()).toBeGreaterThan(0.7);
    });
  });

  // ============================================
  // C. Tool Argument Validation Tests
  // ============================================
  describe("Tool Argument Validation", () => {
    let suite: EvalSuite;

    beforeAll(async () => {
      suite = new EvalSuite({ name: "Tool Argument Validation" });

      suite.add(
        new EvalTest({
          name: "get-user-me",
          prompt: "Get my own user information in Asana",
          test: (result) => {
            const toolCalls = result.getToolCalls();
            // Check that asana_get_user was called with user_id: "me"
            return matchToolCallWithPartialArgs(
              "asana_get_user",
              { user_id: "me" },
              toolCalls,
            );
          },
        }),
      );

      suite.add(
        new EvalTest({
          name: "create-task-with-name",
          prompt: "Create a task named 'Prepare quarterly report' in Asana",
          test: (result) => {
            const toolCalls = result.getToolCalls();
            // Check that asana_create_task was called
            if (!result.hasToolCall("asana_create_task")) {
              return false;
            }
            // Check that the task name contains relevant keywords
            const createTaskCall = toolCalls.find(
              (tc) => tc.toolName === "asana_create_task",
            );
            if (!createTaskCall) return false;
            const name = createTaskCall.arguments.name as string | undefined;
            return (
              name !== undefined &&
              (name.toLowerCase().includes("quarterly") ||
                name.toLowerCase().includes("report"))
            );
          },
        }),
      );

      suite.add(
        new EvalTest({
          name: "search-with-query",
          prompt: "Search for all tasks related to 'budget review' in Asana",
          test: (result) => {
            const toolCalls = result.getToolCalls();
            // Check that asana_search_tasks was called
            if (!result.hasToolCall("asana_search_tasks")) {
              return false;
            }
            // Check that the search query includes relevant terms
            const searchCall = toolCalls.find(
              (tc) => tc.toolName === "asana_search_tasks",
            );
            if (!searchCall) return false;
            const query =
              (searchCall.arguments.query as string | undefined) ||
              (searchCall.arguments.text as string | undefined);
            return (
              query !== undefined &&
              (query.toLowerCase().includes("budget") ||
                query.toLowerCase().includes("review"))
            );
          },
        }),
      );

      await suite.run(testAgent, runOptions);
    }, SUITE_TIMEOUT);

    test("get-user-me accuracy > 80%", () => {
      expect(suite.get("get-user-me")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("create-task-with-name accuracy > 70%", () => {
      expect(suite.get("create-task-with-name")!.accuracy()).toBeGreaterThan(
        0.7,
      );
    });

    test("search-with-query accuracy > 70%", () => {
      expect(suite.get("search-with-query")!.accuracy()).toBeGreaterThan(0.7);
    });

    test("overall argument validation accuracy > 70%", () => {
      expect(suite.accuracy()).toBeGreaterThan(0.7);
    });
  });

  // ============================================
  // D. Negative Tests (No Tool Calls Expected)
  // ============================================
  describe("Negative Tests", () => {
    let suite: EvalSuite;

    beforeAll(async () => {
      suite = new EvalSuite({ name: "Negative Tests" });

      suite.add(
        new EvalTest({
          name: "general-question",
          prompt: "What is the capital of France?",
          expectNoTools: true,
        }),
      );

      suite.add(
        new EvalTest({
          name: "math-question",
          prompt: "What is 2 + 2?",
          expectNoTools: true,
        }),
      );

      suite.add(
        new EvalTest({
          name: "definition-question",
          prompt: "What is project management?",
          expectNoTools: true,
        }),
      );

      suite.add(
        new EvalTest({
          name: "greeting",
          prompt: "Hello, how are you today?",
          expectNoTools: true,
        }),
      );

      await suite.run(testAgent, runOptions);
    }, SUITE_TIMEOUT);

    test("general-question should not call tools > 80%", () => {
      expect(suite.get("general-question")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("math-question should not call tools > 80%", () => {
      expect(suite.get("math-question")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("definition-question should not call tools > 80%", () => {
      expect(suite.get("definition-question")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("greeting should not call tools > 80%", () => {
      expect(suite.get("greeting")!.accuracy()).toBeGreaterThan(0.8);
    });

    test("overall negative test accuracy > 80%", () => {
      expect(suite.accuracy()).toBeGreaterThan(0.8);
    });
  });

  // ============================================
  // E. Connection and Tool List Tests (Original)
  // ============================================
  describe("Connection and Tools", () => {
    test("valid oauth token successfully connects to server", async () => {
      expect(await clientManager.getConnectionStatus("asana")).toBe(
        "connected",
      );
    });

    test("list tools successfully", async () => {
      const tools = await clientManager.listTools("asana");
      const expectedTools = [
        "asana_get_allocations",
        "asana_get_attachment",
        "asana_get_attachments_for_object",
        "asana_get_goals",
        "asana_get_goal",
        "asana_create_goal",
        "asana_get_parent_goals_for_goal",
        "asana_update_goal",
        "asana_update_goal_metric",
        "asana_get_portfolio",
        "asana_get_portfolios",
        "asana_get_items_for_portfolio",
        "asana_get_project",
        "asana_get_project_sections",
        "asana_get_projects",
        "asana_get_project_status",
        "asana_get_project_statuses",
        "asana_create_project_status",
        "asana_get_project_task_counts",
        "asana_get_projects_for_team",
        "asana_get_projects_for_workspace",
        "asana_create_project",
        "asana_search_tasks",
        "asana_get_task",
        "asana_create_task",
        "asana_update_task",
        "asana_get_stories_for_task",
        "asana_create_task_story",
        "asana_set_task_dependencies",
        "asana_set_task_dependents",
        "asana_set_parent_for_task",
        "asana_get_tasks",
        "asana_delete_task",
        "asana_add_task_followers",
        "asana_remove_task_followers",
        "asana_get_teams_for_workspace",
        "asana_get_teams_for_user",
        "asana_get_time_period",
        "asana_get_time_periods",
        "asana_typeahead_search",
        "asana_get_user",
        "asana_get_team_users",
        "asana_get_workspace_users",
        "asana_list_workspaces",
      ];
      expect(tools.tools.length).toEqual(expectedTools.length);
      const actualToolNames = tools.tools.map((tool) => tool.name);

      for (const expectedTool of expectedTools) {
        expect(actualToolNames).toContain(expectedTool);
      }

      expect(actualToolNames.length).toBe(expectedTools.length);
      expect(new Set(actualToolNames).size).toBe(expectedTools.length);
    });

    test("asana_list_workspaces runs successfully", async () => {
      const result = await clientManager.executeTool(
        "asana",
        "asana_list_workspaces",
        {},
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

      const parsedData = JSON.parse(firstContent.text);
      expect(parsedData).toHaveProperty("data");
      expect(Array.isArray(parsedData.data)).toBe(true);
      expect(parsedData.data.length).toBeGreaterThan(0);

      const workspace = parsedData.data[0];
      expect(workspace).toHaveProperty("resource_type");
      expect(workspace.resource_type).toBe("workspace");
      expect(workspace).toHaveProperty("name");
    });

    test("asana_get_user runs successfully for 'me' as a userID", async () => {
      const result = await clientManager.executeTool(
        "asana",
        "asana_get_user",
        {
          user_id: "me",
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

      const parsed = JSON.parse(firstContent.text);
      expect(parsed).toHaveProperty("data");
      const user = parsed.data;
      expect(user).toHaveProperty("name");
      expect(user).toHaveProperty("email");
    });
  });
});

// Separate describe block for invalid token test (needs its own connection)
describe("Invalid OAuth Token Handling", () => {
  test("invalid oauth token fails to connect to server", async () => {
    const config = {
      url: "https://mcp.asana.com/sse",
      requestInit: {
        headers: {
          Authorization: `Bearer abcxyz`,
        },
      },
    };
    const clientManager = new MCPClientManager();
    await expect(
      clientManager.connectToServer("asana", config),
    ).rejects.toThrow();
  });
});
