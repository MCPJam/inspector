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

const AGENT_SYSTEM_PROMPT = `You are an AI agent specialized in creating comprehensive test cases for MCP (Model Context Protocol) servers.

Your task is to analyze the provided tools and generate thorough test cases that validate MCP server functionality.

**Instructions:**
1. For each tool provided, create 1-3 test cases that cover different usage scenarios
2. Each test case should have:
   - A descriptive title
   - A realistic user query that would trigger the tool
   - The expected tool(s) to be called
   - A judge requirement explaining what constitutes success
3. Aim for diverse scenarios: simple cases, edge cases, multi-tool workflows
4. Make queries natural and realistic as if a real user would ask them

**Output Format (CRITICAL):**
You MUST respond with ONLY a valid JSON array. No explanations, no markdown, just the JSON array.

Example:
[
  {
    "title": "Basic file read",
    "query": "Read the contents of config.json",
    "runs": 1,
    "expectedToolCalls": ["read_file"],
    "judgeRequirement": "The tool should successfully read and return file contents"
  },
  {
    "title": "Multi-step file operation",
    "query": "List all files in the current directory and read the first one",
    "runs": 1,
    "expectedToolCalls": ["list_files", "read_file"],
    "judgeRequirement": "Should first list files, then read one of them"
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
  // Build context about available tools
  const toolsContext = tools
    .map((tool) => {
      return `Tool: ${tool.name}
Server: ${tool.serverId}
Description: ${tool.description || "No description"}
Input Schema: ${JSON.stringify(tool.inputSchema, null, 2)}`;
    })
    .join("\n\n---\n\n");

  const userPrompt = `Generate test cases for the following MCP server tools:

${toolsContext}

Remember: Respond with ONLY a JSON array of test cases. No other text.`;

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
      tools: [], // No tools needed for generation
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
