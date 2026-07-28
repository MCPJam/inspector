/**
 * A raw 2025-11-25 in-core tasks fixture server.
 *
 * `@modelcontextprotocol/server` beta.4 does not implement the 2025-11-25
 * in-core tasks utility, so this fixture answers JSON-RPC by hand: it
 * negotiates `2025-11-25`, advertises `capabilities.tasks`, exposes one tool
 * with `execution.taskSupport: "required"`, and answers a task-augmented
 * `tools/call` with a `CreateTaskResult` plus `tasks/get|result`.
 *
 * Its purpose is to prove, against the REAL beta.4 client, that the unknown
 * `params.task` key survives the client's request pipeline onto the wire (the
 * regression that broke task creation in the first place).
 *
 * Everything beyond that is opt-in through {@link LegacyTasksFixtureOptions}:
 * calling `serveLegacyTasksFixture()` with no arguments behaves exactly as it
 * always has (a task that is already `completed` on the first `tasks/get`), so
 * a consumer that only needs the original guarantee is unaffected by the
 * lifecycle knobs the CLI's watch tests need.
 *
 * Not modelled: a task reaching `input_required`. On this wire that surfaces as
 * an out-of-band `elicitation/create` **server-to-client request**, which needs
 * a streaming POST response this fixture does not implement.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

export const LEGACY_TASK_TOOL_NAME = "long_running";
export const LEGACY_TASK_ID = "legacy-task-1";

/** `-32602`. The code a 2025-11-25 server returns for a task it does not know. */
export const LEGACY_UNKNOWN_TASK_CODE = -32602;

export interface LegacyTaskPhase {
  status: "working" | "completed" | "failed" | "cancelled";
  /** How many `tasks/get` reads this phase answers before advancing. */
  polls?: number;
  /** Attached to `tasks/result` once the task has completed. */
  result?: Record<string, unknown>;
}

export interface LegacyTasksFixtureOptions {
  /**
   * Status ladder walked one step per `tasks/get`. Omit for the historical
   * behaviour: permanently `completed`, never `working`.
   */
  phases?: LegacyTaskPhase[];
  /** Milliseconds advertised as the task's `pollInterval`. Default 500. */
  pollInterval?: number;
  /**
   * Answer `-32602` for a `taskId` this fixture never issued. Off by default so
   * the original single-task tests keep working without registering an id.
   */
  rejectUnknownTaskIds?: boolean;
  /** Report created tasks from `tasks/list`. Default false (always empty). */
  trackForList?: boolean;
  /**
   * The `capabilities.tasks` object advertised on `initialize`.
   *
   * Default declares all three sub-capabilities. Narrowing it is how a test
   * reaches the legacy wire WITHOUT a given operation — a server that declares
   * only `cancel` still resolves to `wire: "legacy"`, which is exactly the case
   * where a client must not assume `tasks/list` or task-augmented `tools/call`
   * are available.
   */
  tasksCapability?: Record<string, unknown>;
  /**
   * Answer a task-augmented `tools/call` with a `CreateTaskResult` that carries
   * `taskId` but no `status`.
   *
   * That payload is nonconforming, yet it passes the SDK's `isCreateTaskResult`
   * guard, which checks only the id — so it is the shape a client has to reject
   * on its own or silently mis-handle.
   */
  createTaskWithoutStatus?: boolean;
  /**
   * Answer a task-augmented `tools/call` with a `CreateTaskResult` whose
   * `status` is present and truthy but outside the 2025-11-25 enum.
   *
   * The nastier sibling of {@link createTaskWithoutStatus}: a presence check
   * accepts it, and an unrecognized status normalizes to `working` downstream,
   * so a watch polls a task the server never advances instead of reporting the
   * malformed creation.
   */
  createTaskStatus?: string;
  /**
   * Extra properties to merge into the `tasks/list` result.
   *
   * The list schema is permissive, so a server can return keys a client never
   * asked for — including ones that collide with fields the CLI adds to its own
   * envelope. That collision is the point: a nonconforming server must not be
   * able to overwrite what the client resolved for itself.
   */
  listResultExtras?: Record<string, unknown>;
}

export interface ReceivedRequest {
  method: string;
  params: Record<string, unknown> | undefined;
}

export interface ServedLegacyTasksFixture {
  url: string;
  received: ReceivedRequest[];
  close: () => Promise<void>;
}

class JsonRpcFailure extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const DEFAULT_RESULT = { content: [{ type: "text", text: "task done" }] };

interface TaskState {
  created: boolean;
  phaseIndex: number;
  pollsOnPhase: number;
  cancelled: boolean;
}

const DEFAULT_TASKS_CAPABILITY: Record<string, unknown> = {
  list: {},
  cancel: {},
  requests: { tools: { call: {} } },
};

