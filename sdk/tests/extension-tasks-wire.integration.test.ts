/**
 * `io.modelcontextprotocol/tasks` (SEP-2663) extension wire, driven against the
 * raw HTTP fixture in `support/extension-tasks-fixture.ts`.
 *
 * PIN: modelcontextprotocol/ext-tasks @ 2c1425d9a288b9b1f489430fe1e00bb392b47e48.
 *
 * Everything that CAN go through the real client (`MCPClientManager`, no mocked
 * `ManagedMcpClient`) does — negotiation, `tools/call` task creation, the
 * per-request declaration, the `CreateTaskResult` unwrap.
 *
 * The `tasks/get|update|cancel` legs currently cannot: see the
 * "client-side blocker" describe below, which pins the exact beta.4 behavior
 * that stops them. Until that is resolved those MUSTs are proved with
 * {@link RawTasksWire} — a hand-built JSON-RPC driver that emits the same bytes
 * `tasks-ext.ts` + `wrapFetchForTaskRouting` would (per-request capability
 * declaration in `_meta`, `Mcp-Name`/`Mcp-Method` routing headers), so the
 * server-side contract is genuinely exercised end-to-end over a socket.
 */

import { afterEach, describe, expect, it } from "vitest";
import { MCPClientManager } from "../src/mcp-client-manager/index.js";
import {
  DEFAULT_INPUT_REQUEST_KEY,
  EXTENSION_PROTOCOL_VERSION,
  HOSTILE_INPUT_REQUESTS,
  PARTIAL_INPUT_REQUESTS,
  SYNC_TOOL_NAME,
  TASK_TOOL_NAME,
  TASKS_EXTENSION_ID,
  cancellablePhases,
  failedTaskPhases,
  isErrorCompletedPhases,
  oddNumbersPhases,
  serveExtensionTasksFixture,
  taskTool,
  type ExtensionTasksFixtureOptions,
  type ServedExtensionTasksFixture,
} from "./support/extension-tasks-fixture.js";

const SERVER_ID = "ext";

/** The per-request declaration the spec requires (tasks.md:27-41). */
const DECLARING_META = {
  "io.modelcontextprotocol/clientCapabilities": {
    extensions: { [TASKS_EXTENSION_ID]: {} },
  },
};

/** Everything a test opened, torn down unconditionally in `afterEach`. */
const opened: {
  managers: MCPClientManager[];
  fixtures: ServedExtensionTasksFixture[];
} = { managers: [], fixtures: [] };

afterEach(async () => {
  for (const manager of opened.managers.splice(0)) {
    await manager.disconnectAllServers().catch(() => {});
  }
  for (const fixture of opened.fixtures.splice(0)) {
    await fixture.close().catch(() => {});
  }
});

async function serve(
  options: ExtensionTasksFixtureOptions = {}
): Promise<ServedExtensionTasksFixture> {
  const fixture = await serveExtensionTasksFixture(options);
  opened.fixtures.push(fixture);
  return fixture;
}

async function connect(
  url: string,
  serverId = SERVER_ID
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  opened.managers.push(manager);
  await manager.connectToServer(serverId, {
    url,
    mcpProtocolVersion: EXTENSION_PROTOCOL_VERSION,
    timeout: 10_000,
  });
  return manager;
}

/** Starts a task through the real `tools/call` path and returns its handle. */
async function createTask(
  manager: MCPClientManager,
  toolName = TASK_TOOL_NAME,
  serverId = SERVER_ID
): Promise<Record<string, unknown>> {
  return (await manager.executeTool(
    serverId,
    toolName,
    {},
    {
      allowTaskResult: true,
    }
  )) as Record<string, unknown>;
}

interface RawResponse {
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A minimal JSON-RPC driver for the extension methods, byte-compatible with
 * what the SDK emits: the capability declaration rides in `params._meta`, and
 * `tasks/*` carries `Mcp-Name: <taskId>` (tasks.md:511).
 */
class RawTasksWire {
  private nextId = 1;
  constructor(private readonly url: string) {}

