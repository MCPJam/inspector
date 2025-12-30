import { MCPClientManager } from "../src/mcp-client-manager/index.js";

async function main() {
  const manager = new MCPClientManager(
    {
      everything: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything"],
      },
    },
    {
      defaultClientName: "Examples Client",
      defaultClientVersion: "1.0.0",
    },
  );

  // List tools
  const tools = await manager.listTools("everything");
  console.log(tools);

  // Execute tool
  const addToolResult = await manager.executeTool("everything", "add", {
    a: 1,
    b: 2,
  });
  console.log(addToolResult);

  // List resources
  const resources = await manager.listResources("everything");
  console.log(resources);

  // Read resource
  const resource = await manager.readResource("everything", {
    uri: "test://static/resource/1",
  });
  console.log(resource);

  // Subscribe to resource
  const subscription = await manager.subscribeResource("everything", {
    uri: "test://static/resource/1",
  });
  console.log(subscription);

  // Unsubscribe from resource
  await manager.unsubscribeResource("everything", {
    uri: "test://static/resource/1",
  });
  console.log("Unsubscribed from resource");

  // List prompts
  const prompts = await manager.listPrompts("everything");
  console.log(prompts);

  // Get prompt
  const prompt = await manager.getPrompt("everything", {
    name: "simple_prompt",
  });
  console.log(prompt);

  // Ping server
  await manager.pingServer("everything");
  console.log("Pinged server");

  // Disconnect server
  await manager.disconnectServer("everything");
  console.log("Disconnected server");
}

main().catch((error) => {
  console.error("Test run failed:", error);
});