function initialize(
  tasksCapability: Record<string, unknown> = DEFAULT_TASKS_CAPABILITY
): Record<string, unknown> {
  return {
    protocolVersion: "2025-11-25",
    capabilities: {
      tools: { listChanged: false },
      tasks: tasksCapability,
    },
    serverInfo: { name: "legacy-tasks-fixture", version: "1.0.0" },
  };
}

function toolsList(): Record<string, unknown> {
  return {
    tools: [
      {
        name: LEGACY_TASK_TOOL_NAME,
        description: "A tool that only runs as a task.",
        inputSchema: { type: "object", properties: {} },
        execution: { taskSupport: "required" },
      },
    ],
  };
}

export async function serveLegacyTasksFixture(
  options: LegacyTasksFixtureOptions = {}
): Promise<ServedLegacyTasksFixture> {
  const received: ReceivedRequest[] = [];
  const pollInterval = options.pollInterval ?? 500;
  const phases = options.phases;
  const state: TaskState = {
    created: false,
    phaseIndex: 0,
    pollsOnPhase: 0,
    cancelled: false,
  };

  const currentPhase = (): LegacyTaskPhase =>
    // `phases` is non-empty when set, and the index is clamped, so the lookup
    // always hits — `?? ` keeps that provable without a non-null assertion.
    (phases?.[Math.min(state.phaseIndex, phases.length - 1)] ?? {
      status: "completed",
    }) as LegacyTaskPhase;

  /** Check-then-render, so a phase's own status is observable at least once. */
  const advanceIfDue = (): void => {
    if (!phases) return;
    const phase = currentPhase();
    if (
      state.pollsOnPhase >= (phase.polls ?? 1) &&
      state.phaseIndex < phases.length - 1
    ) {
      state.phaseIndex += 1;
      state.pollsOnPhase = 0;
    }
  };

  const requireKnownTask = (
    params: Record<string, unknown> | undefined
  ): void => {
    if (!options.rejectUnknownTaskIds) return;
    const taskId = params?.taskId;
    if (taskId !== LEGACY_TASK_ID || !state.created) {
      throw new JsonRpcFailure(
        LEGACY_UNKNOWN_TASK_CODE,
        `Failed to retrieve task: Task not found (${String(taskId)})`
      );
    }
  };

  const taskFields = (status: string): Record<string, unknown> => ({
    taskId: LEGACY_TASK_ID,
    status,
    createdAt: "2026-07-27T00:00:00Z",
    ttl: 60_000,
    pollInterval,
  });

  const resultFor = (
    method: string,
    params: Record<string, unknown> | undefined
  ): Record<string, unknown> => {
    switch (method) {
      case "initialize":
        return initialize(options.tasksCapability);
      case "tools/list":
        return toolsList();
      case "tools/call":
        // The whole point of the fixture: only answer with a CreateTaskResult
        // when the client actually delivered `params.task`.
        if (params && typeof params.task === "object" && params.task !== null) {
          state.created = true;
          state.phaseIndex = 0;
          state.pollsOnPhase = 0;
          state.cancelled = false;
          const task: Record<string, unknown> = {
            ...taskFields(phases ? currentPhase().status : "working"),
            ttl: (params.task as { ttl?: number }).ttl ?? 60_000,
          };
          if (options.createTaskWithoutStatus) delete task.status;
          else if (options.createTaskStatus !== undefined) {
            task.status = options.createTaskStatus;
          }
          return { task };
        }
        return { content: [{ type: "text", text: "plain call" }] };
      case "tasks/get": {
        requireKnownTask(params);
        if (state.cancelled) return taskFields("cancelled");
        advanceIfDue();
        state.pollsOnPhase += 1;
        return taskFields(currentPhase().status);
      }
      case "tasks/result":
        requireKnownTask(params);
        return currentPhase().result ?? DEFAULT_RESULT;
      case "tasks/cancel":
        requireKnownTask(params);
        state.cancelled = true;
        return taskFields("cancelled");
      case "tasks/list":
        return {
          ...(options.listResultExtras ?? {}),
          tasks:
            options.trackForList && state.created
              ? [
                  taskFields(
                    state.cancelled ? "cancelled" : currentPhase().status
                  ),
                ]
              : [],
        };
      default:
        return {};
    }
  };

  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST") {
        res.writeHead(405).end();
        return;
      }
      let message: {
        id?: unknown;
        method?: string;
        params?: Record<string, unknown>;
      };
      try {
        message = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (typeof message.method === "string") {
        received.push({ method: message.method, params: message.params });
      }
      if (message.id === undefined) {
        // A notification (e.g. notifications/initialized).
        res.writeHead(202).end();
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = {
          jsonrpc: "2.0",
          id: message.id,
          result: resultFor(message.method as string, message.params),
        };
      } catch (error) {
        payload = {
          jsonrpc: "2.0",
          id: message.id,
          error:
            error instanceof JsonRpcFailure
              ? { code: error.code, message: error.message }
              : { code: -32603, message: String(error) },
        };
      }

      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
      });
      res.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", resolve)
  );
  const address = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    received,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}