  async send(
    method: string,
    params: Record<string, unknown> = {},
    options: { declare?: boolean; routeBy?: string } = {}
  ): Promise<RawResponse> {
    const declare = options.declare !== false;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": EXTENSION_PROTOCOL_VERSION,
      "mcp-method": method,
    };
    if (options.routeBy) headers["mcp-name"] = options.routeBy;
    const response = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method,
        params: declare ? { ...params, _meta: DECLARING_META } : params,
      }),
    });
    return (await response.json()) as RawResponse;
  }

  /** `tasks/get`, asserting it succeeded, and returning the task. */
  async get(taskId: string): Promise<Record<string, unknown>> {
    const response = await this.send(
      "tasks/get",
      { taskId },
      { routeBy: taskId }
    );
    expect(response.error, `tasks/get(${taskId})`).toBeUndefined();
    return response.result as Record<string, unknown>;
  }

  update(taskId: string, inputResponses: Record<string, unknown>) {
    return this.send(
      "tasks/update",
      { taskId, inputResponses },
      { routeBy: taskId }
    );
  }

  cancel(taskId: string) {
    return this.send("tasks/cancel", { taskId }, { routeBy: taskId });
  }
}

function inputRequestsOf(task: Record<string, unknown>) {
  return (task.inputRequests ?? undefined) as
    | Record<string, unknown>
    | undefined;
}

describe("tasks extension wire — negotiation (real client)", () => {
  it("resolves the extension wire from the advertised capability", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    expect(manager.getNegotiatedProtocolVersion(SERVER_ID)).toBe(
      EXTENSION_PROTOCOL_VERSION
    );
    expect(manager.getTasksWire(SERVER_ID)).toBe("extension");
    expect(manager.getTasksSupport(SERVER_ID)).toMatchObject({
      wire: "extension",
      toolCalls: true,
      update: true,
      cancel: true,
      inlineResult: true,
      list: false,
    });
  });

  it("treats a non-empty extension capability value as support", async () => {
    // `schema.json` renders the capability as an empty object, but the prose
    // only says no settings are "currently" defined — forward compat.
    const fixture = await serve({
      tasksExtensionCapability: { someFutureSetting: true },
    });
    const manager = await connect(fixture.url);
    expect(manager.getTasksWire(SERVER_ID)).toBe("extension");
  });

  it("resolves no wire when the server does not advertise the extension", async () => {
    const fixture = await serve({ advertiseTasksExtension: false });
    const manager = await connect(fixture.url);

    expect(manager.getTasksWire(SERVER_ID)).toBe("none");
    await expect(manager.getTaskExt(SERVER_ID, "ext-task-1")).rejects.toThrow(
      /does not speak the io\.modelcontextprotocol\/tasks extension/
    );
    // Nothing was probed on the wire.
    expect(fixture.received.some((r) => r.method.startsWith("tasks/"))).toBe(
      false
    );
  });
});

