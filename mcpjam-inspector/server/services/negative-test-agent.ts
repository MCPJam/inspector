import type { ModelMessage } from "ai";
import { logger } from "../utils/logger";

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: any;
  outputSchema?: any;
  serverId: string;
}

export interface GeneratedNegativeTestCase {
  title: string;
  scenario: string; // Description of when app should NOT trigger
  query: string; // User prompt that should NOT trigger tools
  runs: number;
}

const NEGATIVE_TEST_CASE_COUNT = 3;

const AGENT_SYSTEM_PROMPT = `You are an AI agent specialized in creating negative test cases for MCP (Model Context Protocol) servers.

**About MCP:**
The Model Context Protocol enables AI assistants to securely access external data and tools. MCP servers expose tools, resources, and prompts that AI models can use to accomplish user tasks.

**Your Task:**
Generate negative test cases - scenarios where the AI assistant should NOT use any tools. These test cases help ensure the AI doesn't incorrectly trigger tools when they're not needed.

**What are Negative Test Cases?**
Negative test cases are prompts that might seem similar to tool-triggering prompts but should NOT result in any tool being called. Examples:
- Questions about the tools themselves (meta-questions)
- Requests that use similar keywords but are unrelated
- Incomplete or ambiguous requests
- General conversation that doesn't require tool usage
- Requests that can be answered from the AI's general knowledge

**Guidelines:**
1. **Edge Cases**: Create prompts that test the boundary between triggering and not triggering tools
2. **Similar Keywords**: Use words that appear in tool descriptions but in non-actionable contexts
3. **Meta Questions**: Ask about capabilities, documentation, or how tools work
4. **Ambiguous Requests**: Create vague or unclear requests that shouldn't trigger tools
5. **Conversational**: Include casual conversation that mentions tool-related topics
6. **Descriptive Scenarios**: Provide clear descriptions of why each case should NOT trigger tools

**Test Case Distribution:**
Generate 3 negative test cases covering different categories:
- 1 Meta/documentation question (asking about tools, not using them)
- 1 Similar keywords in non-actionable context
- 1 Ambiguous or conversational prompt

**Output Format (CRITICAL):**
Respond with ONLY a valid JSON array. No explanations, no markdown code blocks, just the raw JSON array.

Each test case must include:
- title: Clear, descriptive title (e.g., "Meta question about file operations")
- scenario: Description of why this should NOT trigger tools (e.g., "User is asking about capabilities, not requesting an action")
- query: The user prompt that should NOT trigger any tools
- runs: Number of times to run (usually 1)

Example:
[
  {
    "title": "Documentation inquiry about search",
    "scenario": "User is asking about how the search feature works, not performing a search",
    "query": "Can you explain what parameters the search tool accepts?",
    "runs": 1
  },
  {
    "title": "Casual mention of files",
    "scenario": "User is having a general conversation that mentions files but doesn't request file operations",
    "query": "I was reading about file systems yesterday. They're quite interesting!",
    "runs": 1
  },
  {
    "title": "Ambiguous request without clear action",
    "scenario": "User's request is too vague to determine a specific tool action",
    "query": "I might need something with that later",
    "runs": 1
  }
]`;

/**
 * Generates negative test cases using the backend LLM
 * Negative test cases are scenarios where NO tools should be triggered
 */
export async function generateNegativeTestCases(
  tools: DiscoveredTool[],
  convexHttpUrl: string,
  convexAuthToken: string,
): Promise<GeneratedNegativeTestCase[]> {
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

  const userPrompt = `Generate ${NEGATIVE_TEST_CASE_COUNT} negative test cases for the following MCP server tools.

These are the tools that SHOULD NOT be triggered by your test prompts:

${toolsContext}

**Available Resources:**
- ${serverCount} MCP server(s)
- ${totalTools} total tools

**Remember:**
1. Create exactly ${NEGATIVE_TEST_CASE_COUNT} negative tests covering:
   - 1 Meta/documentation question
   - 1 Similar keywords in non-actionable context
   - 1 Ambiguous or conversational prompt
2. Each prompt should NOT trigger ANY of the tools listed above
3. Provide clear scenarios explaining why tools should not be triggered
4. Use keywords from tool descriptions but in non-actionable ways
5. Respond with ONLY a JSON array - no other text or markdown`;

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
    throw new Error(`Failed to generate negative test cases: ${errorText}`);
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
    const validatedTests: GeneratedNegativeTestCase[] = testCases.map(
      (tc: any) => ({
        title: tc.title || "Untitled Negative Test",
        scenario: tc.scenario || "No scenario provided",
        query: tc.query || "",
        runs: typeof tc.runs === "number" ? tc.runs : 1,
      }),
    );

    if (validatedTests.length > NEGATIVE_TEST_CASE_COUNT) {
      return validatedTests.slice(0, NEGATIVE_TEST_CASE_COUNT);
    }

    if (validatedTests.length < NEGATIVE_TEST_CASE_COUNT) {
      logger.warn(
        "[negative-test-agent] LLM returned fewer negative tests than requested",
        {
          requestedCount: NEGATIVE_TEST_CASE_COUNT,
          returnedCount: validatedTests.length,
        },
      );
    }

    return validatedTests;
  } catch (parseError) {
    logger.error("Failed to parse LLM response:", parseError, {
      assistantResponse,
    });
    throw new Error(
      `Failed to parse negative test cases from LLM response: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
    );
  }
}

/**
 * Converts generated negative test cases to the format expected by the eval system
 */
export function convertToEvalTestCases(
  negativeTestCases: GeneratedNegativeTestCase[],
): Array<{
  title: string;
  query: string;
  runs: number;
  expectedToolCalls: never[];
  isNegativeTest: true;
}> {
  return negativeTestCases.map((tc) => ({
    title: tc.title,
    query: tc.query,
    runs: tc.runs,
    expectedToolCalls: [] as never[],
    isNegativeTest: true as const,
  }));
}
