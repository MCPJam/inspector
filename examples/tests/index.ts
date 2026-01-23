import { MCPClientManager, TestAgent, EvalTest } from "@mcpjam/sdk";

const manager = new MCPClientManager({
  asana: {
    url: new URL("https://mcp.asana.com/sse"),
    accessToken: process.env.ASANA_ACCESS_TOKEN!,
  },
});

// Debug: Check connection status and tools loaded
console.log("Connection status:", manager.getConnectionStatus("asana"));

const tools = await manager.getToolsForAiSdk("asana");
console.log("Tools loaded:", Object.keys(tools).length);
if (Object.keys(tools).length > 0) {
  console.log("Available tools:", Object.keys(tools).slice(0, 5).join(", "), "...");
}

const testAgent = new TestAgent({
  tools,
  llm: "openai/gpt-5-mini",
  apiKey: process.env.OPENAI_API_KEY!,
});

const projectLifecycleTest = new EvalTest({
  name: "Project Lifecycle Flow",
  test: async (agent) => {
    // Turn 1: Create a project
    const r1 = await agent.prompt(
      'Create a new Asana project called "Website Redesign"',
    );
    if (!r1.toolsCalled().includes("asana_create_project")) {
      return false;
    }

    // Turn 2: Add tasks to the project
    const r2 = await agent.prompt(`
      Add these tasks to the Website Redesign project:
      1. Research current website design trends
      2. Create wireframes for the new design
      3. Develop the new website layout
      4. Test the new design for usability
      5. Launch the redesigned website
    `);
    if (!r2.toolsCalled().includes("asana_create_task")) {
      return false;
    }

    // Turn 3: Set due dates on the tasks
    const r3 = await agent.prompt(
      "Set due dates for all tasks in the Website Redesign project, spacing them one week apart starting from next Monday",
    );

    return r3.toolsCalled().includes("asana_update_task");
  },
});

await projectLifecycleTest.run(testAgent, { iterations: 1 });

console.log("Accuracy:", projectLifecycleTest.accuracy());
console.log("Results:", projectLifecycleTest.getResults());

console.log();

console.dir(projectLifecycleTest, { depth: null });

// Debug: Check for errors in failed iterations
// const results = projectLifecycleTest.getResults();
// for (const iteration of results.iterationDetails) {
//   if (!iteration.passed) {
//     console.log("\n--- Failed Iteration Debug ---");
//     if (iteration.error) {
//       console.log("Iteration error:", iteration.error);
//     }
//     if (iteration.prompts) {
//       for (const p of iteration.prompts) {
//         console.log("Prompt:", p);
//         if (p.hasError && p.hasError()) {
//           console.log("Prompt error:", p.getError());
//         }
//       }
//     }
//   }
// }

// Cleanup: Disconnect MCP server so process can exit
console.log("\nCleaning up MCP connections...");
await manager.disconnectServer("asana");
console.log("Done.");
