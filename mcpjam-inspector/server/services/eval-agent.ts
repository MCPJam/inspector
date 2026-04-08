import type { ModelMessage } from "ai";
import { normalizePromptTurns, type PromptTurn } from "@/shared/prompt-turns";
import { logger } from "../utils/logger";
import type { ServerToolSnapshot } from "../utils/export-helpers.js";
import {
  flattenServerToolSnapshotTools,
  renderServerToolSnapshotSection,
} from "../utils/export-helpers.js";

const TOTAL_TEST_CASE_COUNT = 8;
const NEGATIVE_TEST_CASE_COUNT = 2;

export interface GenerateTestsRequest {
  serverIds: string[];
  toolSnapshot: ServerToolSnapshot;
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
  promptTurns?: PromptTurn[];
}

export const AGENT_SYSTEM_PROMPT = `You are an AI agent specialized in creating realistic test cases for MCP (Model Context Protocol) servers.

**About MCP:**
The Model Context Protocol enables AI assistants to securely access external data and tools. MCP servers expose tools, resources, and prompts that AI models can use to accomplish user tasks. Your test cases should reflect real-world usage patterns where users ask an AI assistant to perform tasks, and the assistant uses MCP tools to fulfill those requests.

**Your Task:**
Generate 8 test cases total:
- 6 normal test cases (where tools SHOULD be triggered)
- 2 negative test cases (where tools should NOT be triggered)

**Normal Test Case Distribution (6 tests):**
- **2 EASY single-turn tests** (single tool): Simple, straightforward tasks using one tool
- **2 MEDIUM single-turn tests** (2+ tools): Multi-step workflows requiring 2-3 tools in sequence or parallel
- **1 MEDIUM multi-turn test** (2 turns): Follow-up workflow where the user continues from the first result
- **1 HARD multi-turn test** (2-3 turns): More complex scenario requiring 3+ tools overall, conditional logic, or cross-server operations

**Negative Test Cases (2 tests):**
Negative test cases are prompts where the AI assistant should NOT use any tools. These help ensure the AI doesn't incorrectly trigger tools when they're not needed.
- **1 Meta/documentation question**: Ask about capabilities, documentation, or how tools work
- **1 Ambiguous or clearly non-actionable request**: Vague or conversational prompt that should not trigger tools

**Guidelines for Normal Tests:**
1. **Realistic User Queries**: Write queries as if a real user is talking to an AI assistant
2. **Natural Workflows**: Chain tools together in logical sequences that solve real problems
3. **Cross-Server Tests**: If multiple servers are available, create tests that use tools from different servers together
4. **Specific Details**: Include concrete examples only when they are discoverable, user-supplied, or safely generic
5. **Test Titles**: Write clear, descriptive titles WITHOUT difficulty prefixes
6. **Tool descriptions are authoritative**: If a tool description implies another tool must be called first or before first use, include that prerequisite in expectedToolCalls
7. **No heuristic cleanup**: Do not drop discovery or prerequisite steps unless the tool metadata makes them unnecessary
8. **Attributable cases over synthetic fixtures**: Do not write long tests that rely on fake names, ids, places, premium-only assumptions, or other unestablished workspace fixtures
9. **Discovery-backed cases**: Prefer shorter tests that first resolve the live entity they act on, or switch to a safer capability variant that does not depend on brittle workspace state
10. **Preserve stable sequences**: If the capability naturally requires a recurring discovery or bootstrap pattern, keep that stable sequence in expectedToolCalls instead of simplifying it away
11. **Rewrite brittle workflows**: If a candidate workflow would only pass with unverified workspace fixtures, replace it with a substantially different but still relevant case that can cleanly attribute future failures to the MCP server
12. **Include multi-turn examples**: At least 2 normal tests must use promptTurns with 2-3 user turns
13. **Make turn 1 actionable**: For multi-turn tests, the first turn should already trigger at least one tool so the case remains attributable and easy to summarize
14. **Turn-level assertions**: In multi-turn tests, keep expected tool calls on the specific turn where they should happen instead of collapsing everything onto the last turn

**Guidelines for Negative Tests:**
1. **Edge Cases**: Create prompts that test the boundary between triggering and not triggering tools
2. **Meta Questions**: Ask about capabilities, documentation, or how tools work (not using them)
3. **Conversational**: Include casual conversation, ambiguity, or vague phrasing that still should not trigger tools
4. **Inventory is context only**: Negative tests must still keep expectedToolCalls as []

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
- promptTurns: Optional array for multi-turn tests
  - prompt: User message for that turn
  - expectedToolCalls: Tool calls expected during that turn
  - expectedOutput: Optional expected response for that turn

For multi-turn tests:
- Keep top-level query aligned to the first user turn
- Keep top-level expectedToolCalls aligned to the first turn's expected tool calls
- Use top-level expectedOutput for the overall expected final outcome

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
    ]
  },
  {
    "title": "Research then follow up on the top result",
    "query": "Find the most recent incident related to API latency and summarize it for me",
    "runs": 1,
    "scenario": "User first asks for a search, then asks a follow-up that depends on the first result",
    "expectedOutput": "The AI identifies the relevant incident, then provides a focused follow-up summary after the second user turn",
    "expectedToolCalls": [
      {
        "toolName": "search_incidents",
        "arguments": {}
      }
    ],
    "promptTurns": [
      {
        "prompt": "Find the most recent incident related to API latency and summarize it for me",
        "expectedToolCalls": [
          {
            "toolName": "search_incidents",
            "arguments": {}
          }
        ],
        "expectedOutput": "The AI returns the latest latency incident with a short summary"
      },
      {
        "prompt": "Now pull the full details for that incident and give me the customer impact",
        "expectedToolCalls": [
          {
            "toolName": "get_incident_details",
            "arguments": {}
          }
        ],
        "expectedOutput": "The AI explains the detailed incident timeline and customer impact"
      }
    ]
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
    "title": "Ambiguous request without an actionable task",
    "query": "I might need something with that later, but I'm still thinking.",
    "runs": 1,
    "scenario": "User has not actually asked the assistant to do anything yet",
    "expectedOutput": "AI asks a clarifying question or acknowledges the ambiguity without calling tools",
    "expectedToolCalls": [],
    "isNegativeTest": true
  }
]`;

