import { MCPClientManager } from "@mcpjam/sdk";

describe("test oauth token handling", () => {
  test("valid oauth token successfully connects to server", async () => {
    const clientManager = new MCPClientManager();
    await clientManager.connectToServer("asana", {
      url: "https://mcp.asana.com/sse",
      requestInit: {
        headers: {
          Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
        },
      },
    });
    expect(await clientManager.getConnectionStatus("asana")).toBe("connected");
    await clientManager.disconnectServer("asana");
  });

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
      clientManager.connectToServer("asana", config)
    ).rejects.toThrow();
  });
});

describe("tools", () => {
  let clientManager: MCPClientManager;

  const getServerConfig = () => ({
    url: "https://mcp.asana.com/sse",
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
      },
    },
  });

  beforeAll(async () => {
    clientManager = new MCPClientManager();
    await clientManager.connectToServer("asana", getServerConfig());
  });

  afterAll(async () => {
    await clientManager.disconnectServer("asana");
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
    const result = await clientManager.executeTool("asana", "asana_list_workspaces", {});

    expect("content" in result).toBe(true);
    if (!("content" in result)) {
      throw new Error("Expected result to have content property");
    }
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
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
    const result = await clientManager.executeTool("asana", "asana_get_user", {
      user_id: "me",
    });
    expect("content" in result).toBe(true);
    if (!("content" in result)) {
      throw new Error("Expected result to have content property");
    }
    const content = (result as { content: Array<{ type: string; text: string }> }).content;
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