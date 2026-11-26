/**
 * Client rules for tasks, proven on what MCPJam actually sends.
 *
 * Two wires, two fixtures, one real client (MCPClientManager over HTTP):
 * - 2025-11-25 in-core tasks: `legacy-tasks-fixture.ts`.
 * - 2026-07-28 tasks extension (SEP-2663): `extension-tasks-fixture.ts`.
 *
 * The client is connected with a recording `baseFetch` (see `harness.ts`), so
 * every assertion reads the requests as they left: method, params, headers and
 * arrival time. Where the rule is about the Tasks suite (the code behind the
 * mapped `tasks-*` checks), the suite itself runs and the fixture's own record
 * of what it received is read.
 *
 * Each test checks exactly what its rule says. When a setup did not make the
 * client do the thing a rule is about, the test skips as "not exercised".
 */

import { afterEach, describe, expect } from "vitest";
import { MCPClientManager } from "../../src/mcp-client-manager/index.js";
import { MCPTasksConformanceTest } from "../../src/tasks-conformance/index.js";
import { TaskOperations } from "../../src/tasks-conformance/task-operations.js";
import { normalizeMCPTasksConformanceConfig } from "../../src/tasks-conformance/validation.js";
import {
  LEGACY_TASK_ID,
  LEGACY_TASK_TOOL_NAME,
  serveLegacyTasksFixture,
  type LegacyTasksFixtureOptions,
  type ServedLegacyTasksFixture,
} from "../support/legacy-tasks-fixture.js";
import {
  DEFAULT_INPUT_REQUEST_KEY,
  DEFAULT_INPUT_REQUESTS,
  EXTENSION_PROTOCOL_VERSION,
  TASK_TOOL_NAME,
  defaultTaskPhases,
  serveExtensionTasksFixture,
  taskTool,
  type ExtensionTasksFixtureOptions,
  type ServedExtensionTasksFixture,
} from "../support/extension-tasks-fixture.js";
import {
  exercised,
  mayRule,
  recordingFetch,
  rpcMethodOf,
  rpcOf,
  ruleTest,
  type WireRequest,
} from "./harness.js";

const SERVER_ID = "srv";
const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
const CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const ROUTED_METHODS = ["tasks/get", "tasks/update", "tasks/cancel"];

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

