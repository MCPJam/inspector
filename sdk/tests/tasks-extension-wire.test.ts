import { describe, expect, it, vi } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { MCPClientManager } from "../src/mcp-client-manager";
import {
  resolveTasksSupport,
  resolveTasksWire,
} from "../src/mcp-client-manager/tasks-dispatch.js";
import { buildTasksExtensionRequestMeta } from "../src/mcp-client-manager/tasks-ext.js";
import {
  assertGetTaskExtResult,
  isCreateTaskExtResult,
  InvalidTaskExtPayloadError,
} from "../src/mcp-client-manager/tasks-ext-guards.js";
import {
  TASK_CREATED_META_KEY,
  rewriteTaskResultMessage,
  wrapFetchForTaskRouting,
} from "../src/mcp-client-manager/transport-utils.js";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client.js";

/**
 * PR2 wire tests for `io.modelcontextprotocol/tasks` (SEP-2663). The
 * dispatch-matrix table is the heart: it pins that the legacy wire never sends
 * the extension declaration, the extension wire never sends `params.task`, and
 * `wire: "none"` sends nothing at all.
 */

const EXT_ID = "io.modelcontextprotocol/tasks";
const EXT_CAPS = { tools: {}, extensions: { [EXT_ID]: {} } } as const;
const LEGACY_CAPS = {
  tools: {},
  tasks: { list: true, cancel: true, requests: { tools: { call: true } } },
} as const;

interface Recorded {
  method: string;
  params?: Record<string, unknown>;
}

function seedManager(options: {
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;
  declaredCapabilities?: Record<string, unknown>;
  requestResult?: unknown;
  callToolResult?: unknown;
}) {
  const serverId = "srv";
  const calls: Recorded[] = [];
  const manager = new MCPClientManager();

  const client = {
    getServerCapabilities: () => options.capabilities,
    getNegotiatedProtocolVersion: () => options.protocolVersion,
    getProtocolEra: () => undefined,
    getServerVersion: () => ({ name: "fixture", version: "1.0.0" }),
    getInstructions: () => undefined,
    request: async (req: Recorded) => {
      calls.push(JSON.parse(JSON.stringify(req)));
      return options.requestResult;
    },
    callTool: async (params: Record<string, unknown>) => {
      calls.push(JSON.parse(JSON.stringify({ method: "tools/call", params })));
      return options.callToolResult ?? { content: [] };
    },
  } as unknown as ManagedMcpClient;

  (manager as any).registeredServers.set(serverId, {
    config: { url: "https://example.test/mcp" },
    timeout: 1000,
  });
  (manager as any).liveClientStates.set(serverId, {
    client,
    initializedClientCapabilities: options.declaredCapabilities,
  });

  return { manager, calls, serverId };
}

describe("resolveTasksSupport (dispatch matrix)", () => {
  const rows = [
    {
      version: "2025-03-26",
      caps: LEGACY_CAPS,
      expected: { wire: "none", toolCalls: false, list: false, cancel: false, update: false, inlineResult: false },
    },
    {
      version: "2025-06-18",
      caps: EXT_CAPS,
      expected: { wire: "none", toolCalls: false, list: false, cancel: false, update: false, inlineResult: false },
    },
    {
      version: "2025-11-25",
      caps: LEGACY_CAPS,
      expected: { wire: "legacy", toolCalls: true, list: true, cancel: true, update: false, inlineResult: false },
    },
    {
      version: "2025-11-25",
      caps: EXT_CAPS,
      expected: { wire: "none", toolCalls: false, list: false, cancel: false, update: false, inlineResult: false },
    },
    {
      version: "2026-07-28",
      caps: EXT_CAPS,
      expected: { wire: "extension", toolCalls: true, list: false, cancel: true, update: true, inlineResult: true },
    },
    {
      version: "2026-07-28",
      caps: LEGACY_CAPS,
      expected: { wire: "none", toolCalls: false, list: false, cancel: false, update: false, inlineResult: false },
    },
    {
      version: undefined,
      caps: EXT_CAPS,
      expected: { wire: "none", toolCalls: false, list: false, cancel: false, update: false, inlineResult: false },
    },
    {
      version: "2099-01-01",
      caps: EXT_CAPS,
      expected: { wire: "none", toolCalls: false, list: false, cancel: false, update: false, inlineResult: false },
    },
  ] as const;

  for (const row of rows) {
    it(`${row.version ?? "<no version>"} + ${JSON.stringify(Object.keys(row.caps))} → ${row.expected.wire}`, () => {
      expect(resolveTasksSupport(row.version, row.caps as never)).toEqual(
        row.expected
      );
      expect(resolveTasksWire(row.version, row.caps as never)).toBe(
        row.expected.wire
      );
    });
  }
});

