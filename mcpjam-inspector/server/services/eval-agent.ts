import type { ModelMessage } from "ai";
import { logger } from "../utils/logger";

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
  serverId: string;
}

export interface GenerateTestsRequest {
  serverIds: string[];
  tools: DiscoveredTool[];
}

export interface GeneratedTestCase {
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: Array<{
    toolName: string;
    arguments: Record<string, any>;
  }>;
  scenario: string; // Description of the use case being tested
  expectedOutput: string; // The output or experience expected from the MCP server
  isNegativeTest?: boolean; // When true, test passes if NO tools are called
}

const AGENT_SYSTEM_PROMPT = `You are an AI agent specialized in creating realistic test cases for MCP (Model Context Protocol) servers.

**About MCP:**
The Model Context Protocol enables AI assistants to securely access external data and tools. MCP servers expose tools, resources, and prompts that AI models can use to accomplish user tasks. Your test cases should reflect real-world usage patterns where users ask an AI assistant to perform tasks, and the assistant uses MCP tools to fulfill those requests.

**Your Task:**
Generate 8 test cases total:
- 5 normal test cases (where tools SHOULD be triggered)
- 3 negative test cases (where tools should NOT be triggered)

**Normal Test Case Distribution (5 tests):**
- **2 EASY tests** (single tool): Simple, straightforward tasks using one tool
- **2 MEDIUM tests** (2+ tools): Multi-step workflows requiring 2-3 tools in sequence or parallel
- **1 HARD test** (3+ tools): Complex scenarios requiring 3+ tools, conditional logic, or cross-server operations

**Negative Test Cases (3 tests):**
Negative test cases are prompts where the AI assistant should NOT use any tools. These help ensure the AI doesn't incorrectly trigger tools when they're not needed.
- **1 Meta/documentation question**: Ask about capabilities, documentation, or how tools work
- **1 Similar keywords in non-actionable context**: Use words from tool descriptions but in casual conversation or unrelated contexts
- **1 Ambiguous/incomplete request**: Vague requests that shouldn't trigger tools

**Guidelines for Normal Tests:**
1. **Realistic User Queries**: Write queries as if a real user is talking to an AI assistant
2. **Natural Workflows**: Chain tools together in logical sequences that solve real problems
3. **Cross-Server Tests**: If multiple servers are available, create tests that use tools from different servers together
4. **Specific Details**: Include concrete examples (dates, names, values) to make tests actionable
5. **Test Titles**: Write clear, descriptive titles WITHOUT difficulty prefixes

**Guidelines for Negative Tests:**
1. **Edge Cases**: Create prompts that test the boundary between triggering and not triggering tools
2. **Similar Keywords**: Use words that appear in tool descriptions but in non-actionable contexts
3. **Meta Questions**: Ask about capabilities, documentation, or how tools work (not using them)
4. **Conversational**: Include casual conversation that mentions tool-related topics

**Output Format (CRITICAL):**
Respond with ONLY a valid JSON array. No explanations, no markdown code blocks, just the raw JSON array.

Each test case must include:
- title: Clear, descriptive title
- query: Natural language user query
- runs: Number of times to run (usually 1)
- scenario: Description of the use case (for normal tests) or why tools should NOT trigger (for negative tests)
- expectedOutput: The output or experience expected from the MCP server (for normal tests) or expected AI behavior (for negative tests)
- expectedToolCalls: Array of tool calls (empty [] for negative tests)
  - toolName: Name of the tool to call
  - arguments: Object with expected arguments (can be empty {})
- isNegativeTest: Boolean, true for negative tests, false or omitted for normal tests

Example:
[
  {
    "title": "Read project configuration",
    "query": "Show me the contents of config.json in the current project",
    "runs": 1,
    "scenario": "User needs to view a configuration file to understand project settings",
    "expectedOutput": "The contents of config.json displayed in a readable format",
    "expectedToolCalls": [
      {
        "toolName": "read_file",
        "arguments": {}
      }
    ],
    "isNegativeTest": false
  },
  {
    "title": "Find and analyze recent tasks",
    "query": "Find all tasks created this week and summarize their status",
    "runs": 1,
    "scenario": "User wants to review recent task activity for project management",
    "expectedOutput": "A summary of tasks created this week with their current status",
    "expectedToolCalls": [
      {
        "toolName": "list_tasks",
        "arguments": {}
      },
      {
        "toolName": "get_task_details",
        "arguments": {}
      }
    ],
    "isNegativeTest": false
  },
  {
    "title": "Documentation inquiry about search",
    "query": "Can you explain what parameters the search tool accepts?",
    "runs": 1,
    "scenario": "User is asking about how the search feature works, not performing a search",
    "expectedOutput": "AI provides documentation/explanation without calling any tools",
    "expectedToolCalls": [],
    "isNegativeTest": true
  },
  {
    "title": "Casual mention of files",
    "query": "I was reading about file systems yesterday. They're quite interesting!",
    "runs": 1,
    "scenario": "User is having a general conversation that mentions files but doesn't request file operations",
    "expectedOutput": "AI engages in casual conversation without triggering file tools",
    "expectedToolCalls": [],
    "isNegativeTest": true
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

  const userPrompt = `Generate 8 test cases for the following MCP server tools:

