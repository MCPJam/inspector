/**
 * `io.modelcontextprotocol/tasks` (SEP-2663) extension wire, driven against the
 * raw HTTP fixture in `support/extension-tasks-fixture.ts`.
 *
 * PIN: modelcontextprotocol/ext-tasks @ 2c1425d9a288b9b1f489430fe1e00bb392b47e48.
 *
 * Everything that CAN go through the real client (`MCPClientManager`, no mocked
 * `ManagedMcpClient`) does — negotiation, `tools/call` task creation, the
 * per-request declaration, the `CreateTaskResult` unwrap, and — since the
 * explicit-result-schema carrier (`tasks-ext.ts`) plus the era-gate shadow
 * (`tasks-ext-era-gate.ts`) landed — the whole `tasks/get|update|cancel`
 * lifecycle.
 *
 * {@link RawTasksWire} survives for the cases the real client CANNOT produce
 * by construction, each marked at its use site:
 *   - undeclared requests (`-32021`): our client always attaches the
 *     per-request eligibility declaration, so an undeclared extension request
 *     is unreachable through it;
 *   - payloads beta.4's decoder rewrites or refuses before `tasks-ext.ts` sees
 *     them (`resultType: "task"` on a `tasks/get`, or an absent `resultType`),
 *     where the point of the test is the bytes on the wire.
 * It emits the same bytes the SDK does (declaration in `params._meta`,
 * `Mcp-Name`/`Mcp-Method` routing headers).
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

/**
 * `tasks/get` through the REAL client, widened to a bag so a test can assert
 * on fields the status-discriminated union hides (a `working` task has no
 * `result` in the type, and a debugger test wants to prove that on the value).
 */
async function getTask(
  manager: MCPClientManager,
  taskId: string,
  serverId = SERVER_ID
): Promise<Record<string, unknown>> {
  return (await manager.getTaskExt(serverId, taskId)) as unknown as Record<
    string,
    unknown
  >;
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

describe("tasks extension wire — full lifecycle (real client)", () => {
  it("drives create → poll → input_required → update → completed → cancel", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const taskId = (await createTask(manager)).taskId as string;

    // Poll 1: still working, no status payload.
    const first = await getTask(manager, taskId);
    expect(first).toMatchObject({ taskId, status: "working" });
    expect(first.result).toBeUndefined();
    expect(first.inputRequests).toBeUndefined();
    expect(first.error).toBeUndefined();
    // beta.4's 2026 decoder consumes `resultType` off every complete result,
    // so a task read through the real client never carries it (the raw wire
    // value is asserted in the `resultType on tasks/* results` describe).
    expect(first).not.toHaveProperty("resultType");

    // Poll 2: input_required, carrying the keyed snapshot.
    const second = await getTask(manager, taskId);
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
    const third = await getTask(manager, taskId);
    expect(third.status).toBe("input_required");
    expect(inputRequestsOf(third)).toEqual(inputRequestsOf(second));

    // tasks/update — an EMPTY acknowledgement, not a task.
    const ack = await manager.updateTask(SERVER_ID, taskId, {
      [DEFAULT_INPUT_REQUEST_KEY]: {
        action: "accept",
        content: { input: "Luca" },
      },
    } as never);
    expect(ack).toEqual({});

    // Eventual consistency: the status moves only on a LATER poll.
    const fourth = await getTask(manager, taskId);
    expect(fourth.status).toBe("working");
    expect(fourth.inputRequests).toBeUndefined();

    // Completed, with the tool result INLINE (there is no tasks/result).
    const fifth = await getTask(manager, taskId);
    expect(fifth.status).toBe("completed");
    expect(fifth.result).toEqual({
      content: [{ type: "text", text: "Hello, Luca!" }],
      isError: false,
    });

    // A terminal task sticks.
    expect((await getTask(manager, taskId)).status).toBe("completed");

    // tasks/cancel is likewise an empty ack.
    expect(await manager.cancelTaskExt(SERVER_ID, taskId)).toEqual({});
  });

  it("declares the extension on every tasks/* request it sends", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    await manager.getTaskExt(SERVER_ID, taskId);
    await manager.updateTask(SERVER_ID, taskId, {} as never);
    await manager.cancelTaskExt(SERVER_ID, taskId);

    const routed = fixture.received.filter((r) =>
      r.method.startsWith("tasks/")
    );
    expect(routed).toHaveLength(3);
    for (const request of routed) {
      // tasks.md:27-41 — the eligibility declaration is required on EVERY
      // extension operation, not just the `tools/call` that creates the task.
      const declared = (request.params?._meta as Record<string, unknown>)[
        "io.modelcontextprotocol/clientCapabilities"
      ] as { extensions?: Record<string, unknown> };
      expect(declared.extensions, request.method).toHaveProperty(
        TASKS_EXTENSION_ID
      );
    }
  });

  it("carries Mcp-Name: <taskId> on every routed tasks/* request", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    const taskId = (await createTask(manager)).taskId as string;
    await manager.getTaskExt(SERVER_ID, taskId);
    await manager.updateTask(SERVER_ID, taskId, {} as never);
    await manager.cancelTaskExt(SERVER_ID, taskId);

    const routed = fixture.received.filter((r) =>
      ["tasks/get", "tasks/update", "tasks/cancel"].includes(r.method)
    );
    expect(routed.map((r) => r.method)).toEqual([
      "tasks/get",
      "tasks/update",
      "tasks/cancel",
    ]);
    for (const request of routed) {
      // tasks.md:511 — the Streamable HTTP routing binding, a MUST for all
      // three methods.
      expect(request.headers["mcp-name"], request.method).toBe(taskId);
      expect(request.headers["mcp-method"], request.method).toBe(
        request.method
      );
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

    const task = await getTask(second, taskId, "second");
    expect(task).toMatchObject({ taskId, status: "working" });
  });
});