describe("tasks extension wire — task creation (real client)", () => {
  it("returns a plain result when the server declines to make a task", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const result = (await manager.executeTool(
      SERVER_ID,
      SYNC_TOOL_NAME,
      {},
      {
        allowTaskResult: true,
      }
    )) as Record<string, unknown>;

    expect(result.resultType).not.toBe("task");
    expect(result).toMatchObject({
      content: [{ type: "text", text: "sync result" }],
    });
    expect(fixture.tasks()).toHaveLength(0);
  });

  it("creates a task and surfaces the flat CreateTaskResult", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const created = await createTask(manager);

    expect(created).toMatchObject({
      resultType: "task",
      taskId: "ext-task-1",
      status: "working",
      ttlMs: 60_000,
      pollIntervalMs: 10,
    });
    expect(typeof created.createdAt).toBe("string");
    expect(typeof created.lastUpdatedAt).toBe("string");
    // `CreateTaskResult = Result & Task` — bare Task fields only.
    expect(created.inputRequests).toBeUndefined();
    expect(created.result).toBeUndefined();
    expect(created.error).toBeUndefined();
  });

  it("declares the extension in the tools/call _meta, and only when eligible", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    await createTask(manager);
    await manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {});

    const calls = fixture.received.filter((r) => r.method === "tools/call");
    expect(calls).toHaveLength(2);
    const declared = (calls[0].params?._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/clientCapabilities"
    ] as { extensions?: Record<string, unknown> };
    expect(declared.extensions).toHaveProperty(TASKS_EXTENSION_ID);

    const undeclared = (calls[1].params?._meta as Record<string, unknown>)[
      "io.modelcontextprotocol/clientCapabilities"
    ] as { extensions?: Record<string, unknown> };
    expect(undeclared.extensions ?? {}).not.toHaveProperty(TASKS_EXTENSION_ID);
  });

  it("is never handed a CreateTaskResult on an undeclared call", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const result = (await manager.executeTool(
      SERVER_ID,
      TASK_TOOL_NAME,
      {}
    )) as Record<string, unknown>;

    expect(result.resultType).not.toBe("task");
    expect(result.taskId).toBeUndefined();
    expect(fixture.tasks()).toHaveLength(0);
  });

  it("rejects a task-shaped result that omits resultType: task", async () => {
    const fixture = await serve({
      misbehave: { createResultType: "complete" },
    });
    const manager = await connect(fixture.url);

    // tasks.md:102 — without the discriminator there is no task, and the
    // payload is not a valid `CallToolResult` either, so the call must fail
    // rather than silently produce a half-interpreted handle.
    await expect(createTask(manager)).rejects.toThrow(
      /Invalid result for tools\/call/
    );
    // The handle nonetheless exists server-side: it was leaked into a shape
    // the client is not allowed to read as a task.
    expect(fixture.tasks()).toHaveLength(1);
  });
});

/**
 * KNOWN CLIENT-SIDE BLOCKER (report, do not fix here — `sdk/src` is owned by
 * another agent).
 *
 * `@modelcontextprotocol/client` beta.4 derives its "spec method universe"
 * from the union of the era registries and era-gates every member at send
 * time (`_assertOutboundRequestInEra`). `tasks/get`, `tasks/cancel`,
 * `tasks/result` and `tasks/list` are members via the **2025-11-25** registry
 * and are absent from the 2026-07-28 registry, so on an extension-era
 * connection the client refuses to put them on the wire — the extension's own
 * `tasks/get` and `tasks/cancel` are collateral damage of the in-core
 * utility's deletion. `_requestWithSchema` asserts too ("an explicit schema
 * never smuggles a deleted method onto the wire"), so passing a result schema
 * is not a way out for those two.
 *
 * `tasks/update` is in NEITHER registry, so it is era-blind — but
 * `client.request()` refuses non-spec methods without an explicit result
 * schema, and `tasks-ext.ts` calls the schema-less overload.
 *
 * Net effect today: `MCPClientManager.getTaskExt` / `updateTask` /
 * `cancelTaskExt` cannot reach a conforming SEP-2663 server at all. These
 * tests pin the current behavior so the fix is visible when it lands.
 */
describe("tasks extension wire — client-side blocker (beta.4)", () => {
  it("blocks tasks/get and tasks/cancel as methods deleted from the 2026 era", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    await expect(manager.getTaskExt(SERVER_ID, taskId)).rejects.toMatchObject({
      code: "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION",
    });
    await expect(
      manager.cancelTaskExt(SERVER_ID, taskId)
    ).rejects.toMatchObject({
      code: "METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION",
    });
  });

  it("blocks tasks/update for want of an explicit result schema", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    await expect(
      manager.updateTask(SERVER_ID, taskId, {} as never)
    ).rejects.toThrow(/'tasks\/update' is not a spec method/);
  });

  it("leaves the server untouched — nothing reached the wire", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    await manager.getTaskExt(SERVER_ID, taskId).catch(() => {});
    await manager.updateTask(SERVER_ID, taskId, {} as never).catch(() => {});
    await manager.cancelTaskExt(SERVER_ID, taskId).catch(() => {});

    expect(
      fixture.received.filter((r) => r.method.startsWith("tasks/"))
    ).toEqual([]);
  });
});

