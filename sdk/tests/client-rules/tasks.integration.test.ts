/**
 * Client rules for tasks, proven on what MCPJam actually sends.
 *
 * Two wires, two fixtures, one real client (MCPClientManager over HTTP):
 * - 2025-11-25 in-core tasks: `legacy-tasks-fixture.ts`.
 * - 2026-07-28 tasks extension (SEP-2663): `extension-tasks-fixture.ts`.
 *
 * The client is connected with a recording `baseFetch` (see `harness.ts`), so
 * every assertion reads the requests as they left: method, params, headers and
 * arrival time. Polling is driven through the Tasks suite's own poll loop
 * (`TaskOperations.pollToTerminal`) and update step (`runInputRequiredLeg`),
 * which is what the mapped `tasks-*` checks run.
 *
 * Rules an existing test already proves exactly point at it with `coveredBy`.
 */

import { afterEach, describe, expect } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import { TaskOperations } from "../../src/tasks-conformance/task-operations.js";
import { normalizeMCPTasksConformanceConfig } from "../../src/tasks-conformance/validation.js";
import {
  LEGACY_TASK_TOOL_NAME,
  serveLegacyTasksFixture,
  type LegacyTasksFixtureOptions,
  type ServedLegacyTasksFixture,
} from "../support/legacy-tasks-fixture.js";
import {
  DEFAULT_INPUT_REQUEST_KEY,
  EXTENSION_PROTOCOL_VERSION,
  TASK_TOOL_NAME,
  defaultTaskPhases,
  serveExtensionTasksFixture,
  taskTool,
  type ExtensionTasksFixtureOptions,
  type ServedExtensionTasksFixture,
} from "../support/extension-tasks-fixture.js";
import {
  coveredBy,
  noBehavior,
  recordingFetch,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  type WireRequest,
} from "./harness.js";

const SERVER_ID = "srv";

const opened: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()!().catch(() => {});
});

async function legacy(options: LegacyTasksFixtureOptions = {}) {
  const fixture = await serveLegacyTasksFixture(options);
  opened.push(fixture.close);
  return fixture;
}

async function extension(options: ExtensionTasksFixtureOptions = {}) {
  const fixture = await serveExtensionTasksFixture(options);
  opened.push(fixture.close);
  return fixture;
}

/** A real client whose every request is recorded in `wire`. */
async function connect(
  url: string,
  version: string,
  wire: WireRequest[],
): Promise<MCPClientManager> {
  const manager = new MCPClientManager();
  opened.push(() => manager.disconnectAllServers());
  await manager.connectToServer(SERVER_ID, {
    url,
    mcpProtocolVersion: version,
    timeout: 10_000,
    baseFetch: recordingFetch((request) => fetch(request), wire, () => "client"),
  });
  return manager;
}

function sent(wire: WireRequest[], method: string): WireRequest[] {
  return wire.filter((request) => rpcMethodOf(request) === method);
}

function paramsOf(request: WireRequest): Record<string, unknown> {
  return rpcOf(request)?.params ?? {};
}

/** Gaps between consecutive requests, in ms. */
function gaps(requests: WireRequest[]): number[] {
  return requests.slice(1).map((request, index) => request.startedAt - requests[index]!.startedAt);
}

function operations(url: string, extra: Record<string, unknown> = {}) {
  return new TaskOperations(
    normalizeMCPTasksConformanceConfig({
      url,
      pollTimeoutMs: 10_000,
      ...extra,
    } as never),
  );
}

async function runSuite(url: string, version: string, toolName: string) {
  return new MCPTasksConformanceTest({
    url,
    mcpProtocolVersion: version,
    timeout: 10_000,
    toolName,
    pollTimeoutMs: 5_000,
    __suppressTelemetry: true,
  } as never).run();
}

const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";

// ---------------------------------------------------------------------------
// 2025-11-25 in-core tasks
// ---------------------------------------------------------------------------

