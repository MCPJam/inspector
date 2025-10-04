import type { DiscoveredTool } from "./mcpjam-client-manager";
import type { ModelMessage } from "ai";

export interface GenerateTestsRequest {
  serverIds: string[];
  tools: DiscoveredTool[];
}

export interface GeneratedTestCase {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: string[];
  judgeRequirement?: string;
}

const AGENT_SYSTEM_PROMPT = `You are an AI agent specialized in creating realistic test cases for MCP (Model Context Protocol) servers.

**About MCP:**
The Model Context Protocol enables AI assistants to securely access external data and tools. MCP servers expose tools, resources, and prompts that AI models can use to accomplish user tasks. Your test cases should reflect real-world usage patterns where users ask an AI assistant to perform tasks, and the assistant uses MCP tools to fulfill those requests.

**Your Task:**
Generate 6 test cases with varying complexity levels that mimic how real users would interact with an AI assistant using these MCP tools.

**Test Case Distribution:**
- **2 EASY tests** (single tool): Simple, straightforward tasks using one tool
- **2 MEDIUM tests** (2+ tools): Multi-step workflows requiring 2-3 tools in sequence or parallel
- **2 HARD tests** (3+ tools): Complex scenarios requiring 3+ tools, conditional logic, or cross-server operations

**Guidelines:**
1. **Realistic User Queries**: Write queries as if a real user is talking to an AI assistant (e.g., "Help me find all tasks due this week" not "Call the list_tasks tool")
2. **Natural Workflows**: Chain tools together in logical sequences that solve real problems
3. **Cross-Server Tests**: If multiple servers are available, create tests that use tools from different servers together
4. **Specific Details**: Include concrete examples (dates, names, values) to make tests actionable
5. **Judge Requirements**: Clearly define what success looks like for each test
6. **Test Titles**: Write clear, descriptive titles WITHOUT difficulty prefixes (e.g., "Read project configuration" not "EASY: Read project configuration")

**Output Format (CRITICAL):**
Respond with ONLY a valid JSON array. No explanations, no markdown code blocks, just the raw JSON array.

Example:
[
  {
    "title": "Read project configuration",
    "query": "Show me the contents of config.json in the current project",
    "runs": 1,
    "expectedToolCalls": ["read_file"],
    "judgeRequirement": "Successfully reads and returns the file contents"
  },
  {
    "title": "Find and analyze recent tasks",
    "query": "Find all tasks created this week and summarize their status",
    "runs": 1,
    "expectedToolCalls": ["list_tasks", "get_task_details"],
    "judgeRequirement": "First lists tasks filtered by date, then retrieves details for each task found"
  },
  {
    "title": "Cross-server project setup",
    "query": "Create a new project folder, initialize a git repository, and create a task to track the project setup",
    "runs": 1,
    "expectedToolCalls": ["create_directory", "git_init", "create_task"],
    "judgeRequirement": "Successfully creates directory, initializes git, and creates a tracking task with appropriate details"
  }
]`;

/**
 * Generates test cases using the backend LLM
 */
export async function generateTestCases(
  tools: DiscoveredTool[],
  convexHttpUrl: string,
  convexAuthToken: string,
): Promise<GeneratedTestCase[]> {
  // Group tools by server
  const serverGroups = tools.reduce(
    (acc, tool) => {
      if (!acc[tool.serverId]) {
        acc[tool.serverId] = [];
      }
      acc[tool.serverId].push(tool);
      return acc;
    },
    {} as Record<string, DiscoveredTool[]>,
  );

  const serverCount = Object.keys(serverGroups).length;
  const totalTools = tools.length;

  // Build context about available tools grouped by server
  const toolsContext = Object.entries(serverGroups)
    .map(([serverId, serverTools]) => {
      const toolsList = serverTools
        .map((tool) => {
          return `  - ${tool.name}: ${tool.description || "No description"}
    Input: ${JSON.stringify(tool.inputSchema)}`;
        })
        .join("\n");

      return `**Server: ${serverId}** (${serverTools.length} tools)
${toolsList}`;
    })
    .join("\n\n");

  const crossServerGuidance =
    serverCount > 1
      ? `\n**IMPORTANT**: You have ${serverCount} servers available. Create at least 2 test cases that use tools from MULTIPLE servers to test cross-server workflows.`
      : "";

  const userPrompt = `Generate 6 test cases for the following MCP server tools:

${toolsContext}

**Available Resources:**
- ${serverCount} MCP server(s)
- ${totalTools} total tools${crossServerGuidance}

**Remember:**
1. Create exactly 6 tests: 2 EASY (1 tool), 2 MEDIUM (2-3 tools), 2 HARD (3+ tools)
2. Write realistic user queries that sound natural
3. Use specific examples (dates, filenames, values)
4. Chain tools in logical sequences
5. Respond with ONLY a JSON array - no other text or markdown`;

  const messageHistory: ModelMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  // Call the backend LLM API
  const response = await fetch(`${convexHttpUrl}/streaming`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${convexAuthToken}`,
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.3-70b-instruct",
      tools: [],
      messages: JSON.stringify(messageHistory),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to generate test cases: ${errorText}`);
  }

  const data = await response.json();

  if (!data.ok || !Array.isArray(data.messages)) {
    throw new Error("Invalid response from backend LLM");
  }

  // Extract the assistant's response
  let assistantResponse = "";
  for (const msg of data.messages) {
    if (msg.role === "assistant") {
      const content = msg.content;
      if (typeof content === "string") {
        assistantResponse += content;
      } else if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === "text" && item.text) {
            assistantResponse += item.text;
          }
        }
      }
    }
  }

  // Parse JSON response
  try {
    // Try to extract JSON from markdown code blocks if present
    const jsonMatch = assistantResponse.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonText = jsonMatch ? jsonMatch[1].trim() : assistantResponse.trim();

    const testCases = JSON.parse(jsonText);

    if (!Array.isArray(testCases)) {
      throw new Error("Response is not an array");
    }

    // Validate structure
    const validatedTests: GeneratedTestCase[] = testCases.map((tc: any) => ({
      title: tc.title || "Untitled Test",
      query: tc.query || "",
      runs: typeof tc.runs === "number" ? tc.runs : 1,
      expectedToolCalls: Array.isArray(tc.expectedToolCalls)
        ? tc.expectedToolCalls
        : [],
      judgeRequirement: tc.judgeRequirement,
    }));

    return validatedTests;
  } catch (parseError) {
    console.error("Failed to parse LLM response:", assistantResponse);
    throw new Error(
      `Failed to parse test cases from LLM response: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
    );
  }
}