describe("tasks extension wire — status variants (real client)", () => {
  it("reports a JSON-RPC execution fault as failed + error", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(failedTaskPhases()) },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const task = await getTask(manager, taskId);
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

    const task = await getTask(manager, taskId);
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
    const taskId = (await createTask(manager)).taskId as string;

    expect((await getTask(manager, taskId)).status).toBe("working");
    expect(await manager.cancelTaskExt(SERVER_ID, taskId)).toEqual({});

    const task = await getTask(manager, taskId);
    expect(task.status).toBe("cancelled");
    expect(task.result).toBeUndefined();
    expect(task.error).toBeUndefined();
  });

  it("accepts legal-but-unusual ttlMs / pollIntervalMs that change per poll", async () => {
    const fixture = await serve({
      tools: { [TASK_TOOL_NAME]: taskTool(oddNumbersPhases()) },
    });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    const ttls: unknown[] = [];
    const intervals: unknown[] = [];
    for (let i = 0; i < 4; i += 1) {
      const task = await getTask(manager, taskId);
      ttls.push(task.ttlMs);
      intervals.push(task.pollIntervalMs);
    }

    // Neither integrality nor a minimum is constrained by the schema, and
    // `null` means unlimited (distinct from absent).
    expect(ttls).toEqual([1234.567, Number.MAX_SAFE_INTEGER, null, -1]);
    expect(intervals).toEqual([0.5, 1, 2, 2]);
  });
});

describe("tasks extension wire — input requests (real client)", () => {
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
    const taskId = (await createTask(manager)).taskId as string;

    const first = await getTask(manager, taskId);
    expect(Object.keys(inputRequestsOf(first) ?? {}).sort()).toEqual([
      "city",
      DEFAULT_INPUT_REQUEST_KEY,
    ]);

    // Answer one key, plus a key that was never issued: tasks.md:379 says the
    // server ignores unknown keys, and the task stays `input_required`.
    await manager.updateTask(SERVER_ID, taskId, {
      [DEFAULT_INPUT_REQUEST_KEY]: { action: "accept", content: {} },
      never_issued: { action: "accept", content: {} },
    } as never);

    const second = await getTask(manager, taskId);
    expect(second.status).toBe("input_required");
    expect(Object.keys(inputRequestsOf(second) ?? {})).toEqual(["city"]);
    expect(fixture.task(taskId)?.answeredKeys).toEqual([
      DEFAULT_INPUT_REQUEST_KEY,
    ]);

    await manager.updateTask(SERVER_ID, taskId, {
      city: { action: "accept", content: {} },
    } as never);
    expect((await getTask(manager, taskId)).status).toBe("completed");
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

    const task = await getTask(manager, taskId);
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
    // Nothing leaked onto a prototype: the guard rebuilds the map on a NULL
    // prototype (`tasks-ext-schemas.ts toSafeInputRequests`).
    expect(({} as Record<string, unknown>).method).toBeUndefined();
    expect(Object.getPrototypeOf(requests)).toBeNull();
  });
});

