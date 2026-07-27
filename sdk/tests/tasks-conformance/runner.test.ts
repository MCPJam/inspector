import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  MCPTasksConformanceTest,
  MCP_TASKS_CHECK_IDS,
  findDeclarationViolations,
  pickProbeTool,
  validateCreateTaskShape,
  validateTaskTtlShape,
} from "../../src/tasks-conformance/index.js";
import * as operations from "../../src/operations.js";

const EXT_ID = "io.modelcontextprotocol/tasks";
const CAPS_META_KEY = "io.modelcontextprotocol/clientCapabilities";

function extensionDeclaration() {
  return { [CAPS_META_KEY]: { extensions: { [EXT_ID]: {} } } };
}

/**
 * Runs the conformance test against a fake connection by standing in for
 * `withEphemeralClient`, which is where the runner gets its manager.
 */
function runAgainst(
  manager: Record<string, unknown>,
  options: {
    config?: Record<string, unknown>;
    sentMessages?: unknown[];
  } = {}
) {
  vi.spyOn(operations, "withEphemeralClient").mockImplementation((async (
    _config: unknown,
    fn: unknown,
    opts: unknown
  ) => {
    const { rpcLogger } = (opts ?? {}) as { rpcLogger?: (e: unknown) => void };
    for (const message of options.sentMessages ?? []) {
      rpcLogger?.({ direction: "send", message, serverId: "srv" });
    }
    return (fn as (m: unknown, id: string) => Promise<unknown>)(manager, "srv");
  }) as never);

  return new MCPTasksConformanceTest({
    url: "https://example.test/mcp",
    ...(options.config ?? {}),
  } as never).run();
}

function statusMap(
  result: Awaited<ReturnType<MCPTasksConformanceTest["run"]>>
) {
  return Object.fromEntries(result.checks.map((c) => [c.id, c.status]));
}

function extensionManager(overrides: Record<string, unknown> = {}) {
  const task = {
    taskId: "task-1",
    status: "completed",
    createdAt: "2026-07-27T00:00:00Z",
    lastUpdatedAt: "2026-07-27T00:00:01Z",
    ttlMs: 60_000,
    pollIntervalMs: 1,
    result: { content: [{ type: "text", text: "done" }] },
  };

  return {
    getTasksSupport: () => ({
      wire: "extension",
      toolCalls: true,
      list: false,
      cancel: true,
      update: true,
      inlineResult: true,
    }),
    getNegotiatedProtocolVersion: () => "2026-07-28",
    getServerCapabilities: () => ({ tools: {}, extensions: { [EXT_ID]: {} } }),
    listTools: async () => ({ tools: [{ name: "long_job", inputSchema: {} }] }),
    // A conformant server only creates a task when the call declared
    // eligibility; an undeclared call is answered normally.
    executeTool: async (
      _serverId: string,
      _toolName: string,
      _args: unknown,
      options?: { allowTaskResult?: boolean }
    ) =>
      options?.allowTaskResult
        ? { resultType: "task", taskId: "task-1" }
        : { resultType: "complete", content: [{ type: "text", text: "sync" }] },
    // The Mcp-Name check reads the headers the transport actually sent, so the
    // fake performs the routed HTTP round trip its real counterpart would.
    getTaskExt: async (_serverId: string, taskId: string) => {
      await fetch("https://example.test/mcp", {
        method: "POST",
        headers: { "mcp-name": taskId, "mcp-method": "tasks/get" },
        body: "{}",
      });
      return task;
    },
    getClient: () => ({
      request: async () => {
        throw Object.assign(new Error("missing capability"), {
          code: -32003,
        });
      },
    }),
    ...overrides,
  } as Record<string, unknown>;
}

