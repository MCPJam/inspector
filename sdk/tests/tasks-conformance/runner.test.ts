import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  MCPTasksConformanceTest,
  MCP_TASKS_CHECK_IDS,
  decideOutcome,
  findDeclarationViolations,
  findRawTaskStates,
  sentRequestIds,
  validateCompletionAck,
  pickProbeTool,
  resolveProbeTool,
  validateCreateTaskShape,
  validateTaskTtlShape,
  validateTaskStatusPayload,
} from "../../src/tasks-conformance/index.js";
import type { MCPTasksCheckResult } from "../../src/tasks-conformance/index.js";
import * as operations from "../../src/operations.js";

const EXT_ID = "io.modelcontextprotocol/tasks";
const CAPS_META_KEY = "io.modelcontextprotocol/clientCapabilities";

function extensionDeclaration() {
  return { [CAPS_META_KEY]: { extensions: { [EXT_ID]: {} } } };
}

/**
 * The live `rpcLogger` of the run in progress. The runner reads the outbound
 * rpc log to tell "the server never answered" apart from "the request never
 * left the process", so a fake seam that wants to model the FORMER has to
 * announce its send the way a real transport would.
 */
let activeRpcLogger: ((event: unknown) => void) | undefined;

/** Announce an outbound request on the run's rpc log, as a transport would. */
function logSend(method: string) {
  activeRpcLogger?.({
    direction: "send",
    message: { method, params: {} },
    serverId: "srv",
  });
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
    activeRpcLogger = rpcLogger;
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
      // A conformant server knows exactly the ids it issued and answers -32602
      // for anything else (tasks.md:795, a MUST for `tasks/get`).
      if (taskId !== "task-1") throw rpcErrorValue(-32602, "unknown task");
      return task;
    },
    // Both mutating methods: an empty ack for the real task, -32602 for an id
    // the server never issued (a SHOULD there, but the conformant answer).
    updateTask: async (_serverId: string, taskId: string) => {
      if (taskId !== "task-1") throw rpcErrorValue(-32602, "unknown task");
      return { resultType: "complete" };
    },
    cancelTaskExt: async (_serverId: string, taskId: string) => {
      if (taskId !== "task-1") throw rpcErrorValue(-32602, "unknown task");
      return { resultType: "complete" };
    },
    // A conformant server refuses EVERY undeclared task request with -32021
    // (ext-tasks tasks.md:797-799), including a task-filtered
    // subscriptions/listen.
    //
    // The seam is `getManagedClient().requestWithSchema`, not
    // `getClient().request`: the schema-less overload cannot carry a `tasks/*`
    // method on the 2026 wire (it has no era-registry result entry and throws
    // locally), so the probes ride the explicit-schema seam — the same one
    // `tasks-ext.ts` uses for the DECLARING calls, minus the declaration.
    getManagedClient: () => ({
      requestWithSchema: async () => {
        throw missingCapabilityError();
      },
    }),
    ...overrides,
  } as Record<string, unknown>;
}

/**
 * A raw request seam whose behavior is set per JSON-RPC method. Anything not
 * listed gets the conformant answer: rejected with -32021.
 */
function undeclaredSeam(perMethod: Record<string, () => unknown>) {
  return () => ({
    requestWithSchema: async (payload: { method: string }) => {
      const behavior = perMethod[payload.method];
      if (behavior) return behavior();
      throw missingCapabilityError();
    },
  });
}