describe("tasks extension wire — full lifecycle", () => {
  it("drives create → poll → input_required → update → completed → cancel", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const wire = new RawTasksWire(fixture.url);

    // Creation goes through the REAL client.
    const taskId = (await createTask(manager)).taskId as string;

    // Poll 1: still working, no status payload.
    const first = await wire.get(taskId);
    expect(first).toMatchObject({ resultType: "complete", status: "working" });
    expect(first.result).toBeUndefined();
    expect(first.inputRequests).toBeUndefined();
    expect(first.error).toBeUndefined();

    // Poll 2: input_required, carrying the keyed snapshot.
    const second = await wire.get(taskId);
    expect(second.status).toBe("input_required");
    expect(Object.keys(inputRequestsOf(second) ?? {})).toEqual([
      DEFAULT_INPUT_REQUEST_KEY,
    ]);
    expect(inputRequestsOf(second)?.[DEFAULT_INPUT_REQUEST_KEY]).toMatchObject({
      method: "elicitation/create",
    });
    // `ttlMs` / `pollIntervalMs` legitimately changed across polls.
    expect(second.ttlMs).toBe(45_000);
    expect(second.pollIntervalMs).toBe(20);

    // Poll 3: the SAME snapshot is re-sent while the request is outstanding.
    const third = await wire.get(taskId);
    expect(third.status).toBe("input_required");
    expect(third.inputRequests).toEqual(second.inputRequests);

    // tasks/update — an EMPTY acknowledgement, not a task.
    const ack = await wire.update(taskId, {
      [DEFAULT_INPUT_REQUEST_KEY]: {
        action: "accept",
        content: { input: "Luca" },
      },
    });
    expect(ack.error).toBeUndefined();
    expect(ack.result).toEqual({ resultType: "complete" });

    // Eventual consistency: the status moves only on a LATER poll.
    const fourth = await wire.get(taskId);
    expect(fourth.status).toBe("working");
    expect(fourth.inputRequests).toBeUndefined();

    // Completed, with the tool result INLINE (there is no tasks/result).
    const fifth = await wire.get(taskId);
    expect(fifth.status).toBe("completed");
    expect(fifth.result).toEqual({
      content: [{ type: "text", text: "Hello, Luca!" }],
      isError: false,
    });

    // A terminal task sticks.
    expect((await wire.get(taskId)).status).toBe("completed");

    // tasks/cancel is likewise an empty ack.
    const cancelAck = await wire.cancel(taskId);
    expect(cancelAck.error).toBeUndefined();
    expect(cancelAck.result).toEqual({ resultType: "complete" });
  });

  it("carries Mcp-Name: <taskId> on every routed tasks/* request", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const wire = new RawTasksWire(fixture.url);

    const taskId = (await createTask(manager)).taskId as string;
    await wire.get(taskId);
    await wire.update(taskId, {});
    await wire.cancel(taskId);

    const routed = fixture.received.filter((r) =>
      ["tasks/get", "tasks/update", "tasks/cancel"].includes(r.method)
    );
    expect(routed.map((r) => r.method)).toEqual([
      "tasks/get",
      "tasks/update",
      "tasks/cancel",
    ]);
    for (const request of routed) {
      // tasks.md:511 — the Streamable HTTP routing binding.
      expect(request.headers["mcp-name"]).toBe(taskId);
      expect(request.headers["mcp-method"]).toBe(request.method);
    }
  });

  it("reads a task created on a previous connection (durability)", async () => {
    const fixture = await serve();
    const first = await connect(fixture.url, "first");
    const taskId = (await createTask(first, TASK_TOOL_NAME, "first"))
      .taskId as string;

    // Drop the connection entirely, then read the handle from a fresh one.
    await first.disconnectAllServers();
    const second = await connect(fixture.url, "second");
    expect(second.getTasksWire("second")).toBe("extension");

    const task = await new RawTasksWire(fixture.url).get(taskId);
    expect(task).toMatchObject({ taskId, status: "working" });
  });
});