// The Mcp-Name check instruments `globalThis.fetch`; no test talks to a real
// network, so the fake transport's round trip resolves locally.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("declaration hygiene", () => {
  it("flags params.task outside the legacy wire", () => {
    const sent = [
      { method: "tools/call", params: { name: "t", task: { ttl: 1000 } } },
    ];
    expect(findDeclarationViolations("legacy", sent)).toEqual([]);
    expect(findDeclarationViolations("extension", sent)).toHaveLength(1);
    expect(findDeclarationViolations("none", sent)[0]).toContain("params.task");
  });

  it("flags the extension declaration outside the extension wire", () => {
    const sent = [
      {
        method: "tasks/get",
        params: { taskId: "t", _meta: extensionDeclaration() },
      },
    ];
    expect(findDeclarationViolations("extension", sent)).toEqual([]);
    expect(findDeclarationViolations("legacy", sent)[0]).toContain(EXT_ID);
    expect(findDeclarationViolations("none", sent)).toHaveLength(1);
  });

  it("ignores unrelated _meta keys", () => {
    const sent = [
      {
        method: "tools/call",
        params: { name: "t", _meta: { "io.modelcontextprotocol/other": {} } },
      },
    ];
    expect(findDeclarationViolations("none", sent)).toEqual([]);
  });
});

describe("shape validators", () => {
  it("requires a flat CreateTaskResult; extra fields warn instead of failing", () => {
    expect(
      validateCreateTaskShape({ resultType: "task", taskId: "t" })
    ).toEqual({ violations: [], warnings: [] });
    expect(
      validateCreateTaskShape({ resultType: "complete", taskId: "t" })
        .violations[0]
    ).toContain("resultType");
    expect(
      validateCreateTaskShape({ resultType: "task" }).violations[0]
    ).toContain("taskId");
    // A redundant nested `task` object is an extra field the spec does not
    // forbid: an otherwise-valid flat result passes with a warning.
    const nested = validateCreateTaskShape({
      resultType: "task",
      taskId: "t",
      task: { taskId: "t" },
    });
    expect(nested.violations).toEqual([]);
    expect(nested.warnings[0]).toContain("nested");
  });

  it("enforces era-native ttl fields; the other era's field warns", () => {
    expect(validateTaskTtlShape("extension", { ttlMs: null })).toEqual({
      violations: [],
      warnings: [],
    });
    // `ttl` beside a missing/invalid `ttlMs`: one violation (ttlMs shape) and
    // one warning (extra legacy field) — presence alone must not fail.
    const mixed = validateTaskTtlShape("extension", { ttl: 5 });
    expect(mixed.violations).toHaveLength(1);
    expect(mixed.warnings).toHaveLength(1);
    const extraOnValid = validateTaskTtlShape("extension", {
      ttlMs: null,
      ttl: 5,
    });
    expect(extraOnValid.violations).toEqual([]);
    expect(extraOnValid.warnings[0]).toContain("ttl");
    expect(validateTaskTtlShape("legacy", { ttl: 5 })).toEqual({
      violations: [],
      warnings: [],
    });
    expect(validateTaskTtlShape("legacy", { ttlMs: 5 }).warnings[0]).toContain(
      "ttlMs"
    );
  });
});

describe("pickProbeTool", () => {
  const tools = [
    { name: "plain", inputSchema: {} },
    {
      name: "optional_task",
      inputSchema: {},
      execution: { taskSupport: "optional" },
    },
    {
      name: "required_task",
      inputSchema: {},
      execution: { taskSupport: "required" },
    },
  ] as never[];

  it("prefers required over optional, and honors an explicit name", () => {
    expect(pickProbeTool(tools)?.name).toBe("required_task");
    expect(pickProbeTool(tools, "plain")?.name).toBe("plain");
    expect(pickProbeTool([tools[0]])).toBeUndefined();
  });
});