/** Whether a request's params declare the tasks extension in its per-request capabilities. */
function declaresTasksExtension(params: Record<string, unknown> | undefined): boolean {
  const meta = params?._meta as Record<string, unknown> | undefined;
  const capabilities = meta?.[CLIENT_CAPABILITIES] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return capabilities?.extensions?.[TASKS_EXTENSION] !== undefined;
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

async function runSuite(
  url: string,
  version: string,
  toolName: string,
  extra: Record<string, unknown> = {},
) {
  return new MCPTasksConformanceTest({
    url,
    mcpProtocolVersion: version,
    timeout: 10_000,
    toolName,
    pollTimeoutMs: 5_000,
    __suppressTelemetry: true,
    ...extra,
  } as never).run();
}

/** A server-side-recorded request carries a 2025-11-25 `task` field. */
function carriesTask(request: { params?: Record<string, unknown> }): boolean {
  return request.params?.task !== undefined;
}

// ---------------------------------------------------------------------------
// 2025-11-25 in-core tasks
// ---------------------------------------------------------------------------

describe("2025-11-25 tasks (legacy-tasks-fixture)", () => {
  ruleTest(
    "C077",
    "a server with no tasks capability gets no task-augmented request, from the client or the Tasks suite",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy({ tasksCapability: null });
      const manager = await connect(fixture.url, "2025-11-25", wire);
      await manager
        .executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {}, undefined, {})
        .catch(() => {});
      await runSuite(fixture.url, "2025-11-25", LEGACY_TASK_TOOL_NAME);
      expect(fixture.received.filter(carriesTask)).toEqual([]);
    },
    30_000,
  );

  ruleTest(
    "C078",
    "creating a task puts a task object in the tools/call params",
    async (ctx) => {
      const wire: WireRequest[] = [];
      const fixture = await legacy();
      const manager = await connect(fixture.url, "2025-11-25", wire);
      await manager.executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {}, undefined, {});
      const calls = sent(wire, "tools/call");
      exercised(ctx, calls.length > 0, "the client sent no tools/call");
      const task = paramsOf(calls[0]!).task;
      expect(task !== null && typeof task === "object" && !Array.isArray(task)).toBe(true);
    },
  );

  ruleTest(
    "C079",
    "against a server without tasks.requests.tools.call, no tools/call carries a task, from the client or the Tasks suite",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy({ tasksCapability: { cancel: {} } });
      const manager = await connect(fixture.url, "2025-11-25", wire);
      await manager
        .executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {}, undefined, {})
        .catch(() => {});
      await runSuite(fixture.url, "2025-11-25", LEGACY_TASK_TOOL_NAME);
      expect(
        fixture.received.filter(
          (request) => request.method === "tools/call" && carriesTask(request),
        ),
      ).toEqual([]);
    },
    30_000,
  );

  ruleTest(
    "C080",
    "a server that declared only tasks.list gets no task on any request",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy({ tasksCapability: { list: {} } });
      const manager = await connect(fixture.url, "2025-11-25", wire);
      await manager
        .executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {}, undefined, {})
        .catch(() => {});
      expect(wire.filter((request) => paramsOf(request).task !== undefined)).toEqual([]);
    },
  );

  mayRule(
    "C085",
    "MCPJam calls an optional tool as a task when the caller passes task options, otherwise as a plain call.",
  );

  ruleTest(
    "C086",
    "the Tasks suite calls a tool whose taskSupport is required only as a task",
    async (ctx) => {
      const fixture = await legacy({ pollInterval: 20 });
      await runSuite(fixture.url, "2025-11-25", LEGACY_TASK_TOOL_NAME);
      const calls = fixture.received.filter(
        (request) =>
          request.method === "tools/call" && request.params?.name === LEGACY_TASK_TOOL_NAME,
      );
      exercised(ctx, calls.length > 0, "the Tasks suite never called the required tool");
      expect(calls.filter((request) => !carriesTask(request))).toEqual([]);
    },
    30_000,
  );

  ruleTest.knownBreak(
    "C086",
    "a plain executeTool on a tool whose taskSupport is required goes out as a plain tools/call",
    "MCPClientManager.executeTool adds params.task only when the caller passes task options (src/mcp-client-manager/MCPClientManager.ts:1701) and never reads execution.taskSupport, so a required tool called without them is sent as an ordinary tools/call",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await legacy();
      const manager = await connect(fixture.url, "2025-11-25", wire);
      await manager.executeTool(SERVER_ID, LEGACY_TASK_TOOL_NAME, {});
      const calls = sent(wire, "tools/call");
      expect(calls).toHaveLength(1);
      expect(paramsOf(calls[0]!)).not.toHaveProperty("task");
    },
  );

  ruleTest(
    "C088",
    "after a CreateTaskResult the Tasks suite polls that task with tasks/get",
    async (ctx) => {
      const fixture = await legacy({
        pollInterval: 20,
        phases: [{ status: "working", polls: 1 }, { status: "completed" }],
      });
      await runSuite(fixture.url, "2025-11-25", LEGACY_TASK_TOOL_NAME);
      const created = fixture.received.findIndex(
        (request) => request.method === "tools/call" && carriesTask(request),
      );
      exercised(ctx, created >= 0, "the Tasks suite created no task");
      const polls = fixture.received
        .slice(created + 1)
        .filter((request) => request.method === "tasks/get");
      expect(polls.map((request) => request.params?.taskId)).toContain(LEGACY_TASK_ID);
    },
    30_000,
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
      return { wire, polled };
    }

    ruleTest(
      "C091",
      "the client waits at least the task's pollInterval between tasks/get",
      async (ctx) => {
        // Above the poll loop's own 250 ms fallback, so a loop that ignored
        // pollInterval would show shorter gaps.
        const { wire } = await createAndPoll({
          pollInterval: 400,
          phases: [{ status: "working", polls: 3 }, { status: "completed" }],
        });
        const intervals = gaps(sent(wire, "tasks/get"));
        exercised(ctx, intervals.length > 0, "the client polled fewer than twice");
        // setTimeout may fire a hair early; each wait is 400 ms.
        expect(intervals.filter((ms) => ms < 390)).toEqual([]);
      },
      15_000,
    );

    ruleTest(
      "C094",
      "the client keeps polling through working until the task reaches a terminal status",
      async () => {
        const { wire, polled } = await createAndPoll({
          pollInterval: 20,
          phases: [{ status: "working", polls: 3 }, { status: "completed" }],
        });
        expect(polled.task?.status).toBe("completed");
        // Three working reads, then the completed one.
        expect(sent(wire, "tasks/get").length).toBeGreaterThanOrEqual(4);
      },
    );
  });

  ruleTest(
    "C105",
    "cancelling a task sends tasks/cancel, never notifications/cancelled",
    async (ctx) => {
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
      exercised(ctx, sent(wire, "tasks/cancel").length > 0, "the client sent no tasks/cancel");
      expect(sent(wire, "notifications/cancelled")).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// 2026-07-28 tasks extension
// ---------------------------------------------------------------------------

describe("2026-07-28 tasks extension (extension-tasks-fixture)", () => {
  ruleTest(
    "C076",
    "against a server without the extension, no tasks/* request or task field goes out: the client falls back or refuses",
    async () => {
      const wire: WireRequest[] = [];
      const fixture = await extension({ advertiseTasksExtension: false });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      await manager
        .executeTool(SERVER_ID, TASK_TOOL_NAME, {}, { allowTaskResult: true })
        .catch(() => {});
      await manager.getTaskExt(SERVER_ID, "ext-task-1").catch(() => {});
      await manager
        .updateTask(SERVER_ID, "ext-task-1", {
          [DEFAULT_INPUT_REQUEST_KEY]: { action: "accept", content: { input: "Luca" } },
        } as never)
        .catch(() => {});
      await manager.cancelTaskExt(SERVER_ID, "ext-task-1").catch(() => {});
      await runSuite(fixture.url, EXTENSION_PROTOCOL_VERSION, TASK_TOOL_NAME);
      expect(fixture.received.filter((request) => request.method.startsWith("tasks/"))).toEqual(
        [],
      );
      expect(fixture.received.filter(carriesTask)).toEqual([]);
    },
    30_000,
  );

  ruleTest(
    "C081",
    "the Tasks suite never asks for a task on a request; it only declares support",
    async (ctx) => {
      const fixture = await extension();
      await runSuite(fixture.url, EXTENSION_PROTOCOL_VERSION, TASK_TOOL_NAME);
      exercised(
        ctx,
        fixture.received.some((request) => declaresTasksExtension(request.params)),
        "the Tasks suite never declared the extension",
      );
      expect(fixture.received.filter(carriesTask)).toEqual([]);
    },
    30_000,
  );

  ruleTest(
    "C082",
    "a call that opts into tasks declares the extension in its per-request capabilities",
    async (ctx) => {
      const wire: WireRequest[] = [];
      const fixture = await extension();
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      await manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {}, { allowTaskResult: true });
      const calls = sent(wire, "tools/call");
      exercised(ctx, calls.length > 0, "the client sent no tools/call");
      expect(declaresTasksExtension(paramsOf(calls[0]!))).toBe(true);
    },
  );

  ruleTest(
    "C087",
    "a declaring client handles both a CreateTaskResult and a plain CallToolResult",
    async (ctx) => {
      const wire: WireRequest[] = [];
      const fixture = await extension({
        tools: {
          [TASK_TOOL_NAME]: taskTool(defaultTaskPhases()),
          sync_tool: { mode: "sync", result: { content: [{ type: "text", text: "now" }] } },
        },
      });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      const asTask = manager.executeTool(SERVER_ID, TASK_TOOL_NAME, {}, { allowTaskResult: true });
      await expect(asTask).resolves.toBeDefined();
      exercised(ctx, fixture.tasks().length > 0, "the server created no task");
      const plain = manager.executeTool(SERVER_ID, "sync_tool", {}, { allowTaskResult: true });
      await expect(plain).resolves.toBeDefined();
    },
  );

  ruleTest(
    "C089",
    "a call that declares the extension accepts a plain result as the answer",
    async (ctx) => {
      const wire: WireRequest[] = [];
      // The tool answers synchronously even to a declaring caller.
      const fixture = await extension({
        tools: { sync_tool: { mode: "sync", result: { content: [{ type: "text", text: "now" }] } } },
      });
      const manager = await connect(fixture.url, EXTENSION_PROTOCOL_VERSION, wire);
      const result = (await manager.executeTool(SERVER_ID, "sync_tool", {}, {
        allowTaskResult: true,
      })) as Record<string, unknown>;
      const call = sent(wire, "tools/call")[0];
      exercised(
        ctx,
        call !== undefined && declaresTasksExtension(paramsOf(call)),
        "the call did not declare the extension",
      );
      expect(result.content).toEqual([{ type: "text", text: "now" }]);
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

    ruleTest("C092", "the client gets the task's result by polling tasks/get", async (ctx) => {
      const { wire, polled } = await createAndPoll(10, 1);
      exercised(ctx, sent(wire, "tasks/get").length > 0, "the client never polled");
      expect(polled.task?.status).toBe("completed");
      expect(polled.task?.result).toEqual(RESULT);
    });

    ruleTest(
      "C090",
      "the client waits at least the advertised pollIntervalMs between tasks/get",
      async (ctx) => {
        // Above the poll loop's own 250 ms fallback, so a loop that ignored
        // pollIntervalMs would show shorter gaps.
        const { wire } = await createAndPoll(400, 3);
        const intervals = gaps(sent(wire, "tasks/get"));
        exercised(ctx, intervals.length > 0, "the client polled fewer than twice");
        expect(intervals.filter((ms) => ms < 390)).toEqual([]);
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
        // Three working reads, then the completed one.
        expect(sent(wire, "tasks/get").length).toBeGreaterThanOrEqual(4);
      },
    );
  });

  describe("naming a task on tasks/get, tasks/update and tasks/cancel", () => {
    /** Create a task, then read, answer and cancel it through the client. */
    async function routedTaskFlow() {
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
      const routed = wire.filter((request) => ROUTED_METHODS.includes(rpcMethodOf(request) ?? ""));
      return { routed, fixture };
    }

    function exercisedAll(ctx: Parameters<typeof exercised>[0], routed: WireRequest[]) {
      for (const method of ROUTED_METHODS) {
        exercised(ctx, routed.some((request) => rpcMethodOf(request) === method), `no ${method} was sent`);
      }
    }

    ruleTest(
      "C051",
      "every tasks/get, tasks/update and tasks/cancel names its task with params.taskId",
      async (ctx) => {
        const { routed } = await routedTaskFlow();
        exercisedAll(ctx, routed);
        for (const request of routed) {
          const taskId = paramsOf(request).taskId;
          expect(typeof taskId === "string" && taskId.length > 0, rpcMethodOf(request)).toBe(true);
        }
      },
    );

    ruleTest(
      "C101",
      "tasks/get, tasks/update and tasks/cancel carry Mcp-Name equal to params.taskId",
      async (ctx) => {
        const { routed } = await routedTaskFlow();
        exercisedAll(ctx, routed);
        for (const request of routed) {
          expect(request.headers["mcp-name"], rpcMethodOf(request)).toBe(paramsOf(request).taskId);
        }
      },
    );

    ruleTest(
      "C104",
      "every later tasks/get, tasks/update and tasks/cancel uses the task id the server returned",
      async (ctx) => {
        const { routed, fixture } = await routedTaskFlow();
        exercisedAll(ctx, routed);
        const issued = fixture.tasks()[0]!.taskId;
        expect(routed.map((request) => paramsOf(request).taskId)).toEqual(routed.map(() => issued));
      },
    );
  });

  describe("answering a task's input requests", () => {
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
      "the client answers an input request with tasks/update carrying it in inputResponses",
      async (ctx) => {
        const { wire, manager, taskId, task, ops } = await parkedTask();
        exercised(ctx, task.status === "input_required", "the task never asked for input");
        await ops.runInputRequiredLeg(manager, SERVER_ID, taskId, task, [], new Set());
        const updates = sent(wire, "tasks/update");
        exercised(ctx, updates.length > 0, "the client sent no tasks/update");
        expect(
          updates.some(
            (update) =>
              (paramsOf(update).inputResponses as Record<string, unknown> | undefined)?.[
                DEFAULT_INPUT_REQUEST_KEY
              ] !== undefined,
          ),
        ).toBe(true);
      },
    );

    ruleTest(
      "C097",
      "every key in inputResponses names a request the task has open",
      async (ctx) => {
        const { wire, manager, taskId, task, ops } = await parkedTask();
        exercised(ctx, task.status === "input_required", "the task never asked for input");
        await ops.runInputRequiredLeg(manager, SERVER_ID, taskId, task, [], new Set());
        const updates = sent(wire, "tasks/update");
        exercised(ctx, updates.length > 0, "the client sent no tasks/update");
        const open = Object.keys(task.inputRequests as object);
        for (const update of updates) {
          for (const key of Object.keys(paramsOf(update).inputResponses as object)) {
            expect(open).toContain(key);
          }
        }
      },
    );

    ruleTest(
      "C098",
      "the Tasks suite does not answer an input request again when the task still shows it after the update",
      async (ctx) => {
        // The input_required snapshot stays visible for four polls, so after
        // the client answers, the same key keeps coming back (tasks/update is
        // eventually consistent).
        const fixture = await extension({
          tools: {
            [TASK_TOOL_NAME]: taskTool([
              { status: "working", pollIntervalMs: 10 },
              {
                status: "input_required",
                inputRequests: DEFAULT_INPUT_REQUESTS,
                polls: 4,
                awaitInputKeys: [DEFAULT_INPUT_REQUEST_KEY],
                pollIntervalMs: 10,
              },
              { status: "completed", result: { content: [{ type: "text", text: "done" }] } },
            ]),
          },
        });
        await runSuite(fixture.url, EXTENSION_PROTOCOL_VERSION, TASK_TOOL_NAME, {
          checkIds: ["tasks-update-ack-shape"],
          inputResponses: {
            [DEFAULT_INPUT_REQUEST_KEY]: { action: "accept", content: { input: "Luca" } },
          },
        });
        const firstUpdate = fixture.received.findIndex((request) => request.method === "tasks/update");
        exercised(ctx, firstUpdate >= 0, "the Tasks suite sent no tasks/update");
        exercised(
          ctx,
          fixture.received.slice(firstUpdate + 1).some((request) => request.method === "tasks/get"),
          "the Tasks suite never polled again after its update",
        );
        const answers = fixture.received
          .filter((request) => request.method === "tasks/update")
          .flatMap((request) => Object.keys((request.params?.inputResponses as object) ?? {}));
        expect(answers.filter((key) => key === DEFAULT_INPUT_REQUEST_KEY)).toHaveLength(1);
      },
      30_000,
    );
  });

  ruleTest(
    "C105",
    "cancelling a task sends tasks/cancel, never notifications/cancelled",
    async (ctx) => {
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
      exercised(ctx, sent(wire, "tasks/cancel").length > 0, "the client sent no tasks/cancel");
      expect(sent(wire, "notifications/cancelled")).toEqual([]);
    },
  );

  mayRule(
    "C106",
    "MCPJam keeps polling after tasks/cancel to see how the task ends; it never drops the task's state early.",
  );
});