describe("per-request capability envelope", () => {
  it("merges the extension into the declared capabilities without clobbering", () => {
    const declared = {
      elicitation: { modes: ["form"] },
      roots: { listChanged: true },
      extensions: { "io.modelcontextprotocol/ui": { version: "1" } },
    };
    const meta = buildTasksExtensionRequestMeta(declared as never);
    const value = meta[CLIENT_CAPABILITIES_META_KEY] as Record<string, any>;

    expect(value.elicitation).toEqual({ modes: ["form"] });
    expect(value.roots).toEqual({ listChanged: true });
    expect(value.extensions["io.modelcontextprotocol/ui"]).toEqual({
      version: "1",
    });
    expect(value.extensions[EXT_ID]).toEqual({});
    // Only the capabilities key is written: beta.4's auto-generated
    // protocol-version / client-info envelope entries survive the merge.
    expect(Object.keys(meta)).toEqual([CLIENT_CAPABILITIES_META_KEY]);
  });
});

describe("executeTool wire selection", () => {
  it("extension: declares eligibility in _meta and never sends params.task", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      declaredCapabilities: { extensions: {} } as never,
      callToolResult: { content: [] },
    });

    await manager.executeTool(serverId, "slow_tool", { a: 1 }, {
      allowTaskResult: true,
    } as never);

    const params = calls[0].params as any;
    expect(params.name).toBe("slow_tool");
    expect(params.task).toBeUndefined();
    expect(
      params._meta[CLIENT_CAPABILITIES_META_KEY].extensions[EXT_ID]
    ).toEqual({});
  });

  it("legacy: sends params.task and never the extension declaration", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_CAPS as never,
      requestResult: { task: { taskId: "t-1", status: "working" } },
    });

    await manager.executeTool(serverId, "slow_tool", {}, undefined, {
      ttl: 1000,
    });

    const params = calls[0].params as any;
    expect(params.task).toEqual({ ttl: 1000 });
    expect(params._meta).toBeUndefined();
  });

  it("none: refuses to declare eligibility and sends nothing", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} } as never,
    });

    await expect(
      manager.executeTool(serverId, "slow_tool", {}, {
        allowTaskResult: true,
      } as never)
    ).rejects.toThrow(/has no tasks wire/);
    expect(calls).toEqual([]);
  });

  it("extension: a plain (non-task) result passes through — the server decides", async () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      callToolResult: { content: [{ type: "text", text: "done" }] },
    });

    const result = (await manager.executeTool(serverId, "slow_tool", {}, {
      allowTaskResult: true,
    } as never)) as any;
    expect(result.content).toEqual([{ type: "text", text: "done" }]);
    expect(result.taskId).toBeUndefined();
  });

  it("extension: unwraps a CreateTaskResult smuggled through the decoder", async () => {
    const task = {
      resultType: "task",
      taskId: "task-7",
      status: "working",
      createdAt: "2026-07-27T00:00:00Z",
      lastUpdatedAt: "2026-07-27T00:00:00Z",
      ttlMs: null,
    };
    const { manager, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      callToolResult: {
        content: [],
        _meta: { [TASK_CREATED_META_KEY]: task },
      },
    });

    const result = (await manager.executeTool(serverId, "slow_tool", {}, {
      allowTaskResult: true,
    } as never)) as any;
    expect(result.taskId).toBe("task-7");
    expect(result.status).toBe("working");
    expect(
      result._meta["io.modelcontextprotocol/model-immediate-response"]
    ).toContain("task-7");
  });
});

