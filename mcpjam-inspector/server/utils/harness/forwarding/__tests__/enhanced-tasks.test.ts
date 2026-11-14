import { it, expect, vi } from "vitest";
import { MCPClientManager } from "@mcpjam/sdk";
import { enhancedTaskCall } from "../enhanced-tasks";

it("settles the raw Task before publishing it and synthesizing model output", async () => {
  const manager = new MCPClientManager();
  vi.spyOn(manager, "getTasksSupport").mockReturnValue({
    wire: "extension",
    toolCalls: true,
    list: false,
    cancel: true,
    update: true,
    inlineResult: true,
  });
  const raw = {
    resultType: "task",
    taskId: "task",
    status: "working",
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    ttlMs: null,
  };
  const execute = vi.spyOn(manager, "executeTool").mockResolvedValue(raw);
  const order: string[] = [];
  const signal = new AbortController().signal;
  const result = await enhancedTaskCall({
    manager,
    serverId: "server",
    message: {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "work", arguments: { n: 1 }, _meta: {
        progressToken: "task-progress", "example.org/context": {keep:true},
        "io.modelcontextprotocol/clientCapabilities": {spoofed:true},
      } },
    },
    signal,
    settle: async (s) => {
      expect(JSON.parse(s.resultJson!)).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: raw,
      });
      order.push("settled");
    },
    tasks: {
      mode: "expose",
      surface: "chat",
      resolveIdentity: () => ({ serverId: "server", connectionId: "account" }),
      onTaskCreated: (event) => {
        expect(event.identity.connectionId).toBe("account");
        order.push("created");
      },
    },
  });
  expect(order).toEqual(["settled", "created"]);
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    "server",
    "work",
    { n: 1 },
    { allowTaskResult: true, request: { signal }, metadata: {
      progressToken:"task-progress", "example.org/context":{keep:true},
    } },
  );
  expect(result.result.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: "text" })]),
  );
});

it("does not opt an unsupported server into Tasks", async () => {
  const manager = new MCPClientManager();
  vi.spyOn(manager, "getTasksSupport").mockReturnValue({
    wire: "none",
    toolCalls: false,
    list: false,
    cancel: false,
    update: false,
    inlineResult: false,
  });
  const raw = { content: [{ type: "text" as const, text: "ok" }] };
  const execute = vi.spyOn(manager, "executeTool").mockResolvedValue(raw);
  const onTaskCreated = vi.fn();
  const signal = new AbortController().signal;
  expect(
    (
      await enhancedTaskCall({
        manager,
        serverId: "server",
        message: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "sync" },
        },
        signal,
        tasks: { mode: "expose", surface: "chat", onTaskCreated },
      })
    ).result,
  ).toEqual(raw);
  expect(execute).toHaveBeenCalledExactlyOnceWith(
    "server",
    "sync",
    {},
    { request: { signal } },
  );
  expect(onTaskCreated).not.toHaveBeenCalled();
});