/**
 * Generates test cases using the backend LLM
 */
export async function generateTestCases(
  toolSnapshot: ServerToolSnapshot,
  convexHttpUrl: string,
  convexAuthToken: string,
): Promise<GeneratedTestCase[]> {
  const tools = flattenServerToolSnapshotTools(toolSnapshot);
  const serverCount = toolSnapshot.servers.length;
  const totalTools = tools.length;
  const toolsContext =
    renderServerToolSnapshotSection(toolSnapshot).promptSection ??
    "# Available MCP Tools\nNo tools captured.";

  const crossServerGuidance =
    serverCount > 1
      ? `\n**IMPORTANT**: You have ${serverCount} servers available. Create at least 2 test cases that use tools from MULTIPLE servers to test cross-server workflows.`
      : "";

  const userPrompt = `Generate ${TOTAL_TEST_CASE_COUNT} test cases for the following MCP server tools:

${toolsContext}

**Available Resources:**
- ${serverCount} MCP server(s)
- ${totalTools} total tools${crossServerGuidance}

**Remember:**
1. Create exactly ${TOTAL_TEST_CASE_COUNT} tests:
   - 6 normal tests: 2 EASY single-turn, 2 MEDIUM single-turn, 1 MEDIUM multi-turn, 1 HARD multi-turn
   - ${NEGATIVE_TEST_CASE_COUNT} negative tests: 1 meta/doc question, 1 ambiguous or clearly non-actionable prompt
2. Write realistic user queries that sound natural
3. Include scenario and expectedOutput for ALL tests
4. Prefer short, discovery-backed cases over long synthetic workflows with invented workspace entities
5. Include at least 2 multi-turn tests using promptTurns with 2-3 turns
6. In multi-turn tests, make the first turn actionable and keep top-level query/expectedToolCalls aligned with turn 1
7. For negative tests, use keywords from tools only in non-actionable contexts
8. If tool descriptions imply prerequisites or a stable discovery sequence, include them explicitly in expectedToolCalls
9. Do not rely on fake names, ids, places, premium-only assumptions, or other unverified live fixtures unless an earlier step establishes them
10. If a workflow depends on brittle live state, replace it with a safer attributable variant instead of preserving the same scenario
11. Respond with ONLY a JSON array - no other text or markdown`;

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
      // Keeps OpenRouter spend reservation low (JSON test list fits easily).
      maxOutputTokens: 12288,
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

    // Validate structure and normalize expectedToolCalls / promptTurns format
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

      const normalizedPromptTurns = normalizePromptTurns(tc.promptTurns);
      const firstTurn = normalizedPromptTurns[0];
      const isNegativeTest =
        tc.isNegativeTest === true ||
        (normalizedPromptTurns.length > 0 &&
          normalizedPromptTurns.every(
            (turn) => turn.expectedToolCalls.length === 0,
          ));

      if (firstTurn?.expectedToolCalls?.length) {
        normalizedToolCalls = firstTurn.expectedToolCalls;
      }

      return {
        title: tc.title || "Untitled Test",
        query: tc.query || firstTurn?.prompt || "",
        runs: typeof tc.runs === "number" ? tc.runs : 1,
        expectedToolCalls: normalizedToolCalls,
        scenario:
          tc.scenario ||
          (isNegativeTest ? "Negative test case" : "No scenario provided"),
        expectedOutput:
          tc.expectedOutput ||
          normalizedPromptTurns[normalizedPromptTurns.length - 1]?.expectedOutput ||
          (isNegativeTest
            ? "AI responds without calling any tools"
            : "No expected output provided"),
        isNegativeTest,
        promptTurns:
          normalizedPromptTurns.length > 0 ? normalizedPromptTurns : undefined,
      };
    });

    if (validatedTests.length > TOTAL_TEST_CASE_COUNT) {
      return validatedTests.slice(0, TOTAL_TEST_CASE_COUNT);
    }

    if (validatedTests.length < TOTAL_TEST_CASE_COUNT) {
      logger.warn("[eval-agent] LLM returned fewer test cases than requested", {
        requestedCount: TOTAL_TEST_CASE_COUNT,
        returnedCount: validatedTests.length,
      });
    }

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