describe("MCPTasksConformanceTest", () => {
  it("passes the extension wire suite end to end", async () => {
    const result = await runAgainst(extensionManager(), {
      config: { toolName: "long_job", pollTimeoutMs: 1000 },
      sentMessages: [
        {
          method: "tools/call",
          params: { name: "long_job", _meta: extensionDeclaration() },
        },
        {
          method: "tasks/get",
          params: { taskId: "task-1", _meta: extensionDeclaration() },
        },
      ],
    });

    expect(result.checks).toHaveLength(MCP_TASKS_CHECK_IDS.length);
    expect(statusMap(result)).toEqual({
      "tasks-wire-resolvable": "passed",
      "tasks-declaration-hygiene": "passed",
      "tasks-result-type-discipline": "passed",
      "tasks-undeclared-capability-rejected": "passed",
      "tasks-ttl-shape": "passed",
      "tasks-inline-result": "passed",
      "tasks-mcp-name-routing": "passed",
    });
    expect(result.passed).toBe(true);
    expect(result.discovery).toMatchObject({
      wire: "extension",
      protocolVersion: "2026-07-28",
      createdTaskId: "task-1",
    });
  });

  it("fails when a completed extension task omits its inline result", async () => {
    const manager = extensionManager({
      getTaskExt: async () => ({
        taskId: "task-1",
        status: "completed",
        ttlMs: null,
        pollIntervalMs: 1,
      }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    expect(result.passed).toBe(false);
    expect(statusMap(result)["tasks-inline-result"]).toBe("failed");
    expect(
      result.checks.find((c) => c.id === "tasks-inline-result")?.error?.message
    ).toContain("INLINE");
  });

  it("passes WITH a warning when tasks/get without the declaration is answered", async () => {
    // Answering a bare tasks/get is conformant: -32003 is mandated only when
    // the server cannot avoid returning CreateTaskResult to an undeclared
    // client — never for a bare read. Lenient handling surfaces as a warning.
    const manager = extensionManager({
      getClient: () => ({ request: async () => ({ taskId: "task-1" }) }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "passed"
    );
    const check = result.checks.find(
      (c) => c.id === "tasks-undeclared-capability-rejected"
    );
    expect(check?.warnings?.[0]).toContain("allowed");
  });

  it("fails when an undeclared tools/call is turned into a task", async () => {
    // The mandated case: a server must not create a task for a client that
    // never declared the capability.
    const manager = extensionManager({
      executeTool: async () => ({ resultType: "task", taskId: "task-1" }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "failed"
    );
  });

  it("flags a server advertising the extension on 2025-11-25 without failing", async () => {
    const manager = extensionManager({
      getNegotiatedProtocolVersion: () => "2025-11-25",
      getServerCapabilities: () => ({
        tools: {},
        tasks: { requests: { tools: { call: true } } },
        extensions: { [EXT_ID]: {} },
      }),
      getTasksSupport: () => ({
        wire: "legacy",
        toolCalls: true,
        list: false,
        cancel: true,
        update: false,
        inlineResult: false,
      }),
      executeTool: async () => ({
        task: { taskId: "task-1", status: "working", ttl: 60_000 },
      }),
      getTask: async () => ({
        taskId: "task-1",
        status: "completed",
        ttl: 60_000,
      }),
      getTaskResult: async () => ({ content: [] }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    const wireCheck = result.checks.find(
      (c) => c.id === "tasks-wire-resolvable"
    );
    expect(wireCheck?.status).toBe("passed");
    expect(wireCheck?.warnings?.[0]).toContain("treated as absent");
    expect(statusMap(result)["tasks-inline-result"]).toBe("passed");
    // Extension-only checks do not apply to the legacy wire.
    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "skipped"
    );
    expect(statusMap(result)["tasks-mcp-name-routing"]).toBe("skipped");
  });

  it("skips the task checks when the connection has no tasks wire", async () => {
    const manager = extensionManager({
      getNegotiatedProtocolVersion: () => "2025-06-18",
      getServerCapabilities: () => ({ tools: {} }),
      getTasksSupport: () => ({
        wire: "none",
        toolCalls: false,
        list: false,
        cancel: false,
        update: false,
        inlineResult: false,
      }),
      executeTool: async () => {
        throw new Error("must not call a tool on the none wire");
      },
    });

    const result = await runAgainst(manager);

    expect(result.passed).toBe(true);
    expect(statusMap(result)["tasks-result-type-discipline"]).toBe("skipped");
    expect(statusMap(result)["tasks-ttl-shape"]).toBe("skipped");
  });

  it("reports a connection failure as a failed run", async () => {
    vi.spyOn(operations, "withEphemeralClient").mockRejectedValue(
      new Error("connect refused") as never
    );

    const result = await new MCPTasksConformanceTest({
      url: "https://example.test/mcp",
    } as never).run();

    expect(result.passed).toBe(false);
    expect(result.checks[0].error?.message).toContain("connect refused");
  });
});
