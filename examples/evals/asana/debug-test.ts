import "dotenv/config";
import { MCPClientManager, TestAgent, EvalTest, EvalSuite } from "@mcpjam/sdk";

async function main() {
  if (!process.env.ASANA_TOKEN || !process.env.ANTHROPIC_API_KEY) {
    throw new Error("Missing required environment variables");
  }

  // Connect to Asana MCP server
  const clientManager = new MCPClientManager();
  await clientManager.connectToServer("asana", {
    url: "https://mcp.asana.com/sse",
    requestInit: {
      headers: {
        Authorization: `Bearer ${process.env.ASANA_TOKEN}`,
      },
    },
  });

  // Get tools and log them
  const tools = await clientManager.getToolsForAiSdk(["asana"]);
  console.log("Number of tools:", Object.keys(tools).length);
  console.log("Tool names:", Object.keys(tools).slice(0, 5), "...");

  // Create TestAgent
  const testAgent = new TestAgent({
    tools,
    model: "anthropic/claude-haiku-4.5",
    apiKey: process.env.ANTHROPIC_API_KEY!,
    systemPrompt: "You are an assistant with access to Asana project management tools. Use the available tools to help users manage their workspaces, projects, and tasks.",
    maxSteps: 5,
  });

  // Run a single prompt and log the result
  console.log("\n--- Running single prompt ---");
  const result = await testAgent.prompt("Show me all my Asana workspaces");

  console.log("Text response length:", result.text.length);
  console.log("Text (first 200 chars):", result.text.substring(0, 200));
  console.log("Tools called:", result.toolsCalled());
  console.log("Has error:", result.hasError());
  if (result.hasError()) {
    console.log("Error:", result.getError());
  }
  console.log("Tool calls detail:", result.getToolCalls());
  console.log("Token usage:", result.getUsage());
  console.log("Latency:", result.getLatency());

  // Now run an EvalTest to see what happens
  console.log("\n--- Running EvalTest with 2 iterations ---");
  const evalTest = new EvalTest({
    name: "list-workspaces",
    prompt: "Show me all my Asana workspaces",
    expectTools: ["asana_list_workspaces"],
  });

  const evalResult = await evalTest.run(testAgent, {
    iterations: 2,
    concurrency: 1,
    retries: 0,
    timeoutMs: 30000,
  });

  console.log("EvalTest results:");
  console.log("  Iterations:", evalResult.iterations);
  console.log("  Successes:", evalResult.successes);
  console.log("  Failures:", evalResult.failures);
  console.log("  Results array:", evalResult.results);
  console.log("  Accuracy:", evalTest.accuracy());

  // Log iteration details
  for (let i = 0; i < evalResult.iterationDetails.length; i++) {
    const detail = evalResult.iterationDetails[i];
    console.log(`\n  Iteration ${i}:`);
    console.log(`    Passed: ${detail.passed}`);
    console.log(`    Error: ${detail.error || "none"}`);
    console.log(`    Tokens: ${JSON.stringify(detail.tokens)}`);
  }

  await clientManager.disconnectServer("asana");
}

main().catch(console.error);