describe("extension read APIs", () => {
  it("tasks/get carries the declaration and validates the payload", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      requestResult: {
        taskId: "task-7",
        status: "completed",
        createdAt: "2026-07-27T00:00:00Z",
        lastUpdatedAt: "2026-07-27T00:01:00Z",
        ttlMs: 60000,
        result: { content: [{ type: "text", text: "inline" }] },
      },
    });

    const task = await manager.getTaskExt(serverId, "task-7");
    expect(task.result).toEqual({ content: [{ type: "text", text: "inline" }] });
    expect(calls[0].method).toBe("tasks/get");
    expect((calls[0].params as any).taskId).toBe("task-7");
    expect(
      (calls[0].params as any)._meta[CLIENT_CAPABILITIES_META_KEY].extensions[
        EXT_ID
      ]
    ).toEqual({});
  });

  it("tasks/update sends inputResponses with the declaration", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      requestResult: {
        taskId: "task-7",
        status: "working",
        createdAt: "2026-07-27T00:00:00Z",
        lastUpdatedAt: "2026-07-27T00:02:00Z",
        ttlMs: null,
      },
    });

    await manager.updateTask(serverId, "task-7", {
      k1: { method: "elicitation/create", result: { action: "accept" } },
    } as never);

    expect(calls[0].method).toBe("tasks/update");
    expect((calls[0].params as any).inputResponses.k1).toBeDefined();
  });

  it("tasks/cancel returns the empty ack verbatim", async () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      requestResult: {},
    });
    await expect(manager.cancelTaskExt(serverId, "task-7")).resolves.toEqual({});
  });

  it("listTasks answers locally on the extension wire (no network)", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
    });
    await expect(manager.listTasks(serverId)).resolves.toEqual({ tasks: [] });
    expect(calls).toEqual([]);
  });

  it("getTaskResult is a typed error on the extension wire", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
    });
    await expect(manager.getTaskResult(serverId, "task-7")).rejects.toThrow(
      /has no tasks\/result/
    );
    expect(calls).toEqual([]);
  });

  it("extension reads refuse to run on a legacy connection", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_CAPS as never,
    });
    await expect(manager.getTaskExt(serverId, "t")).rejects.toThrow(
      /does not speak the io.modelcontextprotocol\/tasks extension/
    );
    expect(calls).toEqual([]);
  });
});

describe("runtime validation", () => {
  it("rejects a task payload with a bad status or missing timestamps", () => {
    expect(() =>
      assertGetTaskExtResult({ taskId: "x", status: "banana", ttlMs: null })
    ).toThrow(InvalidTaskExtPayloadError);
  });

  it("accepts ttlMs: null and passes unknown keys through", () => {
    const task = assertGetTaskExtResult({
      taskId: "x",
      status: "working",
      createdAt: "now",
      lastUpdatedAt: "now",
      ttlMs: null,
      somethingNew: 1,
    });
    expect(task.ttlMs).toBeNull();
    expect((task as any).somethingNew).toBe(1);
  });

  it("isCreateTaskExtResult keys off resultType only", () => {
    expect(isCreateTaskExtResult({ resultType: "task", taskId: "a" })).toBe(true);
    expect(isCreateTaskExtResult({ taskId: "a" })).toBe(false);
    expect(isCreateTaskExtResult({ resultType: "complete" })).toBe(false);
  });
});