describe("tasks extension wire — protocol errors", () => {
  it("surfaces -32602 for an unknown task id on tasks/get (real client)", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    // tasks.md:795 — a MUST for `tasks/get`. The server error must reach the
    // caller as a typed rejection, not as a task.
    await expect(
      manager.getTaskExt(SERVER_ID, "no-such-task")
    ).rejects.toMatchObject({ code: -32602 });
    await expect(manager.getTaskExt(SERVER_ID, "no-such-task")).rejects.toThrow(
      /Task not found/
    );
  });

  it("surfaces a non--32602 code on tasks/update and tasks/cancel (SHOULD only, real client)", async () => {
    // tasks.md:795 — `-32602` is only a SHOULD for the mutations, so a
    // different code there is still compliant and must pass through verbatim.
    const fixture = await serve({ unknownTaskCodeForMutations: -32603 });
    const manager = await connect(fixture.url);

    await expect(
      manager.updateTask(SERVER_ID, "no-such-task", {} as never)
    ).rejects.toMatchObject({ code: -32603 });
    await expect(
      manager.cancelTaskExt(SERVER_ID, "no-such-task")
    ).rejects.toMatchObject({ code: -32603 });
  });

  it("rejects undeclared tasks/get, tasks/update and tasks/cancel with -32021", async () => {
    // RAW BY CONSTRUCTION: `tasks-ext.ts` attaches the eligibility declaration
    // to every extension request, so the real client can never emit an
    // undeclared one. The server-side MUST is still worth pinning.
    const fixture = await serve();
    const wire = new RawTasksWire(fixture.url);

    for (const method of ["tasks/get", "tasks/update", "tasks/cancel"]) {
      const response = await wire.send(
        method,
        { taskId: "ext-task-1", inputResponses: {} },
        { declare: false, routeBy: "ext-task-1" }
      );
      expect(response.error?.code, method).toBe(-32021);
      expect(response.error?.data).toEqual({
        requiredCapabilities: { extensions: { [TASKS_EXTENSION_ID]: {} } },
      });
    }
  });

  it("rejects an undeclared task-filtered subscriptions/listen with -32021", async () => {
    // RAW BY CONSTRUCTION: same reason as above — the undeclared leg is
    // unreachable through our client.
    const fixture = await serve();
    const wire = new RawTasksWire(fixture.url);

    const rejected = await wire.send(
      "subscriptions/listen",
      { notifications: { taskIds: ["ext-task-1"] } },
      { declare: false }
    );
    expect(rejected.error?.code).toBe(-32021);

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

/**
 * Server-side misbehavior. The cases that stay on {@link RawTasksWire} are the
 * ones whose POINT is the bytes: beta.4's 2026 decoder consumes/validates
 * `resultType` before `tasks-ext.ts` can see the payload (it rejects an absent
 * one outright, and `wrapTransportForTaskResults` rewrites `resultType:
 * "task"` into a create-task envelope), so reading them through the real
 * client would assert the SDK's reaction, not what the server sent. Where the
 * SDK's reaction IS the interesting property, the test uses the real client.
 */
describe("tasks extension wire — misbehaving server", () => {
  it("can answer an undeclared tasks/get (negative case for the -32021 rule)", async () => {
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

  it("can turn a healthy task malformed mid-flight, and the real client refuses the poll", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    expect((await getTask(manager, taskId)).status).toBe("working");
    fixture.misbehave({ status: "in_progress", omitTaskFields: ["ttlMs"] });

    // A connection that was healthy a poll ago is not trusted afterwards: the
    // guard re-validates every `tasks/get` result.
    await expect(manager.getTaskExt(SERVER_ID, taskId)).rejects.toThrow(
      /not a valid io\.modelcontextprotocol\/tasks payload/
    );
    // …and the raw wire confirms what the server actually sent.
    const raw = await new RawTasksWire(fixture.url).get(taskId);
    expect(raw.status).toBe("in_progress");
    expect(raw).not.toHaveProperty("ttlMs");
  });

  it("can send resultType: task on a tasks/get result", async () => {
    const fixture = await serve({ misbehave: { getResultType: "task" } });
    const manager = await connect(fixture.url);
    const taskId = (await createTask(manager)).taskId as string;

    // RAW: `wrapTransportForTaskResults` rewrites any `resultType: "task"`
    // response before the client decodes it, so the wire value is only
    // observable off the socket.
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

    const raw = await new RawTasksWire(fixture.url).get(taskId);
    expect(raw.status).toBe("completed");
    // A `completed` task MUST carry `result` (tasks.md:330).
    expect(raw.result).toBeUndefined();
    // The real client refuses the variant-incomplete payload rather than
    // rendering a completed task with no result.
    await expect(manager.getTaskExt(SERVER_ID, taskId)).rejects.toThrow(
      /not a valid io\.modelcontextprotocol\/tasks payload/
    );
  });

  it("can fabricate a task for an id that was never issued", async () => {
    const fixture = await serve({ misbehave: { answerUnknownTaskId: true } });
    const task = await new RawTasksWire(fixture.url).get("never-issued");
    expect(task.taskId).toBe("never-issued");
  });
});

describe("tasks extension wire — resultType on tasks/* results", () => {
  it("carries resultType: complete by default (the prose MUST)", async () => {
    // RAW: the decoder strips `resultType` off a complete result, so the real
    // client can never observe it (the lifecycle test pins that absence).
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
    // RAW: beta.4's 2026 decoder REQUIRES `resultType` on every result
    // ("missing-resultType"), so this reading is only observable off the wire.
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

describe("tasks extension wire — declared subscriptions/listen (real client)", () => {
  it("puts the eligibility declaration on a task-filtered listen", async () => {
    const fixture = await serve();
    const manager = await connect(fixture.url);

    // The probe agrees with what the open below relies on: extension wire,
    // a listen-capable client, and the listen-meta seam behind it.
    expect(manager.supportsTaskDeclaredListen(SERVER_ID)).toBe(true);

    // The fixture is POST-only: it validates and acknowledges the listen
    // request but can never deliver notifications (nor the modern ack
    // notification), so the returned promise may not settle usefully.
    // What is pinned here is the WIRE: the request that reached the server
    // carried the declaration. The fixture answers -32021 to an UNDECLARED
    // task-filtered listen (asserted above), so the recorded params are the
    // exact complement of that case.
    const pending = manager
      .listenWithTasksDeclaration(SERVER_ID, { taskIds: ["ext-task-1"] })
      .catch(() => undefined);

    const deadline = Date.now() + 5_000;
    while (
      !fixture.received.some((r) => r.method === "subscriptions/listen") &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const listen = fixture.received.find(
      (r) => r.method === "subscriptions/listen"
    );
    expect(listen, "listen request reached the fixture").toBeDefined();
    expect(
      (listen!.params?.notifications as { taskIds?: string[] })?.taskIds
    ).toEqual(["ext-task-1"]);
    const declared = (
      listen!.params?._meta as Record<string, unknown> | undefined
    )?.["io.modelcontextprotocol/clientCapabilities"] as
      | { extensions?: Record<string, unknown> }
      | undefined;
    expect(declared?.extensions?.[TASKS_EXTENSION_ID]).toEqual({});

    // Bounded settle so a hanging listen cannot leak past the test body; the
    // afterEach disconnect tears the connection down either way.
    await Promise.race([
      pending,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
  });
});
