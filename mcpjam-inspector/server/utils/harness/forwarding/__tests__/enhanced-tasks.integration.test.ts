import { expect, it } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { serveExtensionTasksFixture } from "../../../../../../sdk/tests/support/extension-tasks-fixture";
import { enhancedTaskCall } from "../enhanced-tasks";

it("creates once, preserves its receipt, and completes through fresh task connections", async () => {
  const fixture = await serveExtensionTasksFixture();
  const manager = new MCPClientManager();
  const connect = () =>
    manager.connectToServer("server", {
      url: fixture.url,
      mcpProtocolVersion: "2026-07-28",
    });
  try {
    await connect();
    let taskId = "";
    let rawReceipt = "";
    const response = await enhancedTaskCall({
      manager,
      serverId: "server",
      message: {
        jsonrpc: "2.0",
        id: "create",
        method: "tools/call",
        params: { name: "task_tool", arguments: {} },
      },
      signal: new AbortController().signal,
      settle: async (result) => {
        rawReceipt = result.resultJson ?? "";
      },
      tasks: {
        mode: "expose",
        surface: "chat",
        onTaskCreated: (event) => {
          taskId = event.identity.taskId;
        },
      },
    });
    expect(taskId).not.toBe("");
    expect(JSON.parse(rawReceipt).result.taskId).toBe(taskId);
    expect(response.result.content[0]).toMatchObject({ type: "text" });
    await manager.disconnectAllServers();
    await connect();
    await manager.getTaskExt("server", taskId);
    const input = await manager.getTaskExt("server", taskId);
    expect(input.status).toBe("input_required");
    await manager.updateTask("server", taskId, {
      name: { action: "accept", content: { name: "Luca" } },
    });
    let result = await manager.getTaskExt("server", taskId);
    for (let i = 0; i < 5 && result.status !== "completed"; i++)
      result = await manager.getTaskExt("server", taskId);
    expect(result.status).toBe("completed");
    expect(
      fixture.received.filter((r) => r.method === "tools/call"),
    ).toHaveLength(1);
  } finally {
    await manager.disconnectAllServers();
    await fixture.close();
  }
});