${toolsContext}

**Available Resources:**
- ${serverCount} MCP server(s)
- ${totalTools} total tools${crossServerGuidance}

**Remember:**
1. Create exactly 8 tests:
   - 5 normal tests: 2 EASY (1 tool), 2 MEDIUM (2-3 tools), 1 HARD (3+ tools)
   - 3 negative tests: 1 meta/doc question, 1 similar keywords non-actionable, 1 ambiguous
2. Write realistic user queries that sound natural
3. Include scenario and expectedOutput for ALL tests
4. Use specific examples (dates, filenames, values) for normal tests
5. For negative tests, use keywords from tools but in non-actionable contexts
6. Respond with ONLY a JSON array - no other text or markdown`;

  const messageHistory: ModelMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  // Call the backend LLM API
  const response = await fetch(`${convexHttpUrl}/stream`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${convexAuthToken}`,
    },
    body: JSON.stringify({
      mode: "step",
      model: "anthropic/claude-haiku-4.5",
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

    // Validate structure and normalize expectedToolCalls format
    const validatedTests: GeneratedTestCase[] = testCases.map((tc: any) => {
      let normalizedToolCalls: Array<{
        toolName: string;
        arguments: Record<string, any>;
      }> = [];

      if (Array.isArray(tc.expectedToolCalls)) {
        normalizedToolCalls = tc.expectedToolCalls
          .map((call: any) => {
            // Handle new format: { toolName, arguments }
            if (typeof call === "object" && call !== null && call.toolName) {
              return {
                toolName: call.toolName,
                arguments: call.arguments || {},
              };
            }
            // Handle old format: string (just tool name)
            if (typeof call === "string") {
              return {
                toolName: call,
                arguments: {},
              };
            }
            // Invalid format, skip
            return null;
          })
          .filter((call: any) => call !== null);
      }

      const isNegativeTest = tc.isNegativeTest === true;

      return {
        title: tc.title || "Untitled Test",
        query: tc.query || "",
        runs: typeof tc.runs === "number" ? tc.runs : 1,
        expectedToolCalls: normalizedToolCalls,
        scenario:
          tc.scenario ||
          (isNegativeTest ? "Negative test case" : "No scenario provided"),
        expectedOutput:
          tc.expectedOutput ||
          (isNegativeTest
            ? "AI responds without calling any tools"
            : "No expected output provided"),
        isNegativeTest,
      };
    });

    return validatedTests;
  } catch (parseError) {
    logger.error("Failed to parse LLM response:", parseError, {
      assistantResponse,
    });
    throw new Error(
      `Failed to parse test cases from LLM response: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
    );
  }
}
