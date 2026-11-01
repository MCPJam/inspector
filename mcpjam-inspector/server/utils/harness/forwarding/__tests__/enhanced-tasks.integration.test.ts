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

it.each([["form", false], ["url", false], ["form", true]] as const)(
  "composes preflight with Task %s input (deny continuation: %s)",
  async (mode, denyContinuation) => {
    const inputRequests = {
      consent: {
        method: "elicitation/create",
        params: mode === "url"
          ? { mode: "url", message: "Authorize this task.", url: "https://example.com/consent" }
          : { mode: "form", message: "Name?", requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      },
    };
    const fixture = await serveExtensionTasksFixture({ tools: {
      task_tool: {
        mode: "task",
        beforeTask: {
          requestState: "opaque-preflight-state",
          inputRequests: { preflight: { method: "elicitation/create", params: {
            mode: "form", message: "Confirm work.", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"] },
          } } },
        },
        phases: [
          { status: "input_required", inputRequests, awaitInputKeys: ["consent"] },
          { status: "completed", result: { content: [{ type: "text", text: "Finished once" }] } },
        ],
      },
    } });
    const manager = new MCPClientManager();
    const legs: number[] = [];
    const order: string[] = [];
    manager.setMrtrInputCollector("server", async () => {
      expect(fixture.tasks()).toHaveLength(0);
      return { preflight: { action: "accept", content: { confirm: true } } };
    }, { aroundLeg: async ({ round, send }) => {
      legs.push(round);
      if (denyContinuation && round > 0) throw new Error("Continuation denied");
      return send();
    } });
    const connect = () => manager.connectToServer("server", { url: fixture.url, mcpProtocolVersion: "2026-07-28" });
    try {
      await connect();
      let taskId = "";
      const pending = enhancedTaskCall({
        manager, serverId: "server", signal: new AbortController().signal,
        message: { jsonrpc: "2.0", id: "create", method: "tools/call", params: { name: "task_tool", arguments: { unchanged: true } } },
        settle: async () => { order.push("settled"); },
        tasks: { mode: "expose", surface: "chat", onTaskCreated: (event) => {
          taskId = event.identity.taskId;
          order.push("created");
        } },
      });
      if (denyContinuation) {
        await expect(pending).rejects.toThrow("Continuation denied");
        expect(fixture.tasks()).toHaveLength(0);
        expect(fixture.received.filter((r) => r.method === "tools/call")).toHaveLength(1);
        expect(order).toEqual([]);
        return;
      }
      await pending;
      expect(order).toEqual(["settled", "created"]);
      expect(legs).toEqual([0, 1]);
      expect(fixture.tasks()).toHaveLength(1);
      const calls = fixture.received.filter((r) => r.method === "tools/call");
      expect(calls).toHaveLength(2);
      expect(calls[1].params).toMatchObject({ arguments: { unchanged: true }, requestState: "opaque-preflight-state", inputResponses: { preflight: { action: "accept", content: { confirm: true } } } });
      await manager.disconnectAllServers();
      await connect();
      expect((await manager.getTaskExt("server", taskId)).status).toBe("input_required");
      await manager.updateTask("server", taskId, {
        consent: mode === "url" ? { action: "accept" } : { action: "accept", content: { name: "Luca" } },
      });
      const result = await manager.getTaskExt("server", taskId);
      expect(result).toMatchObject({ status: "completed", result: { content: [{ type: "text", text: "Finished once" }] } });
      expect(fixture.received.filter((r) => r.method === "tools/call")).toHaveLength(2);
      const updates = fixture.received.filter((r) => r.method === "tasks/update");
      expect(updates).toHaveLength(1);
      expect(updates[0].params).toMatchObject({ taskId, inputResponses: { consent: mode === "url" ? { action: "accept" } : { action: "accept", content: { name: "Luca" } } } });
      expect(updates[0].params.inputResponses).toEqual({ consent: mode === "url" ? { action: "accept" } : { action: "accept", content: { name: "Luca" } } });
    } finally {
      await manager.disconnectAllServers();
      await fixture.close();
    }
  },
);