describe("2025-11-25 tasks (legacy-tasks-fixture)", () => {
  coveredBy(
    "C077",
    "tests/tasks-client-rules.integration.test.ts",
    "2025-11-25 server that declares no tasks: neither form is sent",
  );

  coveredBy(
    "C078",
    "tests/legacy-tasks-wire.integration.test.ts",
    "delivers params.task through the beta.4 client and creates the task",
  );

  coveredBy(
    "C079",
    "tests/legacy-tasks-wire.integration.test.ts",
    "refuses to call a tool as a task and sends nothing",
  );

  ruleTest(
    "C079",
    "the Tasks suite sends no task-augmented tools/call to a server that declared only tasks.cancel",
    async () => {
      const fixture = await legacy({ tasksCapability: { cancel: {} } });
      await runSuite(fixture.url, "2025-11-25", LEGACY_TASK_TOOL_NAME);
      expect(fixture.received.length).toBeGreaterThan(0);
      expect(
        fixture.received.filter(
          (request) => request.method === "tools/call" && request.params?.task !== undefined,
        ),
      ).toEqual([]);
    },
    30_000,
  );

  ruleTest(
    "C080",
    "a server that declared only tasks.list gets no task on any request, and the call is refused before it is sent",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy({ tasksCapability: { list: {} } });
      const manager = await connect(fixture.url, "2025-11-25", wire);
      expect(manager.supportsTasksForToolCalls(SERVER_ID)).toBe(false);
      await expect(
        manager.executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {}, undefined, {}),
      ).rejects.toThrow(/tasks\.requests\.tools\.call/);
      expect(wire.filter((request) => paramsOf(request).task !== undefined)).toEqual([]);
      expect(sent(wire, "tools/call")).toEqual([]);
    },
  );

  ruleTest(
    "C085",
    "a tool with taskSupport optional can be called either as a task or normally",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy({ toolTaskSupport: "optional" });
      const manager = await connect(fixture.url, "2025-11-25", wire);

      const asTask = (await manager.executeTool(
        SERVER_ID,
        LEGACY_TASK_TOOL_NAME,
        {},
        undefined,
        {},
      )) as { task?: { taskId?: string } };
      const plain = (await manager.executeTool(
        SERVER_ID,
        LEGACY_TASK_TOOL_NAME,
        {},
      )) as { content?: unknown[] };

      const calls = sent(wire, "tools/call");
      expect(calls).toHaveLength(2);
      expect(paramsOf(calls[0]!).task).toEqual({});
      expect(paramsOf(calls[1]!)).not.toHaveProperty("task");
      expect(asTask.task?.taskId).toBeDefined();
      expect(plain.content).toEqual([{ type: "text", text: "plain call" }]);
    },
  );

  ruleTest(
    "C086",
    "the Tasks suite calls a tool whose taskSupport is required only as a task",
    async () => {
      const fixture = await legacy({ pollInterval: 20 });
      await runSuite(fixture.url, "2025-11-25", LEGACY_TASK_TOOL_NAME);
      const calls = fixture.received.filter(
        (request) =>
          request.method === "tools/call" && request.params?.name === LEGACY_TASK_TOOL_NAME,
      );
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((request) => request.params?.task === undefined)).toEqual([]);
    },
    30_000,
  );

  ruleTest.fails(
    "C086",
    "a plain executeTool on a tool whose taskSupport is required still goes out as a task",
    "MCPClientManager.executeTool (src/mcp-client-manager/MCPClientManager.ts:1701) adds params.task only when the caller passes task options, and never reads execution.taskSupport on a plain call, so the required tool is sent as an ordinary tools/call",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy();
      const manager = await connect(fixture.url, "2025-11-25", wire);
      await manager.executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {}).catch(() => {});
      const calls = sent(wire, "tools/call");
      // Either refused before the wire, or sent as a task: never a plain call.
      expect(calls.filter((request) => paramsOf(request).task === undefined)).toEqual([]);
    },
  );

  describe("polling a created task", () => {
    async function createAndPoll(fixtureOptions: LegacyTasksFixtureOptions) {
      const wire: WireRequest[] = [];
      const fixture: ServedLegacyTasksFixture = await legacy(fixtureOptions);
      const manager = await connect(fixture.url, "2025-11-25", wire);
      const created = (await manager.executeTool(
        SERVER_ID,
        LEGACY_TASK_TOOL_NAME,
        {},
        undefined,
        {},
      )) as { task: { taskId: string } };
      const polled = await operations(fixture.url).pollToTerminal(
        manager,
        SERVER_ID,
        "legacy",
        created.task.taskId,
      );
      return { wire, taskId: created.task.taskId, polled };
    }

    ruleTest("C088", "after a CreateTaskResult the client polls the task with tasks/get", async () => {
      const { wire, taskId } = await createAndPoll({
        pollInterval: 20,
        phases: [{ status: "working", polls: 1 }, { status: "completed" }],
      });
      const call = sent(wire, "tools/call")[0]!;
      const gets = sent(wire, "tasks/get");
      expect(gets.length).toBeGreaterThan(0);
      expect(gets[0]!.startedAt).toBeGreaterThan(call.startedAt);
      expect(gets.map((request) => paramsOf(request).taskId)).toEqual(gets.map(() => taskId));
    });

    ruleTest(
      "C091",
      "the client waits at least the task's pollInterval between tasks/get",
      async () => {
        const { wire } = await createAndPoll({
          pollInterval: 200,
          phases: [{ status: "working", polls: 3 }, { status: "completed" }],
        });
        const intervals = gaps(sent(wire, "tasks/get"));
        expect(intervals.length).toBeGreaterThanOrEqual(3);
        // setTimeout may fire a hair early; the waits are 200 ms each.
        expect(intervals.filter((ms) => ms < 190)).toEqual([]);
      },
      15_000,
    );

    ruleTest(
      "C094",
      "the client keeps polling through working until the task reaches a terminal status, then stops",
      async () => {
        const { wire, polled } = await createAndPoll({
          pollInterval: 20,
          phases: [{ status: "working", polls: 3 }, { status: "completed" }],
        });
        expect(polled.task?.status).toBe("completed");
        // Three working reads, then the completed one, then nothing more.
        expect(sent(wire, "tasks/get")).toHaveLength(4);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// 2026-07-28 tasks extension
// ---------------------------------------------------------------------------

describe("2026-07-28 tasks extension (extension-tasks-fixture)", () => {
  coveredBy(
    "C076",
    "tests/tasks-client-rules.integration.test.ts",
    "2026-07-28 server that does not declare the extension: neither form is sent",
  );

  coveredBy(
    "C081",
    "tests/tasks-client-rules.integration.test.ts",
    "2026-07-28 extension wire: the extension declaration, never params.task",
  );

  coveredBy(
    "C082",
    "tests/extension-tasks-wire.integration.test.ts",
    "declares the extension in the tools/call _meta, and only when eligible",
  );

  coveredBy(
    "C087",
    "tests/extension-tasks-wire.integration.test.ts",
    "creates a task and surfaces the flat CreateTaskResult",
  );

  coveredBy(
    "C087",
    "tests/extension-tasks-wire.integration.test.ts",
    "returns a plain result when the server declines to make a task",
  );

  ruleTest(
    "C089",
    "a call that declares the extension still accepts a plain result, and sends no task request",
    async () => {
      const wire: WireRequest[] = [];
      // The tool runs synchronously even for a declaring caller.
      const fixture = await extension({
        tools: { sync_tool: { mode: "sync", result: { content: [{ type: "text", text: "now" }] } } },
      });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      const result = (await manager.executeTool(SERVER_ID, "sync_tool", {}, {
        allowTaskResult: true,
      })) as Record<string, unknown>;

      const call = sent(wire, "tools/call")[0]!;
      const declared = (paramsOf(call)._meta as Record<string, unknown>)[CLIENT_CAPABILITIES] as {
        extensions?: Record<string, unknown>;
      };
      expect(declared.extensions).toHaveProperty("io.modelcontextprotocol/tasks");
      expect(paramsOf(call)).not.toHaveProperty("task");
      expect(result.content).toEqual([{ type: "text", text: "now" }]);
      expect(wire.filter((request) => rpcMethodOf(request)?.startsWith("tasks/"))).toEqual([]);
    },
  );

  describe("polling a created task", () => {
    const RESULT = { content: [{ type: "text", text: "done" }], isError: false };

    async function createAndPoll(pollIntervalMs: number, workingPolls: number) {
      const wire: WireRequest[] = [];
      const fixture: ServedExtensionTasksFixture = await extension({
        tools: {
          [TASK_TOOL_NAME]: taskTool([
            { status: "working", pollIntervalMs, polls: workingPolls },
            { status: "completed", result: RESULT },
          ]),
        },
      });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      const created = (await manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {}, {
        allowTaskResult: true,
      })) as { taskId: string };
      const polled = await operations(fixture.url).pollToTerminal(
        manager,
        SERVER_ID,
        "extension",
        created.taskId,
      );
      return { wire, fixture, taskId: created.taskId, polled };
    }

    ruleTest("C092", "the client gets the task's result by polling tasks/get", async () => {
      const { wire, polled } = await createAndPoll(10, 1);
      expect(polled.task?.status).toBe("completed");
      expect(polled.task?.result).toEqual(RESULT);
      expect(sent(wire, "tasks/get").length).toBeGreaterThan(0);
      // The extension has no tasks/result: the result rode a tasks/get.
      expect(sent(wire, "tasks/result")).toEqual([]);
    });

    ruleTest(
      "C090",
      "the client waits at least the advertised pollIntervalMs between tasks/get",
      async () => {
        const { wire } = await createAndPoll(200, 3);
        const intervals = gaps(sent(wire, "tasks/get"));
        expect(intervals.length).toBeGreaterThanOrEqual(3);
        expect(intervals.filter((ms) => ms < 190)).toEqual([]);
      },
      15_000,
    );

    ruleTest(
      "C093",
      "the client keeps polling until the task reaches a terminal status",
      async () => {
        const { wire, fixture, taskId, polled } = await createAndPoll(10, 3);
        expect(polled.task?.status).toBe("completed");
        expect(fixture.task(taskId)?.phaseIndex).toBe(1);
        expect(sent(wire, "tasks/get")).toHaveLength(4);
      },
    );

    ruleTest(
      "C101",
      "tasks/get, tasks/update and tasks/cancel carry Mcp-Name equal to params.taskId",
      async () => {
        const wire: WireRequest[] = [];
        const fixture = await extension();
        const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
        const { taskId } = (await manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {}, {
          allowTaskResult: true,
        })) as { taskId: string };
        await manager.getTaskExt(SERVER_ID, taskId);
        await manager.updateTask(SERVER_ID, taskId, {
          [DEFAULT_INPUT_REQUEST_KEY]: { action: "accept", content: { input: "Luca" } },
        } as never);
        await manager.cancelTaskExt(SERVER_ID, taskId);

        const routed = wire.filter((request) =>
          ["tasks/get", "tasks/update", "tasks/cancel"].includes(rpcMethodOf(request) ?? ""),
        );
        expect(routed.map(rpcMethodOf)).toEqual(["tasks/get", "tasks/update", "tasks/cancel"]);
        for (const request of routed) {
          expect(request.headers["mcp-name"], rpcMethodOf(request)).toBe(paramsOf(request).taskId);
        }
      },
    );

    ruleTest(
      "C104",
      "every later tasks/* call uses the task id the CreateTaskResult returned",
      async () => {
        const { wire, taskId } = await createAndPoll(10, 2);
        const later = wire.filter((request) => rpcMethodOf(request)?.startsWith("tasks/"));
        expect(later.length).toBeGreaterThan(0);
        expect(later.map((request) => paramsOf(request).taskId)).toEqual(later.map(() => taskId));
      },
    );
  });

  describe("answering a task's input requests (the suite's update step)", () => {
    async function parkedTask() {
      const wire: WireRequest[] = [];
      const fixture = await extension({
        tools: {
          [TASK_TOOL_NAME]: taskTool(defaultTaskPhases().slice(1)),
        },
      });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      const { taskId } = (await manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {}, {
        allowTaskResult: true,
      })) as { taskId: string };
      const task = (await manager.getTaskExt(SERVER_ID, taskId)) as unknown as Record<
        string,
        unknown
      >;
      expect(task.status).toBe("input_required");
      const ops = operations(fixture.url, {
        inputResponses: {
          [DEFAULT_INPUT_REQUEST_KEY]: { action: "accept", content: { input: "Luca" } },
          // Configured, but never asked for by this task.
          not_asked: { action: "accept", content: {} },
        },
      });
      return { wire, manager, taskId, task, ops };
    }

    ruleTest(
      "C096",
      "the client answers an input request with tasks/update carrying inputResponses",
      async () => {
        const { wire, manager, taskId, task, ops } = await parkedTask();
        await ops.runInputRequiredLeg(manager, SERVER_ID, taskId, task, [], new Set());
        const updates = sent(wire, "tasks/update");
        expect(updates).toHaveLength(1);
        expect(paramsOf(updates[0]!).taskId).toBe(taskId);
        expect(Object.keys(paramsOf(updates[0]!).inputResponses as object)).toEqual([
          DEFAULT_INPUT_REQUEST_KEY,
        ]);
      },
    );

    ruleTest(
      "C097",
      "every key in inputResponses names a request the task has open",
      async () => {
        const { wire, manager, taskId, task, ops } = await parkedTask();
        await ops.runInputRequiredLeg(manager, SERVER_ID, taskId, task, [], new Set());
        const open = Object.keys(task.inputRequests as object);
        for (const update of sent(wire, "tasks/update")) {
          for (const key of Object.keys(paramsOf(update).inputResponses as object)) {
            expect(open).toContain(key);
          }
        }
      },
    );

    ruleTest(
      "C098",
      "a key already answered is not answered again",
      async () => {
        const { wire, manager, taskId, task, ops } = await parkedTask();
        const answered = new Set<string>();
        const first = await ops.runInputRequiredLeg(manager, SERVER_ID, taskId, task, [], answered);
        for (const key of (first as { answered?: string[] }).answered ?? [DEFAULT_INPUT_REQUEST_KEY]) {
          answered.add(key);
        }
        // The same snapshot comes back (tasks/update is eventually consistent).
        await ops.runInputRequiredLeg(manager, SERVER_ID, taskId, task, [], answered);
        expect(sent(wire, "tasks/update")).toHaveLength(1);
      },
    );
  });

  ruleTest(
    "C105",
    "cancelling a task sends tasks/cancel and never notifications/cancelled",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await extension({
        tools: {
          [TASK_TOOL_NAME]: taskTool([
            { status: "working", awaitCancel: true },
            { status: "cancelled" },
          ]),
        },
      });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      const { taskId } = (await manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {}, {
        allowTaskResult: true,
      })) as { taskId: string };
      await manager.cancelTaskExt(SERVER_ID, taskId);
      expect(sent(wire, "tasks/cancel")).toHaveLength(1);
      expect(sent(wire, "notifications/cancelled")).toEqual([]);
    },
  );

  ruleTest(
    "C105",
    "on 2025-11-25 too, cancelling a task sends tasks/cancel and never notifications/cancelled",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy();
      const manager = await connect(fixture.url, "2025-11-25", wire);
      const created = (await manager.executeTool(
        SERVER_ID,
        LEGACY_TASK_TOOL_NAME,
        {},
        undefined,
        {},
      )) as { task: { taskId: string } };
      await manager.cancelTask(SERVER_ID, created.task.taskId);
      expect(sent(wire, "tasks/cancel")).toHaveLength(1);
      expect(sent(wire, "notifications/cancelled")).toEqual([]);
    },
  );

  noBehavior(
    "C106",
    "MCPJam never drops a task's state after tasks/cancel; it keeps polling to see the outcome (tests/task-lifecycle.test.ts › keeps polling after a cancel is requested), which the MAY also allows",
  );
});
