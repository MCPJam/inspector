import { describe, expect, it, vi } from "vitest";
import { CLIENT_CAPABILITIES_META_KEY } from "@modelcontextprotocol/client";
import { MCPClientManager } from "../src/mcp-client-manager";
import {
  resolveTasksSupport,
  resolveTasksWire,
  serverDeclaresTasksExtension,
} from "../src/mcp-client-manager/tasks-dispatch.js";
import { buildTasksExtensionRequestMeta } from "../src/mcp-client-manager/tasks-ext.js";
import {
  assertGetTaskExtResult,
  assertTaskExtAck,
  isCreateTaskExtResult,
  InvalidTaskExtPayloadError,
} from "../src/mcp-client-manager/tasks-ext-guards.js";
import {
  describeTaskExtInputRequests,
  isRecognizedInputRequestMethod,
} from "../src/mcp-client-manager/tasks-ext-schemas.js";
import { MCPTasksWireError } from "../src/mcp-client-manager/errors.js";
import {
  TASK_CREATED_META_KEY,
  rewriteTaskResultMessage,
  stripTaskCreatedMetaKey,
  wrapFetchForTaskRouting,
  wrapTransportForTaskResults,
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
    requestWithSchema: async (req: Recorded) => {
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
    // The server's own `_meta` is preserved; nothing is synthesized (SEP-2663
    // has no `model-immediate-response` concept).
    expect(
      result._meta?.["io.modelcontextprotocol/model-immediate-response"]
    ).toBeUndefined();
  });

  it("ignores the smuggling key when the call did not allow a task result", async () => {
    const task = {
      resultType: "task",
      taskId: "spoofed",
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

    const result = (await manager.executeTool(serverId, "slow_tool", {})) as any;
    expect(result.taskId).toBeUndefined();
    expect(result.content).toEqual([]);
  });

  it("ignores the smuggling key on a non-extension wire", async () => {
    const task = {
      resultType: "task",
      taskId: "spoofed",
      status: "working",
      createdAt: "2025-11-25T00:00:00Z",
      lastUpdatedAt: "2025-11-25T00:00:00Z",
      ttlMs: null,
    };
    const { manager, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_CAPS as never,
      callToolResult: {
        content: [],
        _meta: { [TASK_CREATED_META_KEY]: task },
      },
    });

    const result = (await manager.executeTool(serverId, "slow_tool", {}, {
      allowTaskResult: true,
    } as never)) as any;
    expect(result.taskId).toBeUndefined();
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

  it("tasks/update sends bare inputResponses with the declaration", async () => {
    const { manager, calls, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      requestResult: {},
    });

    await manager.updateTask(serverId, "task-7", {
      k1: { action: "accept", content: { city: "Madrid" } },
    } as never);

    expect(calls[0].method).toBe("tasks/update");
    expect((calls[0].params as any).inputResponses.k1).toEqual({
      action: "accept",
      content: { city: "Madrid" },
    });
    expect(
      (calls[0].params as any)._meta[CLIENT_CAPABILITIES_META_KEY].extensions[
        EXT_ID
      ]
    ).toEqual({});
  });

  it("tasks/update accepts the spec's empty acknowledgement", async () => {
    // `UpdateTaskResult = Result`: no task state comes back, so validating the
    // ack as a task would reject every conforming server.
    const { manager, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: EXT_CAPS as never,
      requestResult: {},
    });

    await expect(
      manager.updateTask(serverId, "task-7", {
        k1: { action: "decline" },
      } as never)
    ).resolves.toEqual({});
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

/**
 * The status-discriminated union (`DetailedTask`, schema.ts:217-222 /
 * schema.json `anyOf` with per-variant `required`; tasks.md:330-336 states each
 * as a MUST).
 */
describe("DetailedTask status union", () => {
  const base = {
    taskId: "task-1",
    createdAt: "2026-07-27T00:00:00Z",
    lastUpdatedAt: "2026-07-27T00:01:00Z",
    ttlMs: null,
  };

  const inputRequest = {
    method: "elicitation/create",
    params: { message: "need input", requestedSchema: { type: "object" } },
  };

  it("accepts every variant with its required status payload", () => {
    expect(assertGetTaskExtResult({ ...base, status: "working" }).status).toBe(
      "working"
    );
    expect(
      assertGetTaskExtResult({ ...base, status: "cancelled" }).status
    ).toBe("cancelled");

    const inputRequired = assertGetTaskExtResult({
      ...base,
      status: "input_required",
      inputRequests: { k1: inputRequest },
    });
    expect(inputRequired.inputRequests?.k1).toEqual(inputRequest);

    const completed = assertGetTaskExtResult({
      ...base,
      status: "completed",
      result: { content: [{ type: "text", text: "done" }] },
    });
    expect(completed.result).toEqual({
      content: [{ type: "text", text: "done" }],
    });

    const failed = assertGetTaskExtResult({
      ...base,
      status: "failed",
      statusMessage: "rate limited",
      error: { code: -32603, message: "API rate limit exceeded" },
    });
    expect(failed.error).toEqual({
      code: -32603,
      message: "API rate limit exceeded",
    });
    // `statusMessage` is only a SHOULD on `failed` — it stays optional.
    expect(
      assertGetTaskExtResult({
        ...base,
        status: "failed",
        error: { code: -32603, message: "boom" },
      }).statusMessage
    ).toBeUndefined();
  });

  it("rejects a variant that is missing its required status payload", () => {
    expect(() =>
      assertGetTaskExtResult({ ...base, status: "completed" })
    ).toThrow(InvalidTaskExtPayloadError);
    expect(() => assertGetTaskExtResult({ ...base, status: "failed" })).toThrow(
      InvalidTaskExtPayloadError
    );
    expect(() =>
      assertGetTaskExtResult({ ...base, status: "input_required" })
    ).toThrow(InvalidTaskExtPayloadError);
  });

  it("rejects a base field that is missing entirely", () => {
    const { ttlMs: _ttlMs, ...noTtl } = base;
    expect(() =>
      assertGetTaskExtResult({ ...noTtl, status: "working" })
    ).toThrow(InvalidTaskExtPayloadError);
    const { createdAt: _createdAt, ...noCreatedAt } = base;
    expect(() =>
      assertGetTaskExtResult({ ...noCreatedAt, status: "working" })
    ).toThrow(InvalidTaskExtPayloadError);
  });

  it("accepts the response with AND without resultType:'complete'", () => {
    // tasks.md:338 says MUST, but `resultType` is absent from schema.json and
    // every DetailedTask variant is `additionalProperties: false` — schema and
    // prose conflict, so absence may not be rejected.
    const withDiscriminator = assertGetTaskExtResult({
      ...base,
      resultType: "complete",
      status: "working",
    });
    expect((withDiscriminator as any).resultType).toBe("complete");
    expect(
      (assertGetTaskExtResult({ ...base, status: "working" }) as any).resultType
    ).toBeUndefined();
  });

  it("rejects a resultType that is present but not 'complete'", () => {
    // Absence is tolerated, but a WRONG discriminator misleads and contradicts
    // the `GetTaskExtResult` type — including `"task"`, which is the creation
    // discriminator and never valid on a tasks/get.
    for (const resultType of ["banana", "task", "input_required", 7, null]) {
      expect(() =>
        assertGetTaskExtResult({ ...base, status: "working", resultType })
      ).toThrow(InvalidTaskExtPayloadError);
    }
    let captured: unknown;
    try {
      assertGetTaskExtResult({
        ...base,
        status: "working",
        resultType: "banana",
      });
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(InvalidTaskExtPayloadError);
    expect((captured as InvalidTaskExtPayloadError).method).toBe("tasks/get");
    expect((captured as InvalidTaskExtPayloadError).issues.join()).toContain(
      "resultType"
    );
  });

  it("keeps isError:true a COMPLETED task, never failed", () => {
    // tasks.md:837, :891-892 — only an underlying JSON-RPC error is `failed`.
    const task = assertGetTaskExtResult({
      ...base,
      status: "completed",
      result: {
        content: [{ type: "text", text: "Failed to process request" }],
        isError: true,
      },
    });
    expect(task.status).toBe("completed");
    expect((task.result as any).isError).toBe(true);
    expect(task.error).toBeUndefined();
  });

  it("accepts a non-integer, negative or shrinking ttlMs / pollIntervalMs", () => {
    // schema.json says plain `"number"`, and both MAY change over a task's
    // lifetime (tasks.md:304, :340) — a changed value is not an anomaly.
    const first = assertGetTaskExtResult({
      ...base,
      status: "working",
      ttlMs: 1500.5,
      pollIntervalMs: 250.25,
    });
    expect(first.ttlMs).toBe(1500.5);

    const shrunk = assertGetTaskExtResult({
      ...base,
      status: "working",
      ttlMs: -1,
      pollIntervalMs: 0,
    });
    expect(shrunk.ttlMs).toBe(-1);
    expect(shrunk.pollIntervalMs).toBe(0);
  });

  it("carries method + wire + a safe summary on an invalid payload", () => {
    try {
      assertGetTaskExtResult({ ...base, status: "completed" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidTaskExtPayloadError);
      const invalid = error as InvalidTaskExtPayloadError;
      expect(invalid.method).toBe("tasks/get");
      expect(invalid.wire).toBe("extension");
      expect(invalid.summary.length).toBeGreaterThan(0);
      expect(invalid.issues.length).toBeGreaterThan(0);
      // Not a wire error: an invalid payload must not be collapsed into
      // "this connection cannot do tasks".
      expect(invalid).not.toBeInstanceOf(MCPTasksWireError);
    }
  });
});

describe("inputRequests validation", () => {
  const base = {
    taskId: "task-1",
    status: "input_required",
    createdAt: "2026-07-27T00:00:00Z",
    lastUpdatedAt: "2026-07-27T00:00:00Z",
    ttlMs: null,
  };

  it("preserves an unrecognized method instead of failing the payload", () => {
    const task = assertGetTaskExtResult({
      ...base,
      inputRequests: {
        k1: { method: "roots/list" },
        k2: { method: "com.example/futureRequest", params: { x: 1 } },
      },
    });
    expect(Object.keys(task.inputRequests ?? {})).toEqual(["k1", "k2"]);
    expect(describeTaskExtInputRequests(task.inputRequests)).toEqual([
      { key: "k1", method: "roots/list", recognized: true },
      { key: "k2", method: "com.example/futureRequest", recognized: false },
    ]);
    expect(isRecognizedInputRequestMethod("sampling/createMessage")).toBe(true);
    expect(isRecognizedInputRequestMethod("elicitation/create")).toBe(true);
    expect(isRecognizedInputRequestMethod("nope")).toBe(false);
  });

  it("rejects an entry without a string method", () => {
    expect(() =>
      assertGetTaskExtResult({ ...base, inputRequests: { k1: { method: 7 } } })
    ).toThrow(InvalidTaskExtPayloadError);
    expect(() =>
      assertGetTaskExtResult({ ...base, inputRequests: { k1: "nope" } })
    ).toThrow(InvalidTaskExtPayloadError);
    expect(() =>
      assertGetTaskExtResult({ ...base, inputRequests: [] })
    ).toThrow(InvalidTaskExtPayloadError);
  });

  it("keeps hostile keys as data and never pollutes a prototype", () => {
    // JSON.parse (not an object literal) so `__proto__` arrives as a real own
    // property, exactly as it would off the wire.
    const payload = JSON.parse(
      `{"taskId":"task-1","status":"input_required","createdAt":"t","lastUpdatedAt":"t","ttlMs":null,
        "inputRequests":{
          "__proto__":{"method":"roots/list","polluted":true},
          "constructor":{"method":"roots/list"},
          "prototype":{"method":"roots/list"},
          "ok":{"method":"elicitation/create"}
        }}`
    );
    const task = assertGetTaskExtResult(payload);
    const requests = task.inputRequests as Record<string, unknown>;

    expect(Object.getPrototypeOf(requests)).toBeNull();
    expect(Object.keys(requests).sort()).toEqual([
      "__proto__",
      "constructor",
      "ok",
      "prototype",
    ]);
    expect(({} as any).polluted).toBeUndefined();
    expect((Object.prototype as any).polluted).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });
});

describe("server capability declaration", () => {
  const rows: Array<[string, unknown, boolean]> = [
    ["empty settings object", {}, true],
    ["non-empty settings object", { someSetting: 1 }, true],
    ["boolean true", true, false],
    ["string", "x", false],
    ["array", [], false],
    ["null", null, false],
    ["number", 1, false],
  ];

  for (const [label, value, expected] of rows) {
    it(`${label} → ${expected ? "declared" : "not declared"}`, () => {
      const caps = { tools: {}, extensions: { [EXT_ID]: value } } as never;
      expect(serverDeclaresTasksExtension(caps)).toBe(expected);
      expect(resolveTasksWire("2026-07-28", caps)).toBe(
        expected ? "extension" : "none"
      );
    });
  }

  it("an absent key is not a declaration", () => {
    expect(
      serverDeclaresTasksExtension({ tools: {}, extensions: {} } as never)
    ).toBe(false);
  });
});

describe("empty acknowledgements", () => {
  it("accepts an empty object and any object body", () => {
    expect(assertTaskExtAck({}, "tasks/update result")).toEqual({});
    expect(assertTaskExtAck({ _meta: { a: 1 } }, "tasks/update result")).toEqual(
      { _meta: { a: 1 } }
    );
  });

  it("accepts an ack carrying resultType:'complete' and rejects a wrong one", () => {
    // tasks.md:381 / :410 mandate the discriminator on the update/cancel acks
    // too; beta.4 strips it before the guard sees it, so absence is tolerated
    // and only a present-but-wrong value is a violation.
    expect(
      assertTaskExtAck({ resultType: "complete" }, "tasks/cancel result")
    ).toEqual({ resultType: "complete" });
    for (const resultType of ["banana", "task", "input_required"]) {
      expect(() =>
        assertTaskExtAck({ resultType }, "tasks/cancel result")
      ).toThrow(InvalidTaskExtPayloadError);
    }
  });

  it("rejects a non-object ack, including undefined", () => {
    // `undefined` is NOT a transport-flattened empty result: beta.4 rejects a
    // non-object result in `decodeResult` and only resolves what the caller's
    // `z.looseObject({})` accepted, so `undefined` means a malformed/missing
    // result and must not be laundered into a valid empty ack.
    for (const bad of [undefined, null, [], "ok", 1, true]) {
      expect(() => assertTaskExtAck(bad, "tasks/update result")).toThrow(
        InvalidTaskExtPayloadError
      );
    }
  });

  it("tasks/update and tasks/cancel reject a non-object server ack", async () => {
    for (const bad of [[], "ok", null]) {
      const { manager, serverId } = seedManager({
        protocolVersion: "2026-07-28",
        capabilities: EXT_CAPS as never,
        requestResult: bad,
      });
      await expect(
        manager.updateTask(serverId, "task-7", {} as never)
      ).rejects.toThrow(InvalidTaskExtPayloadError);
      await expect(manager.cancelTaskExt(serverId, "task-7")).rejects.toThrow(
        InvalidTaskExtPayloadError
      );
    }
  });
});

describe("wire guards raise a typed tasks-wire error", () => {
  // A bare TypeError would map to a 500, which hosted clients treat as
  // TRANSIENT and retry forever against a server that can never serve it.
  it("extension reads/writes on a non-extension wire", async () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_CAPS as never,
    });
    await expect(manager.getTaskExt(serverId, "t")).rejects.toBeInstanceOf(
      MCPTasksWireError
    );
    await expect(
      manager.updateTask(serverId, "t", {} as never)
    ).rejects.toBeInstanceOf(MCPTasksWireError);
    await expect(manager.cancelTaskExt(serverId, "t")).rejects.toBeInstanceOf(
      MCPTasksWireError
    );
  });

  it("declaring task eligibility with no tasks wire", async () => {
    const { manager, serverId } = seedManager({
      protocolVersion: "2026-07-28",
      capabilities: { tools: {} } as never,
    });
    await expect(
      manager.executeTool(serverId, "slow_tool", {}, {
        allowTaskResult: true,
      } as never)
    ).rejects.toBeInstanceOf(MCPTasksWireError);
  });
});

describe("transport seams", () => {
  it("adds Mcp-Name/Mcp-Method to tasks/* POSTs only", async () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = wrapFetchForTaskRouting(inner as never);

    await wrapped("https://x.test/mcp", {
      method: "POST",
      headers: { "mcp-protocol-version": "2026-07-28" },
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
      headers: {
        "mcp-name": "already",
        "mcp-protocol-version": "2026-07-28",
      },
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

  it("strips an inbound smuggling key so a server cannot forge a task", () => {
    const forged = {
      jsonrpc: "2.0",
      id: 5,
      result: {
        content: [],
        _meta: { [TASK_CREATED_META_KEY]: { taskId: "forged" }, keep: 1 },
      },
    } as never;
    const cleaned = stripTaskCreatedMetaKey(forged) as any;
    expect(cleaned.result._meta[TASK_CREATED_META_KEY]).toBeUndefined();
    expect(cleaned.result._meta.keep).toBe(1);
  });

  it("era-gates the routing headers to the extension era", () => {
    const inner = vi.fn(async () => new Response("{}"));
    const wrapped = wrapFetchForTaskRouting(inner as never);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tasks/get",
      params: { taskId: "task-7" },
    });

    wrapped("https://example.test/mcp" as never, {
      method: "POST",
      headers: { "mcp-protocol-version": "2025-11-25" },
      body,
    });
    expect(
      new Headers((inner.mock.calls[0] as any)[1].headers).get("mcp-name")
    ).toBeNull();

    wrapped("https://example.test/mcp" as never, {
      method: "POST",
      headers: { "mcp-protocol-version": "2026-07-28" },
      body,
    });
    expect(
      new Headers((inner.mock.calls[1] as any)[1].headers).get("mcp-name")
    ).toBe("task-7");
  });

  it("only rewrites task results once the extension era is negotiated", () => {
    const messages: any[] = [];
    const inner: any = { onmessage: undefined, send: async () => {}, close: async () => {} };
    const wrapped = wrapTransportForTaskResults(inner);
    wrapped.onmessage = (message) => messages.push(message);

    const taskResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { resultType: "task", taskId: "task-7", status: "working" },
    };

    // Pre-negotiation / legacy era: shown verbatim (a debugger must not hide a
    // nonconforming 2025-era server's bogus resultType).
    wrapped.setProtocolVersion?.("2025-11-25");
    inner.onmessage(taskResponse);
    expect(messages[0].result.resultType).toBe("task");

    wrapped.setProtocolVersion?.("2026-07-28");
    inner.onmessage(taskResponse);
    expect(messages[1].result.resultType).toBe("complete");
    expect(messages[1].result._meta[TASK_CREATED_META_KEY].taskId).toBe(
      "task-7"
    );
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

describe("task-declared subscriptions/listen (manager)", () => {
  /**
   * `seedManager`'s client has no `listen` and no upstream envelope member.
   * These helpers add the two facts the declared-listen path keys on.
   */
  function seedListenManager(options: {
    protocolVersion?: string;
    capabilities?: Record<string, unknown>;
    withListen?: boolean;
    withEnvelope?: boolean;
    declaredCapabilities?: Record<string, unknown>;
  }) {
    const seeded = seedManager({
      protocolVersion: options.protocolVersion ?? "2026-07-28",
      capabilities: options.capabilities ?? EXT_CAPS,
      declaredCapabilities: options.declaredCapabilities,
    });
    const client = (seeded.manager as any).liveClientStates.get(
      seeded.serverId
    ).client as Record<string, unknown>;

    const observedEnvelopes: Array<Record<string, unknown> | undefined> = [];
    const listenedFilters: Array<Record<string, unknown>> = [];
    const handle = {
      honoredFilter: { taskIds: ["t-1"] },
      close: vi.fn(async () => {}),
      closed: new Promise<never>(() => {}),
    };

    if (options.withEnvelope) {
      client._outboundMetaEnvelope = function (): Record<string, unknown> {
        return { existing: "envelope-key" };
      };
    }
    if (options.withListen) {
      client.listen = function (filter: Record<string, unknown>) {
        listenedFilters.push(filter);
        // Mirror upstream: the envelope is read SYNCHRONOUSLY while building
        // the request, which is the window the per-call shadow covers.
        const envelope = (
          this as { _outboundMetaEnvelope?: () => Record<string, unknown> }
        )._outboundMetaEnvelope?.();
        observedEnvelopes.push(envelope);
        return Promise.resolve(handle);
      };
    }
    return { ...seeded, observedEnvelopes, listenedFilters, handle };
  }

  it("refuses to send a task-filtered listen on a non-extension wire", async () => {
    const { manager, serverId } = seedListenManager({
      protocolVersion: "2025-11-25",
      capabilities: LEGACY_CAPS,
      withListen: true,
      withEnvelope: true,
    });
    await expect(
      manager.listenWithTasksDeclaration(serverId, { taskIds: ["t-1"] })
    ).rejects.toBeInstanceOf(MCPTasksWireError);
  });

  it("throws (never resolves undefined) when the connection cannot declare", async () => {
    // Port contract: availability is method PRESENCE on the port, so a
    // defined opener answering `undefined` would read as "opened nothing,
    // successfully" — it must throw instead.
    const { manager, serverId } = seedListenManager({ withListen: false });
    await expect(
      manager.listenWithTasksDeclaration(serverId, { taskIds: ["t-1"] })
    ).rejects.toThrow(/cannot open a task-declared/);
  });

  it("puts the tasks declaration on the listen envelope and hands back the handle", async () => {
    const { manager, serverId, observedEnvelopes, listenedFilters, handle } =
      seedListenManager({
        withListen: true,
        withEnvelope: true,
        declaredCapabilities: { roots: { listChanged: true } },
      });

    const opened = await manager.listenWithTasksDeclaration(serverId, {
      taskIds: ["t-1"],
    });

    expect(opened).toBe(handle);
    expect(listenedFilters).toEqual([{ taskIds: ["t-1"] }]);
    expect(observedEnvelopes).toHaveLength(1);
    const envelope = observedEnvelopes[0] as Record<string, any>;
    // Upstream's own envelope keys survive; only the capabilities key is
    // replaced, and it carries the extension MERGED into the declared caps.
    expect(envelope.existing).toBe("envelope-key");
    const declared = envelope[CLIENT_CAPABILITIES_META_KEY];
    expect(declared.extensions[EXT_ID]).toEqual({});
    expect(declared.roots).toEqual({ listChanged: true });
  });

  it("supportsTaskDeclaredListen requires the wire, the listen method and the seam", () => {
    const cases = [
      {
        name: "legacy wire",
        seed: seedListenManager({
          protocolVersion: "2025-11-25",
          capabilities: LEGACY_CAPS,
          withListen: true,
          withEnvelope: true,
        }),
        expected: false,
      },
      {
        name: "no listen method",
        seed: seedListenManager({ withListen: false, withEnvelope: true }),
        expected: false,
      },
      {
        name: "no envelope seam behind the client",
        seed: seedListenManager({ withListen: true, withEnvelope: false }),
        expected: false,
      },
      {
        name: "extension wire + listen + seam",
        seed: seedListenManager({ withListen: true, withEnvelope: true }),
        expected: true,
      },
    ];
    for (const { name, seed, expected } of cases) {
      expect(seed.manager.supportsTaskDeclaredListen(seed.serverId), name).toBe(
        expected
      );
    }
    // Unknown server: probe is false, never a throw.
    expect(cases[3].seed.manager.supportsTaskDeclaredListen("missing")).toBe(
      false
    );
  });
});