function rpcErrorValue(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

/**
 * The conformant -32021. It carries `error.data.requiredCapabilities` because
 * the core schema REQUIRES that member — a rejection that names nothing tells a
 * client it is missing something without saying what.
 *
 * The value is a `ClientCapabilities` OBJECT, not a list of capability names:
 * `MissingRequiredClientCapabilityError.error.data.requiredCapabilities` is
 * `$ref: "#/$defs/ClientCapabilities"` in 2026-07-28. This fixture carried the
 * array form — a pre-final draft shape — until the check that reads it started
 * grading the schema's shape rather than accepting whatever was there.
 */
const REQUIRED_CAPABILITIES = { extensions: { [EXT_ID]: {} } };

function missingCapabilityError() {
  return Object.assign(new Error("missing capability"), {
    code: -32021,
    data: { requiredCapabilities: REQUIRED_CAPABILITIES },
  });
}

function rpcError(code: number, message = "nope") {
  return () => {
    throw Object.assign(new Error(message), { code });
  };
}

function undeclaredCheck(
  result: Awaited<ReturnType<MCPTasksConformanceTest["run"]>>
) {
  return result.checks.find(
    (c) => c.id === "tasks-undeclared-capability-rejected"
  );
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

describe("findRawTaskStates", () => {
  const frame = (id: number, taskId: string, status: string, extra = {}) => ({
    jsonrpc: "2.0",
    id,
    result: { taskId, status, ...extra },
  });
  /** Every id the cases below use for a `tasks/get`. */
  const GETS = new Set(["1", "2", "3", "4"]);

  it("returns EVERY frame for the task, in wire order", () => {
    // Not just the last: a run that drives past an `input_required` gate
    // observes several statuses, and grading only the final one would let a
    // malformed mid-flight frame pass behind a well-formed terminal one.
    const states = findRawTaskStates(
      [
        frame(1, "t1", "working"),
        frame(2, "t2", "working"),
        frame(3, "t1", "input_required"),
        frame(4, "t1", "completed", { result: {} }),
      ],
      "t1",
      GETS,
    );
    expect(states.map((state) => state.status)).toEqual([
      "working",
      "input_required",
      "completed",
    ]);
  });

  it("ignores frames for another task and non-task results", () => {
    expect(findRawTaskStates([frame(1, "t2", "working")], "t1", GETS)).toEqual(
      [],
    );
    expect(
      findRawTaskStates(
        [{ jsonrpc: "2.0", id: 1, result: { tools: [] } }],
        "t1",
        GETS,
      ),
    ).toEqual([]);
  });

  it("KEEPS a payload whose status is missing or not a string", () => {
    // Dropping these turned a violation into a non-observation: the check then
    // reported `could-not-run` ("we never saw a task state") about a server
    // that answered `tasks/get` with a malformed Task. A `tasks/get` response
    // IS a Task, and request-id membership already identifies it as one, so
    // the status no longer has to be well formed for the frame to be graded.
    expect(
      findRawTaskStates(
        [{ jsonrpc: "2.0", id: 1, result: { taskId: "t1" } }],
        "t1",
        GETS,
      ),
    ).toHaveLength(1);
    expect(
      findRawTaskStates(
        [{ jsonrpc: "2.0", id: 1, result: { taskId: "t1", status: 42 } }],
        "t1",
        GETS,
      ),
    ).toHaveLength(1);
  });

  it("excludes the tools/call creation frame, which is a bare Task", () => {
    // A `CreateTaskResult` carries `taskId` and `status` and — correctly — no
    // `result`/`error`/`inputRequests`. Matching on shape alone swept it in, so
    // a server that created an already-`completed` task failed the status
    // payload check even though every `tasks/get` it answered was well formed.
    const states = findRawTaskStates(
      [
        // id 9 is the `tools/call`, not a `tasks/get`.
        { jsonrpc: "2.0", id: 9, result: { resultType: "task", taskId: "t1", status: "completed" } },
        frame(1, "t1", "completed", { result: { content: [] } }),
      ],
      "t1",
      GETS,
    );
    expect(states).toHaveLength(1);
    expect(states[0].result).toBeDefined();
  });

  it("sentRequestIds collects only the ids of the named method", () => {
    const ids = sentRequestIds(
      [
        { jsonrpc: "2.0", id: 9, method: "tools/call" },
        { jsonrpc: "2.0", id: 1, method: "tasks/get" },
        { jsonrpc: "2.0", id: "2", method: "tasks/get" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ],
      "tasks/get",
    );
    // Ids compare as strings: JSON-RPC permits either type, and a run that
    // numbered its requests must not miss a server echoing them as strings.
    expect([...ids].sort()).toEqual(["1", "2"]);
  });
});

describe("task status is judged, not coerced", () => {
  // `Task.status` is REQUIRED and a closed enum of five values. Reading it
  // through `String(...)` accepted anything and fell through to a silent pass:
  // `undefined` became "undefined", `42` became "42", and a plausible typo like
  // "complete" or "in_progress" sailed past the switch's `default`.
  it("rejects a missing status", () => {
    const verdict = validateTaskStatusPayload({ taskId: "t1" });
    expect(verdict.violations[0]).toContain("required `status`");
  });

  it("rejects a non-string status, naming the type", () => {
    expect(validateTaskStatusPayload({ taskId: "t1", status: 42 }).violations[0])
      .toContain("must be a string");
  });

  it("rejects an unrecognised status, including near-miss typos", () => {
    for (const status of ["complete", "in_progress", "done", ""]) {
      const verdict = validateTaskStatusPayload({ taskId: "t1", status });
      expect(verdict.violations.join(" ")).toContain("must be one of");
    }
  });

  it("accepts every member of the enum", () => {
    for (const status of ["working", "cancelled"]) {
      expect(
        validateTaskStatusPayload({ taskId: "t1", status }).violations,
      ).toEqual([]);
    }
    // The three with payload obligations still get them enforced.
    expect(
      validateTaskStatusPayload({ taskId: "t1", status: "completed" })
        .violations[0],
    ).toContain("`result`");
  });
});

describe("completion acknowledgements", () => {
  it("rejects a non-object ack, which once read as an empty one", () => {
    // `isRecord(ack) ? keys : []` made `"ok"` produce an empty extras list —
    // a PASS from the check whose whole job is to confirm the acknowledgement.
    for (const ack of ["ok", 42, null, true]) {
      expect(
        validateCompletionAck(ack, "tasks/update").violations[0],
      ).toContain("did not return a result object");
    }
  });

  it("rejects task state smuggled into the ack", () => {
    expect(
      validateCompletionAck(
        { resultType: "complete", status: "completed" },
        "tasks/cancel",
      ).violations[0],
    ).toContain("status");
  });

  it("rejects a present-but-wrong resultType, which misdirects the client", () => {
    expect(
      validateCompletionAck({ resultType: "task" }, "tasks/update")
        .violations[0],
    ).toContain('rather than "complete"');
  });

  it("FAILS an absent resultType when the raw frame proves it was absent", () => {
    // `UpdateTaskResult` marks the member required. Nothing else grades it:
    // the Tasks suite runs its own runner, which installs no wire recorder, so
    // `wire-schema-valid` never sees this frame. Deferring to it left the
    // requirement with no verdict anywhere.
    const verdict = validateCompletionAck({}, "tasks/update", {});
    expect(verdict.violations[0]).toContain("UpdateTaskResult");
    expect(verdict.warnings).toEqual([]);
  });

  it("only advises when there is no raw frame to judge", () => {
    // The decoded ack cannot answer the question: the v2 client consumes
    // `resultType` on the way through, so its absence here is evidence about
    // our client, not about the server.
    const verdict = validateCompletionAck({}, "tasks/update");
    expect(verdict.violations).toEqual([]);
    expect(verdict.warnings[0]).toContain("cannot prove what was on the wire");
  });

  it("passes when the raw frame carries the required resultType", () => {
    expect(
      validateCompletionAck({}, "tasks/cancel", { resultType: "complete" }),
    ).toEqual({ violations: [], warnings: [] });
  });

  it("accepts the conformant ack, envelope members and all", () => {
    expect(
      validateCompletionAck(
        { resultType: "complete", _meta: { trace: "x" } },
        "tasks/cancel",
      ),
    ).toEqual({ violations: [], warnings: [] });
  });
});

describe("shape validators", () => {
  it("requires a flat CreateTaskResult; extra fields warn instead of failing", () => {
    expect(
      validateCreateTaskShape({ resultType: "task", taskId: "t" })
    ).toEqual({ violations: [], warnings: [] });
    // Present-but-wrong discriminator misleads the client: a violation.
    expect(
      validateCreateTaskShape({ resultType: "complete", taskId: "t" })
        .violations[0]
    ).toContain("resultType");
    // ABSENT discriminator is equally a violation (tasks.md:102). It is the
    // ONLY signal separating a CreateTaskResult from a standard result, and
    // this SDK discriminates on it, so omitting it makes the task invisible.
    const noDiscriminator = validateCreateTaskShape({ taskId: "t" });
    expect(noDiscriminator.warnings).toEqual([]);
    expect(noDiscriminator.violations[0]).toContain("resultType");
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

  describe("resolveProbeTool", () => {
    it("auto-selects on the legacy wire, where taskSupport still exists", () => {
      const resolved = resolveProbeTool("legacy", tools);
      expect(resolved.tool?.name).toBe("required_task");
      expect(resolved.reason).toBeUndefined();
    });

    it("blocks on the extension wire, naming the flag and why auto-selection cannot work", () => {
      const resolved = resolveProbeTool("extension", [tools[0]]);
      expect(resolved.tool).toBeUndefined();
      expect(resolved.blocking).toBe(true);
      expect(resolved.reason).toContain("--tool-name");
      expect(resolved.reason).toContain("execution.taskSupport");
      expect(resolved.reason).toContain("2026-07-28");
      // It points at what the server does list.
      expect(resolved.reason).toContain("plain");
    });

    it("blocks on a legacy server with no task-capable tool", () => {
      const resolved = resolveProbeTool("legacy", [tools[0]]);
      expect(resolved.blocking).toBe(true);
      expect(resolved.reason).toContain("execution.taskSupport");
    });

    it("blocks — naming the tool — when the requested name is not listed", () => {
      const resolved = resolveProbeTool("extension", tools, "typo_task");
      expect(resolved.tool).toBeUndefined();
      expect(resolved.blocking).toBe(true);
      expect(resolved.reason).toContain('"typo_task"');
      expect(resolved.reason).toContain("is not listed by this server");
      expect(resolved.reason).toContain("required_task");
    });

    it("is NOT blocking when there is no tasks wire at all", () => {
      const resolved = resolveProbeTool("none", tools);
      expect(resolved.tool).toBeUndefined();
      expect(resolved.blocking).toBe(false);
      expect(resolved.reason).toContain("no tasks wire");
    });
  });
});

describe("decideOutcome", () => {
  const check = (
    status: MCPTasksCheckResult["status"],
    skipReason?: MCPTasksCheckResult["skipReason"]
  ) =>
    ({
      id: "tasks-ttl-shape",
      category: "lifecycle",
      title: "t",
      description: "d",
      status,
      durationMs: 0,
      ...(skipReason ? { skipReason } : {}),
      ...(status === "skipped" ? { error: { message: "why" } } : {}),
    }) as MCPTasksCheckResult;

  it("passes only when every selected check produced a verdict", () => {
    expect(decideOutcome([check("passed")]).outcome).toBe("passed");
    // An inapplicable check establishes nothing but leaves nothing untested.
    expect(
      decideOutcome([check("passed"), check("skipped", "not-applicable")])
        .outcome
    ).toBe("passed");
  });

  it("never lets a check that could not run add up to a pass", () => {
    const verdict = decideOutcome([
      check("passed"),
      check("skipped", "could-not-run"),
    ]);
    expect(verdict.outcome).toBe("incomplete");
    expect(verdict.incompleteReason).toContain("1 of 2");
    expect(verdict.incompleteReason).toContain("why");
  });

  it("reports a violation as failed even when other checks did not run", () => {
    expect(
      decideOutcome([check("failed"), check("skipped", "could-not-run")])
        .outcome
    ).toBe("failed");
  });

  it("treats an empty selection as incomplete rather than vacuously green", () => {
    expect(decideOutcome([]).outcome).toBe("incomplete");
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
      "tasks-undeclared-creation-refused": "passed",
      "tasks-undeclared-capability-rejected": "passed",
      "tasks-ttl-shape": "passed",
      "tasks-inline-result": "passed",
      "tasks-mcp-name-routing": "passed",
      // The scenario depth added by the conformance-gap program, all outside
      // the `mcp-tasks` profile's scored set. The one skip is correct: this
      // task completes without ever asking for input, so there is no
      // `input_required` round trip to grade.
      "tasks-invalid-task-id-rejected": "passed",
      // Skipped against the FAKE manager by design: it reads raw inbound
      // frames (the only place a malformed status payload survives the SDK's
      // own validation), and a fake manager produces none. The fixture-backed
      // `scenarios.integration.test.ts` is where it is exercised.
      "tasks-status-payload-shape": "skipped",
      "tasks-cancel-ack-shape": "passed",
      "tasks-ttl-integer-shape": "passed",
      "tasks-undeclared-capability-names-requirements": "passed",
      "tasks-input-required-update-completes": "skipped",
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

  it("fails when an undeclared tools/call is turned into a task", async () => {
    // tasks.md:61 — a server must not return CreateTaskResult to a client
    // that did not declare the capability ON THAT REQUEST.
    const manager = extensionManager({
      executeTool: async () => ({ resultType: "task", taskId: "task-1" }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    expect(statusMap(result)["tasks-undeclared-creation-refused"]).toBe(
      "failed"
    );
    expect(result.passed).toBe(false);
  });

  it("fails when an undeclared tools/call smuggles a task through the manager's _meta stash", async () => {
    // Without `allowTaskResult` the manager never returns a `CreateTaskResult`
    // at the top level: the transport wrapper rewrites it into a plain
    // `CallToolResult` and parks the payload under
    // `_meta["io.mcpjam/tasks/create-task-result"]`. A detector reading only
    // `result.taskId` sees an ordinary result from EVERY server and passes
    // against the exact violation it exists to catch.
    const manager = extensionManager({
      executeTool: async (
        _serverId: string,
        _toolName: string,
        _args: unknown,
        options?: { allowTaskResult?: boolean }
      ) =>
        options?.allowTaskResult
          ? { resultType: "task", taskId: "task-1" }
          : {
              content: [],
              _meta: {
                "io.mcpjam/tasks/create-task-result": {
                  resultType: "task",
                  taskId: "smuggled-1",
                  status: "working",
                },
              },
            },
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    const check = result.checks.find(
      (c) => c.id === "tasks-undeclared-creation-refused"
    );
    expect(check?.status).toBe("failed");
    expect(check?.details).toMatchObject({ taskId: "smuggled-1" });
    expect(result.passed).toBe(false);
  });

  it("fails, rather than passing, when the undeclared creation probe cannot execute", async () => {
    // Any exception used to become `taskCreated: false`, which the check
    // counted as a PASS — so a timeout or a dead connection scored as
    // conformance. A thrown error with NO numeric code means no JSON-RPC
    // response exists, so nothing about the server was observed.
    const manager = extensionManager({
      executeTool: async (
        _serverId: string,
        _toolName: string,
        _args: unknown,
        options?: { allowTaskResult?: boolean }
      ) => {
        if (options?.allowTaskResult)
          return { resultType: "task", taskId: "task-1" };
        throw new Error("Connection closed");
      },
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    const check = result.checks.find(
      (c) => c.id === "tasks-undeclared-creation-refused"
    );
    expect(check?.status).toBe("failed");
    expect(check?.error?.message).toContain("no JSON-RPC response");
    expect(check?.error?.message).toContain("Connection closed");
    expect(result.passed).toBe(false);
  });

  it("passes an undeclared creation the server refused, warning when the code is not -32021", async () => {
    const manager = extensionManager({
      executeTool: async (
        _serverId: string,
        _toolName: string,
        _args: unknown,
        options?: { allowTaskResult?: boolean }
      ) => {
        if (options?.allowTaskResult)
          return { resultType: "task", taskId: "task-1" };
        throw Object.assign(new Error("nope"), { code: -32602 });
      },
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    const check = result.checks.find(
      (c) => c.id === "tasks-undeclared-creation-refused"
    );
    // No task was handed to a non-declaring client, which is what tasks.md:61
    // requires — but the refusal is not the one the extension names.
    expect(check?.status).toBe("passed");
    expect(check?.warnings?.[0]).toContain("-32602");
    expect(check?.details).toMatchObject({ undeclaredCreationCode: -32602 });
  });

  it("warns that a -32003 refusal is the pre-final draft code", async () => {
    const manager = extensionManager({
      executeTool: async (
        _serverId: string,
        _toolName: string,
        _args: unknown,
        options?: { allowTaskResult?: boolean }
      ) => {
        if (options?.allowTaskResult)
          return { resultType: "task", taskId: "task-1" };
        throw Object.assign(new Error("nope"), { code: -32003 });
      },
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    const check = result.checks.find(
      (c) => c.id === "tasks-undeclared-creation-refused"
    );
    // Still a pass — no task reached a non-declaring client — but the warning
    // has to say the code is stale rather than merely unexpected.
    expect(check?.status).toBe("passed");
    expect(check?.warnings?.[0]).toContain("corrected to -32021");
    expect(check?.warnings?.[0]).toContain("pre-final draft");
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
    expect(statusMap(result)["tasks-undeclared-creation-refused"]).toBe(
      "skipped"
    );
    expect(statusMap(result)["tasks-mcp-name-routing"]).toBe("skipped");
  });

  it("auto-selects the probe tool on the legacy wire, where taskSupport survives", async () => {
    // The legacy wire is the one era where `execution.taskSupport` reaches the
    // client, so a run with NO toolName must still exercise the task checks.
    const manager = extensionManager({
      getNegotiatedProtocolVersion: () => "2025-11-25",
      getServerCapabilities: () => ({
        tools: {},
        tasks: { requests: { tools: { call: true } } },
      }),
      getTasksSupport: () => ({
        wire: "legacy",
        toolCalls: true,
        list: false,
        cancel: true,
        update: false,
        inlineResult: false,
      }),
      listTools: async () => ({
        tools: [
          { name: "plain", inputSchema: {} },
          {
            name: "long_job",
            inputSchema: {},
            execution: { taskSupport: "required" },
          },
        ],
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
      config: { pollTimeoutMs: 500 },
    });

    expect(result.discovery.probedTool).toBe("long_job");
    expect(result.outcome).toBe("passed");
    expect(result.passed).toBe(true);
    expect(statusMap(result)["tasks-result-type-discipline"]).toBe("passed");
    expect(statusMap(result)["tasks-ttl-shape"]).toBe("passed");
    expect(statusMap(result)["tasks-inline-result"]).toBe("passed");
  });

  it("reports INCOMPLETE when the extension wire has no probe tool to select", async () => {
    // No toolName, and the 2026 ToolSchema strips `execution.taskSupport`, so
    // nothing can be auto-selected. Six checks never run — and the run must
    // say so instead of scoring 2/8 as a pass.
    const result = await runAgainst(extensionManager(), {
      config: { pollTimeoutMs: 500 },
    });

    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
    expect(result.checks.some((c) => c.status === "failed")).toBe(false);
    expect(
      result.checks.filter(
        (c) => c.status === "skipped" && c.skipReason === "could-not-run"
      )
      // Eleven, not six: the gap-program checks that also need a created task
      // report the same honest gap. The SCORED tally is still six, because they
      // are pending under `mcp-tasks@2026-08-22.1`.
    ).toHaveLength(11);
    expect(result.incompleteReason).toContain("--tool-name");
    expect(result.incompleteReason).toContain("long_job");
  });

  it("reports INCOMPLETE when the requested probe tool is not listed", async () => {
    const result = await runAgainst(extensionManager(), {
      config: { toolName: "nope", pollTimeoutMs: 500 },
    });

    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
    expect(result.incompleteReason).toContain('"nope"');
    expect(result.incompleteReason).toContain("is not listed by this server");
    expect(result.incompleteReason).toContain("long_job");
  });

  it("reports INCOMPLETE when the probed tool never produced a task", async () => {
    const manager = extensionManager({
      executeTool: async () => ({
        resultType: "complete",
        content: [{ type: "text", text: "sync" }],
      }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    // Result-type discipline DID run (a normal result is conformant); the
    // lifecycle checks did not, and that is the run's verdict.
    expect(statusMap(result)["tasks-result-type-discipline"]).toBe("passed");
    expect(statusMap(result)["tasks-ttl-shape"]).toBe("skipped");
    expect(result.outcome).toBe("incomplete");
    expect(result.incompleteReason).toContain("no task existed to inspect");
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
    expect(result.outcome).toBe("passed");
    expect(statusMap(result)["tasks-result-type-discipline"]).toBe("skipped");
    expect(statusMap(result)["tasks-ttl-shape"]).toBe("skipped");
    // Inapplicable, not unexercised: there is no tasks behavior to establish.
    expect(
      result.checks
        .filter((c) => c.status === "skipped")
        .every((c) => c.skipReason === "not-applicable")
    ).toBe(true);
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
    // A failed run is still a run, and its report still has to say which
    // questions were asked. Without this the profile stamp was dropped on
    // exactly the path where a reader is most likely to be comparing reports.
    expect(result.profile).toMatchObject({
      profileId: "mcp-tasks",
      profileVersion: expect.any(String),
      manifestDigest: expect.any(String),
    });
  });
});

/**
 * ext-tasks tasks.md:797-799 — servers MUST answer -32021 for a non-declaring
 * client on tasks/get, tasks/update, tasks/cancel, and on task notifications
 * requested through subscriptions/listen. Unconditional: anything else fails.
 */
describe("undeclared task requests (-32021)", () => {
  const runProbe = (perMethod: Record<string, () => unknown>) =>
    runAgainst(
      extensionManager({ getManagedClient: undeclaredSeam(perMethod) }),
      {
        config: { toolName: "long_job", pollTimeoutMs: 500 },
      }
    );

  it("passes when every undeclared request is rejected with -32021", async () => {
    const result = await runProbe({});

    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "passed"
    );
    const check = undeclaredCheck(result);
    expect(check?.warnings ?? []).toEqual([]);
    // The conformant rejection also NAMES the capability, which the sibling
    // check grades; it rides along on the same probe rather than costing a
    // second undeclared round.
    const rejected = {
      outcome: "rejected",
      code: -32021,
      reachedWire: true,
      requiredCapabilities: REQUIRED_CAPABILITIES,
    };
    expect(check?.details?.probes).toEqual([
      { method: "tasks/get", ...rejected },
      { method: "tasks/update", ...rejected },
      { method: "subscriptions/listen", ...rejected },
      { method: "tasks/cancel", ...rejected },
    ]);
  });

  for (const method of [
    "tasks/get",
    "tasks/update",
    "tasks/cancel",
    "subscriptions/listen",
  ]) {
    it(`fails when an undeclared ${method} is answered`, async () => {
      const result = await runProbe({ [method]: () => ({ taskId: "task-1" }) });

      expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
        "failed"
      );
      expect(result.passed).toBe(false);
      const check = undeclaredCheck(result);
      expect(check?.error?.message).toContain(`${method} was answered`);
      expect(check?.details?.probes).toContainEqual({
        method,
        outcome: "answered",
        reachedWire: false,
      });
    });

    it(`fails when an undeclared ${method} is rejected with another code`, async () => {
      const result = await runProbe({ [method]: rpcError(-32602) });

      expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
        "failed"
      );
      const check = undeclaredCheck(result);
      expect(check?.error?.message).toContain(
        `${method} was rejected with -32602`
      );
    });
  }

  it("tells a server still emitting -32003 which draft it is running", async () => {
    // -32003 is not just any wrong code: it is what the extension carried
    // before ext-tasks corrected it (c523f2c). Reporting it anonymously would
    // leave the operator to work out that their server predates the renumber.
    const result = await runProbe({ "tasks/get": rpcError(-32003) });

    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "failed"
    );
    const check = undeclaredCheck(result);
    expect(check?.error?.message).toContain("corrected to -32021");
    expect(check?.error?.message).toContain("pre-final draft");
  });

  it("names every offending method when several misbehave", async () => {
    const result = await runProbe({
      "tasks/update": () => ({}),
      "tasks/cancel": rpcError(-32601),
    });

    const check = undeclaredCheck(result);
    expect(check?.status).toBe("failed");
    expect(check?.error?.message).toContain("2 undeclared request(s)");
    expect(check?.error?.message).toContain("tasks/update was answered");
    expect(check?.error?.message).toContain("tasks/cancel was rejected with");
  });

  it("skips the subscriptions/listen sub-probe when the server lacks the method", async () => {
    // -32601 on a core method the extension only borrows: not probeable, so
    // it must not be judged. tasks/* still has to answer -32021.
    const result = await runProbe({
      "subscriptions/listen": rpcError(-32601, "Method not found"),
    });

    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "passed"
    );
    const check = undeclaredCheck(result);
    expect(check?.warnings?.[0]).toContain("subscriptions/listen");
    expect(check?.warnings?.[0]).toContain("not probed");
    expect(check?.details?.probes).toContainEqual(
      expect.objectContaining({
        method: "subscriptions/listen",
        outcome: "unsupported",
      })
    );
  });

  it("fails a probe the server received but never answered", async () => {
    const result = await runProbe({
      "subscriptions/listen": () => {
        // A stream the server held open past the probe deadline: upstream
        // raises an `SdkError` (STRING code, so no numeric `code` reaches the
        // runner), but the request DID go out.
        logSend("subscriptions/listen");
        throw new Error("stream stayed open");
      },
    });

    const check = undeclaredCheck(result);
    expect(check?.status).toBe("failed");
    expect(check?.error?.message).toContain("no JSON-RPC rejection");
    expect(check?.details?.probes).toContainEqual(
      expect.objectContaining({
        method: "subscriptions/listen",
        outcome: "no-response",
        reachedWire: true,
      })
    );
  });

  it("fails — and says so — when a probe never reaches the server at all", async () => {
    // The shape of the bug this seam was rewritten to kill: the request dies
    // locally (a missing result schema, upstream's outbound era gate), so the
    // -32021 requirement is never put to the server. It must never read as
    // conformance, and the failure must say the probe did not run.
    const result = await runProbe({
      "tasks/get": () => {
        throw new Error(
          "pass a result schema as the second argument to request()"
        );
      },
    });

    const check = undeclaredCheck(result);
    expect(check?.status).toBe("failed");
    expect(check?.error?.message).toContain(
      "tasks/get never reached the server"
    );
    expect(check?.error?.message).toContain("was NOT tested");
    expect(check?.details?.probes).toContainEqual(
      expect.objectContaining({
        method: "tasks/get",
        outcome: "probe-failed",
        reachedWire: false,
      })
    );
  });

  it("does not judge the -32601 escape hatch on tasks/* methods", async () => {
    // Only the listen sub-probe may be skipped: a server on the extension wire
    // declared the whole task method set, so -32601 there is a real failure.
    const result = await runProbe({ "tasks/get": rpcError(-32601) });

    expect(statusMap(result)["tasks-undeclared-capability-rejected"]).toBe(
      "failed"
    );
  });

  it("skips the check when the connection exposes no raw request seam", async () => {
    const result = await runAgainst(
      extensionManager({ getManagedClient: () => ({}) }),
      { config: { toolName: "long_job", pollTimeoutMs: 500 } }
    );

    const check = undeclaredCheck(result);
    // Skipped, but as a GAP: the -32021 requirement was never put to the
    // server, so the run cannot report conformance.
    expect(check?.status).toBe("skipped");
    expect(check?.skipReason).toBe("could-not-run");
    expect(check?.error?.message).toContain("raw request seam");
    expect(result.outcome).toBe("incomplete");
    expect(result.passed).toBe(false);
  });

  it("probes the mutating methods only after every check that reads the task", async () => {
    const order: string[] = [];
    const base = extensionManager();
    const declaredGet = base.getTaskExt as (
      serverId: string,
      taskId: string
    ) => Promise<unknown>;
    const manager = extensionManager({
      getTaskExt: async (serverId: string, taskId: string) => {
        order.push("declared:tasks/get");
        return declaredGet(serverId, taskId);
      },
      getManagedClient: () => ({
        requestWithSchema: async (payload: { method: string }) => {
          order.push(`undeclared:${payload.method}`);
          throw Object.assign(new Error("missing capability"), {
            code: -32021,
          });
        },
      }),
    });

    const result = await runAgainst(manager, {
      config: { toolName: "long_job", pollTimeoutMs: 500 },
    });

    // Every declared read (polling + the Mcp-Name routing probe) happens
    // first; the undeclared probes trail, cancel last of all.
    expect(order.slice(-4)).toEqual([
      "undeclared:tasks/get",
      "undeclared:tasks/update",
      "undeclared:subscriptions/listen",
      "undeclared:tasks/cancel",
    ]);
    const declaredReads = order.filter((entry) =>
      entry.startsWith("declared:")
    );
    expect(declaredReads.length).toBeGreaterThan(0);
    expect(order.indexOf("undeclared:tasks/update")).toBeGreaterThan(
      order.lastIndexOf("declared:tasks/get")
    );
    expect(statusMap(result)["tasks-inline-result"]).toBe("passed");
    expect(statusMap(result)["tasks-mcp-name-routing"]).toBe("passed");
  });
});