describe("tasks extension wire — status variants", () => {
  it("reports a JSON-RPC execution fault as failed + error", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(failedTaskPhases()) },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const task = await new RawTasksWire(fixture.url).get(taskId);
    expect(task.status).toBe("failed");
    expect(task.error).toEqual({
      code: -32603,
      message: "API rate limit exceeded",
    });
    expect(task.result).toBeUndefined();
    expect(task.statusMessage).toContain("rate limit");
  });

  it("reports a tool result with isError: true as COMPLETED, not failed", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(isErrorCompletedPhases()) },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const task = await new RawTasksWire(fixture.url).get(taskId);
    // tasks.md:837 — `failed` is strictly for JSON-RPC-level faults.
    expect(task.status).toBe("completed");
    expect(task.error).toBeUndefined();
    expect(task.result).toMatchObject({ isError: true });
  });

  it("reaches cancelled only after the cancel is acknowledged", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(cancellablePhases()) },
    });
    const manager = await connect(fixture.url);
    const wire = new RawTasksWire(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    expect((await wire.get(taskId)).status).toBe("working");
    const ack = await wire.cancel(taskId);
    expect(ack.result).toEqual({ resultType: "complete" });

    const task = await wire.get(taskId);
    expect(task.status).toBe("cancelled");
    expect(task.result).toBeUndefined();
    expect(task.error).toBeUndefined();
  });

  it("accepts legal-but-unusual ttlMs / pollIntervalMs that change per poll", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(oddNumbersPhases()) },
    });
    const manager = await connect(fixture.url);
    const wire = new RawTasksWire(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const ttls: unknown[] = [];
    const intervals: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      const task = await wire.get(taskId);
      ttls.push(task.ttlMs);
      intervals.push(task.pollIntervalMs);
    }

    // Neither integrality nor a minimum is constrained by the schema, and
    // `null` means unlimited (distinct from absent).
    expect(ttls).toEqual([1234.567, Number.MAX_SAFE_INTEGER, null, -1]);
    expect(intervals).toEqual([0.5, 1, 2, 2]);
  });
});