describe("transport seams", () => {
  it("adds Mcp-Name/Mcp-Method to tasks/* POSTs only", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = wrapFetchForTaskRouting(inner as never);

    await wrapped("https://x.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { taskId: "task-7" },
      }),
    });
    const headers = new Headers((inner.mock.calls[0] as any)[1].headers);
    expect(headers.get("mcp-name")).toBe("task-7");
    expect(headers.get("mcp-method")).toBe("tasks/get");

    await wrapped("https://x.test/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "t" },
      }),
    });
    // Non-task bodies are passed through untouched (init identity preserved).
    expect((inner.mock.calls[1] as any)[1].headers).toBeUndefined();
  });

  it("never overwrites an existing mcp-name", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = wrapFetchForTaskRouting(inner as never);
    await wrapped("https://x.test/mcp", {
      method: "POST",
      headers: { "mcp-name": "already" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/cancel",
        params: { taskId: "task-7" },
      }),
    });
    const headers = new Headers((inner.mock.calls[0] as any)[1].headers);
    expect(headers.get("mcp-name")).toBe("already");
  });

  it("rewrites a resultType:'task' response and leaves others alone", () => {
    const taskResponse = {
      jsonrpc: "2.0",
      id: 3,
      result: { resultType: "task", taskId: "task-7", status: "working" },
    } as never;
    const rewritten = rewriteTaskResultMessage(taskResponse) as any;
    expect(rewritten.result.resultType).toBe("complete");
    expect(rewritten.result._meta[TASK_CREATED_META_KEY].taskId).toBe("task-7");

    const plain = {
      jsonrpc: "2.0",
      id: 4,
      result: { resultType: "complete", content: [] },
    } as never;
    expect(rewriteTaskResultMessage(plain)).toBe(plain);

    const notification = { jsonrpc: "2.0", method: "notifications/x" } as never;
    expect(rewriteTaskResultMessage(notification)).toBe(notification);
  });
});

describe("MRTR composition (one result state machine)", () => {
  it("input_required round(s) may terminate in a CreateTaskResult", async () => {
    const serverId = "srv";
    const manager = new MCPClientManager();
    const sent: any[] = [];
    let round = 0;

    const task = {
      resultType: "task",
      taskId: "task-9",
      status: "working",
      createdAt: "2026-07-27T00:00:00Z",
      lastUpdatedAt: "2026-07-27T00:00:00Z",
      ttlMs: null,
    };

    const client = {
      getServerCapabilities: () => EXT_CAPS,
      getNegotiatedProtocolVersion: () => "2026-07-28",
      getProtocolEra: () => undefined,
      getServerVersion: () => ({ name: "fixture", version: "1.0.0" }),
      getInstructions: () => undefined,
      requestWithSchema: async (req: any) => {
        sent.push(JSON.parse(JSON.stringify(req)));
        round += 1;
        if (round === 1) {
          return {
            resultType: "input_required",
            inputRequests: {
              k1: {
                method: "elicitation/create",
                params: {
                  message: "need input",
                  requestedSchema: { type: "object", properties: {} },
                },
              },
            },
            requestState: "state-1",
          };
        }
        // Round 2 resolves to a task: the transport wrapper has already
        // rewritten it into a complete result carrying the task envelope.
        return { content: [], _meta: { [TASK_CREATED_META_KEY]: task } };
      },
    } as unknown as ManagedMcpClient;

    (manager as any).registeredServers.set(serverId, {
      config: { url: "https://example.test/mcp" },
      timeout: 1000,
    });
    (manager as any).liveClientStates.set(serverId, {
      client,
      initializedClientCapabilities: { extensions: {} },
    });

    manager.setMrtrInputCollector(serverId, async () => ({
      k1: { method: "elicitation/create", result: { action: "decline" } } as never,
    }));

    const result = (await manager.executeTool(serverId, "slow_tool", { a: 1 }, {
      allowTaskResult: true,
    } as never)) as any;

    expect(result.taskId).toBe("task-9");
    expect(sent).toHaveLength(2);
    // The declaration rides on every leg of the shared state machine.
    for (const req of sent) {
      expect(
        req.params._meta[CLIENT_CAPABILITIES_META_KEY].extensions[EXT_ID]
      ).toEqual({});
      expect(req.params.task).toBeUndefined();
    }
    expect(sent[1].params.requestState).toBe("state-1");
  });
});