describe("tasks extension wire — input requests", () => {
  it("keeps unanswered keys outstanding across a partial update", async () => {
    const fixture = await serve({
      tools: {
        [TASK_TOOL_NAME]: taskTool([
          {
            status: "input_required",
            inputRequests: PARTIAL_INPUT_REQUESTS,
            awaitInputKeys: [DEFAULT_INPUT_REQUEST_KEY, "city"],
          },
          {
            status: "completed",
            result: { content: [{ type: "text", text: "both answered" }] },
          },
        ]),
      },
    });
    const manager = await connect(fixture.url);
    const wire = new RawTasksWire(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const first = await wire.get(taskId);
    expect(Object.keys(inputRequestsOf(first) ?? {}).sort()).toEqual([
      "city",
      DEFAULT_INPUT_REQUEST_KEY,
    ]);

    // Answer one key, plus a key that was never issued: tasks.md:379 says the
    // server ignores unknown keys, and the task stays `input_required`.
    await wire.update(taskId, {
      [DEFAULT_INPUT_REQUEST_KEY]: { action: "accept", content: {} },
      never_issued: { action: "accept", content: {} },
    });

    const second = await wire.get(taskId);
    expect(second.status).toBe("input_required");
    expect(Object.keys(inputRequestsOf(second) ?? {})).toEqual(["city"]);
    expect(fixture.task(taskId)?.answeredKeys).toEqual([
      DEFAULT_INPUT_REQUEST_KEY,
    ]);

    await wire.update(taskId, { city: { action: "accept", content: {} } });
    expect((await wire.get(taskId)).status).toBe("completed");
  });

  it("surfaces unknown-method and prototype-polluting keys without polluting", async () => {
    const fixture = await serve({
      tools: {
        [TASK_TOOL_NAME]: taskTool([
          {
            status: "input_required",
            inputRequests: HOSTILE_INPUT_REQUESTS,
            polls: 99,
          },
        ]),
      },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const task = await new RawTasksWire(fixture.url).get(taskId);
    const requests = inputRequestsOf(task) ?? {};
    expect(Object.keys(requests).sort()).toEqual([
      "__proto__",
      "constructor",
      "unknown_method",
    ]);
    // The unknown method is visible verbatim rather than dropped.
    expect(requests.unknown_method).toMatchObject({
      method: "tasks/definitely-not-a-real-method",
    });
    // Nothing leaked onto a prototype.
    expect(({} as Record<string, unknown>).method).toBeUndefined();
    expect(Object.getPrototypeOf(requests)).not.toHaveProperty("method");
  });
});

describe("tasks extension wire — protocol errors", () => {
  it("raises -32602 for an unknown task id on tasks/get", async () => {
    const fixture = await serve();
    const response = await new RawTasksWire(fixture.url).send(
      "tasks/get",
      { taskId: "no-such-task" },
      { routeBy: "no-such-task" }
    );
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toMatch(/Task not found/);
  });

  it("allows a non--32602 code on tasks/update and tasks/cancel (SHOULD only)", async () => {
    // tasks.md:795 — `-32602` is a MUST for `tasks/get` but only a SHOULD for
    // the mutations, so a different code there is still compliant.
    const fixture = await serve({ unknownTaskCodeForMutations: -32603 });
    const wire = new RawTasksWire(fixture.url);

    expect((await wire.update("no-such-task", {})).error?.code).toBe(-32603);
    expect((await wire.cancel("no-such-task")).error?.code).toBe(-32603);
  });

  it("rejects undeclared tasks/get, tasks/update and tasks/cancel with -32003", async () => {
    const fixture = await serve();
    const wire = new RawTasksWire(fixture.url);

    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const response = await wire.send(
        method,
        { taskId: "ext-task-1", inputResponses: {} },
        { declare: false, routeBy: "ext-task-1" }
      );
      expect(response.error?.code, method).toBe(-32003);
      expect(response.error?.data).toEqual({
        requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
      });
    }
  });

  it("rejects an undeclared task-filtered subscriptions/listen with -32003", async () => {
    const fixture = await serve();
    const wire = new RawTasksWire(fixture.url);

    const rejected = await wire.send(
      "subscriptions/listen",
      { notifications: { taskIds: ["ext-task-1"] } },
      { declare: false }
    );
    expect(rejected.error?.code).toBe(-32003);

    // A declaring listen is accepted…
    const declared = await wire.send("subscriptions/listen", {
      notifications: { taskIds: ["ext-task-1"] },
    });
    expect(declared.error).toBeUndefined();

    // …and a listen with no taskIds is not gated on the extension at all.
    const unrelated = await wire.send(
      "subscriptions/listen",
      { notifications: { resources: true } },
      { declare: false }
    );
    expect(unrelated.error).toBeUndefined();
  });
});

describe("tasks extension wire — misbehaving server", () => {
  it("can answer an undeclared tasks/get (negative case for the -32003 rule)", async () => {
    const fixture = await serve({
      misbehave: { answerUndeclaredTaskRequests: true },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const response = await new RawTasksWire(fixture.url).send(
      "tasks/get",
      { taskId },
      { declare: false, routeBy: taskId }
    );
    expect(response.error).toBeUndefined();
    expect(response.result).toMatchObject({ taskId, status: "working" });
  });

  it("can hand a CreateTaskResult to an undeclared tools/call", async () => {
    const fixture = await serve({
      misbehave: { createTaskForUndeclaredCall: true },
    });
    const response = await new RawTasksWire(fixture.url).send(
      "tools/call",
      { name: TASK_TOOL_NAME, arguments: {} },
      { declare: false }
    );
    expect(response.result).toMatchObject({ resultType: "task" });
    expect(fixture.tasks()).toHaveLength(1);
  });

  it("can emit an invalid status, and the real client refuses it at creation", async () => {
    const fixture = await serve({ misbehave: { status: "in_progress" } });
    const manager = await connect(fixture.url);

    await expect(createTask(manager)).rejects.toThrow(
      /not a valid io\.modelcontextprotocol\/tasks payload.*status/s
    );
  });

  it("can omit a required task field, and the real client refuses it", async () => {
    // `ttlMs` is required and nullable — absent is NOT the same as null.
    const fixture = await serve({ misbehave: { omitTaskFields: ["ttlMs"] } });
    const manager = await connect(fixture.url);

    await expect(createTask(manager)).rejects.toThrow(
      /not a valid io\.modelcontextprotocol\/tasks payload.*ttlMs/s
    );
  });

  it("can turn a healthy task malformed mid-flight", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;
    const wire = new RawTasksWire(fixture.url);

    expect((await wire.get(taskId)).status).toBe("working");
    fixture.misbehave({ status: "in_progress", omitTaskFields: ["ttlMs"] });

    const task = await wire.get(taskId);
    expect(task.status).toBe("in_progress");
    expect(task).not.toHaveProperty("ttlMs");
  });

  it("can send resultType: task on a tasks/get result", async () => {
    const fixture = await serve({ misbehave: { getResultType: "task" } });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const task = await new RawTasksWire(fixture.url).get(taskId);
    // tasks.md:102 — `"task"` MUST NOT appear on anything but CreateTaskResult.
    expect(task.resultType).toBe("task");
  });

  it("can drop the status payload a status requires", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(isErrorCompletedPhases()) },
      misbehave: { omitStatusPayload: true },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const task = await new RawTasksWire(fixture.url).get(taskId);
    expect(task.status).toBe("completed");
    // A `completed` task MUST carry `result` (tasks.md:330).
    expect(task.result).toBeUndefined();
  });

  it("can fabricate a task for an id that was never issued", async () => {
    const fixture = await serve({ misbehave: { answerUnknownTaskId: true } });
    const task = await new RawTasksWire(fixture.url).get("never-issued");
    expect(task.taskId).toBe("never-issued");
  });
});

describe("tasks extension wire — resultType on tasks/* results", () => {
  it("carries resultType: complete by default (the prose MUST)", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;
    const wire = new RawTasksWire(fixture.url);

    expect((await wire.get(taskId)).resultType).toBe("complete");
    expect((await wire.update(taskId, {})).result).toEqual({
      resultType: "complete",
    });
    expect((await wire.cancel(taskId)).result).toEqual({
      resultType: "complete",
    });
  });

  it("can omit it entirely (the schema-literal reading)", async () => {
    // `resultType` appears nowhere in the pinned schema, and each
    // `DetailedTask` variant is rendered `additionalProperties: false`.
    const fixture = await serve({ emitTaskResultType: false });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;
    const wire = new RawTasksWire(fixture.url);

    const task = await wire.get(taskId);
    expect(task).not.toHaveProperty("resultType");
    expect(task.status).toBe("working");
    expect((await wire.update(taskId, {})).result).toEqual({});
    expect((await wire.cancel(taskId)).result).toEqual({});
  });
});
