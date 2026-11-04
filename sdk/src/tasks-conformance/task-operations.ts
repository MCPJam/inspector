import { setTimeout as delay } from "node:timers/promises";
import { readRequiredCapabilities } from "./metadata.js";
import type { MCPClientManager } from "../mcp-client-manager/MCPClientManager.js";

import type { TasksWire } from "../mcp-client-manager/tasks-dispatch.js";

import { ensureTasksExtensionEraGateShadow } from "../mcp-client-manager/tasks-ext-era-gate.js";

import { type NormalizedMCPTasksConformanceConfig } from "./types.js";

import {
  isRecord,
  errorMessage,
  isMalformedResponseError,
  errorCode,
} from "./metadata.js";
import { ShapeVerdict, validateCompletionAck } from "./shapes.js";
import {
  TERMINAL_STATUSES,
  PARKED_INPUT_REQUIRED_POLLS,
  INVALID_PARAMS,
  LISTEN_PROBE_TIMEOUT_MS,
  UndeclaredProbe,
  findRawResult,
  findRawTaskResponse,
  extractUndeclaredCreationTaskId,
  RawRequest,
  RAW_PROBE_RESULT_SCHEMA,
  runUndeclaredProbe,
  InputRequiredLeg,
} from "./evidence.js";
export class TaskOperations {
  constructor(readonly config: NormalizedMCPTasksConformanceConfig) {}
  extractTaskId(wire: TasksWire, result: unknown): string | undefined {
    if (!isRecord(result)) return undefined;
    if (wire === "extension") {
      return typeof result.taskId === "string" ? result.taskId : undefined;
    }
    const task = isRecord(result.task) ? result.task : undefined;
    return typeof task?.taskId === "string" ? task.taskId : undefined;
  }

  /**
   * Runs a `tools/call` WITHOUT the extension declaration (`allowTaskResult`
   * omitted, so the manager sends no capability envelope) and reports what the
   * server did.
   *
   * The outcome is deliberately four-valued rather than a boolean. A boolean
   * `taskCreated: false` collapses "the server honoured tasks.md:61" with "the
   * probe blew up before it proved anything", and the check counted BOTH as a
   * pass. Only an actual server response can pass here:
   *
   *   - `created`  — a `CreateTaskResult` came back: the violation.
   *   - `answered` — a normal tool result: conformant.
   *   - `refused`  — a JSON-RPC error response. Conformant only with `-32021`
   *     whose `requiredCapabilities` names the tasks extension, the refusal
   *     tasks.md:63 requires; anything else fails the check.
   *   - `errored`  — no JSON-RPC response exists at all. Same v2 discriminator
   *     as {@link runUndeclaredProbe}: `ProtocolError` carries a NUMERIC code
   *     and is minted only from a server error response, while local and
   *     transport faults are `SdkError`s with STRING codes. This is a check
   *     FAILURE, because nothing about the server was observed.
   *
   * THREE places have to be read, and the wire is the last word. Beyond the
   * decoded result and the manager's `_meta` stash, the RAW response decides:
   * a task payload with no `resultType: "task"` is invisible to both of the
   * others (see {@link findRawTaskResponse}), so a server that violates
   * tasks.md:61 AND tasks.md:102 at once would otherwise score a pass on the
   * strength of its second violation.
   */
  async probeUndeclaredCreation(
    manager: MCPClientManager,
    serverId: string,
    toolName: string,
    received: unknown[]
  ): Promise<
    | { outcome: "created"; taskId: string; discriminated: boolean }
    | { outcome: "answered" }
    | {
        outcome: "refused";
        code: number;
        message: string;
        requiredCapabilities: unknown;
      }
    | { outcome: "errored"; message: string }
  > {
    this.config.signal?.throwIfAborted();
    const receivedBefore = received.length;
    const rawTask = () => findRawTaskResponse(received.slice(receivedBefore));
    try {
      const result = await manager.executeTool(
        serverId,
        toolName,
        this.config.toolArguments ?? {}
      );
      const raw = rawTask();
      const taskId = extractUndeclaredCreationTaskId(result) ?? raw?.taskId;
      return taskId === undefined
        ? { outcome: "answered" }
        : {
            outcome: "created",
            taskId,
            discriminated: raw?.discriminated ?? true,
          };
    } catch (error) {
      // An undiscriminated task can also blow up result decoding; the wire
      // still says a task was created, and that is the violation.
      const raw = rawTask();
      if (raw) {
        return {
          outcome: "created",
          taskId: raw.taskId,
          discriminated: raw.discriminated,
        };
      }
      const code = errorCode(error);
      const message = errorMessage(error);
      return code === undefined
        ? { outcome: "errored", message }
        : {
            outcome: "refused",
            code,
            message,
            requiredCapabilities: readRequiredCapabilities(error),
          };
    }
  }

  /**
   * Sends every request the extension requires a server to refuse from a
   * non-declaring client, WITHOUT the declaration, and reports each outcome.
   * The manager's task APIs always attach the declaration, so these go through
   * the connection's raw request seam; `undefined` means there is no such seam.
   *
   * Probe order is least- to most-invasive against the (already terminal)
   * task: read, then a no-op update, then the listen subscription, and
   * `tasks/cancel` last — a server that wrongly accepts one of these must not
   * change what the next one observes.
   *
   * ERA GATE: on a 2026-07-28 connection, upstream refuses to SEND `tasks/get`
   * and `tasks/cancel` (they are 2025-registry members the modern registry
   * dropped); `tasks-ext-era-gate.ts` shadows that gate, and installs the shadow
   * LAZILY on the first extension tasks operation. These probes bypass the
   * manager's tasks APIs, so they must ask for the shadow themselves rather
   * than lean on an earlier `getTaskExt` having triggered it — `ensure…` is
   * idempotent and a no-op for a client the factory never registered.
   * Belt and braces: if the gate ever did fire, it throws an `SdkError` with a
   * STRING code, so the probe reports `probe-failed` (an offender), never a pass.
   */
  async probeUndeclaredTaskMethods(
    manager: MCPClientManager,
    serverId: string,
    taskId: string,
    sent: unknown[]
  ): Promise<UndeclaredProbe[] | undefined> {
    // `getManagedClient()`, not `getClient()`: the raw upstream `Client`'s
    // `request()` has no explicit-schema form on this SDK's surface, and its
    // schema-less form cannot carry a `tasks/*` method (see {@link RawRequest}).
    // The managed client's `requestWithSchema` is the same seam `tasks-ext.ts`
    // uses for the DECLARING calls, minus the declaration — which is precisely
    // the probe. Nothing in the wrapper chain adds the tasks capability: the
    // only `_meta` a wrapper injects is `LogLevelMetaClient`'s log level.
    this.config.signal?.throwIfAborted();
    const client = manager.getManagedClient(serverId);
    if (typeof client?.requestWithSchema !== "function") return undefined;
    // See the ERA GATE note above: the declaring path installs this on its own
    // first send, the probes must ask.
    ensureTasksExtensionEraGateShadow(client);

    const request: RawRequest = (payload, options) => {
      this.config.signal?.throwIfAborted();
      return client.requestWithSchema(
        payload as never,
        RAW_PROBE_RESULT_SCHEMA,
        options as never
      );
    };

    const probes: UndeclaredProbe[] = [];
    probes.push(
      await runUndeclaredProbe(request, sent, "tasks/get", { taskId })
    );
    // An EMPTY `inputResponses` map submits nothing, so even a server that
    // wrongly accepts this update cannot advance the task with it.
    probes.push(
      await runUndeclaredProbe(request, sent, "tasks/update", {
        taskId,
        inputResponses: {},
      })
    );
    probes.push(
      await runUndeclaredProbe(
        request,
        sent,
        "subscriptions/listen",
        { notifications: { taskIds: [taskId] } },
        { timeout: LISTEN_PROBE_TIMEOUT_MS, listenProbe: true }
      )
    );
    probes.push(
      await runUndeclaredProbe(request, sent, "tasks/cancel", { taskId })
    );
    return probes;
  }

  /**
   * Submit configured answers to this group's input-required task and inspect
   * the acknowledgement. Other lifecycle checks observe their own tasks.
   */
  async runInputRequiredLeg(
    manager: MCPClientManager,
    serverId: string,
    taskId: string,
    task: Record<string, unknown>,
    /** Live rpc-log window, so the ack can be judged as it arrived. */
    received: unknown[]
  ): Promise<InputRequiredLeg> {
    const requested = isRecord(task.inputRequests)
      ? Object.keys(task.inputRequests)
      : [];
    const responses = this.config.inputResponses;

    if (!responses || Object.keys(responses).length === 0) {
      return { outcome: "no-responses-configured", requested };
    }

    const answered = Object.keys(responses);
    this.config.signal?.throwIfAborted();
    const receivedBefore = received.length;
    let ackVerdict: ShapeVerdict;
    try {
      const ack = await manager.updateTask(
        serverId,
        taskId,
        responses as never
      );
      // "the server MUST acknowledge the request with an empty result". The
      // envelope member `resultType` and the `_meta` container are part of
      // every result, so they are not "content" — anything else is the server
      // answering with state the client is told to re-poll for.
      ackVerdict = validateCompletionAck(
        ack,
        "tasks/update",
        findRawResult(received.slice(receivedBefore))
      );
    } catch (error) {
      // A success response whose `result` is not an object is the server's
      // answer, not a rejection, and it is not an empty result. The client
      // refuses it before it can be logged: the HTTP transport throws a
      // ZodError for a frame that is not a valid JSON-RPC message, and the
      // extension guard throws for a result that is not an object.
      if (!isMalformedResponseError(error)) {
        return {
          outcome: "update-rejected",
          requested,
          answered,
          message: errorMessage(error),
          code: errorCode(error),
        };
      }
      ackVerdict = {
        violations: [
          "tasks/update did not return a result object; the client rejected the response as malformed",
        ],
        warnings: [],
      };
    }

    return { outcome: "updated", requested, answered, ackVerdict };
  }

  /**
   * Ask for a task the server never issued.
   *
   * The id is deliberately fabricated rather than derived from a real one: a
   * mutated real id could collide with a live task on a busy server, and this
   * probe must never touch one.
   *
   * All three methods are probed, but they are NOT graded alike — the extension
   * makes `-32602` a MUST for `tasks/get` and only a SHOULD for `tasks/update`
   * and `tasks/cancel`, so the caller fails on the first and advises on the
   * others. `tasks/update` carries an EMPTY `inputResponses`, so even a server
   * that wrongly accepts it cannot advance anything.
   */
  async probeUnknownTaskId(
    manager: MCPClientManager,
    serverId: string,
    /** Also send `tasks/update` and `tasks/cancel` for the unknown id. */
    probeMutations: boolean
  ): Promise<{
    taskId: string;
    get: {
      outcome: "answered" | "rejected" | "local-failure";
      code?: number;
      message?: string;
    };
    mutations: Array<{
      method: string;
      outcome: "answered" | "rejected" | "local-failure";
      code?: number;
      message?: string;
    }>;
    detail: Record<string, unknown>;
  }> {
    const taskId = `mcpjam-conformance-unknown-task-${Date.now()}`;

    /**
     * `answered` and `local-failure` are NOT the same nothing. A numeric code is
     * minted only from a server error response, so its absence means the probe
     * never got a verdict — grading that as "the server answered an unknown id"
     * would report a defect we never observed. Same distinction
     * `runUndeclaredProbe` draws through `reachedWire`.
     */
    const observe = async (
      call: () => Promise<unknown>
    ): Promise<{
      outcome: "answered" | "rejected" | "local-failure";
      code?: number;
      message?: string;
    }> => {
      try {
        await call();
        return { outcome: "answered" };
      } catch (error) {
        const code = errorCode(error);
        return code === undefined
          ? { outcome: "local-failure", message: errorMessage(error) }
          : { outcome: "rejected", code, message: errorMessage(error) };
      }
    };

    this.config.signal?.throwIfAborted();
    const get = await observe(() => manager.getTaskExt(serverId, taskId));
    this.config.signal?.throwIfAborted();
    if (!probeMutations) {
      return { taskId, get, mutations: [], detail: { get } };
    }
    const update = await observe(() =>
      manager.updateTask(serverId, taskId, {} as never)
    );
    this.config.signal?.throwIfAborted();
    const cancel = await observe(() => manager.cancelTaskExt(serverId, taskId));

    return {
      taskId,
      get,
      mutations: [
        { method: "tasks/update", ...update },
        { method: "tasks/cancel", ...cancel },
      ],
      detail: { get, update, cancel },
    };
  }

  /**
   * `tasks/cancel` on a real task.
   *
   * Asserts ONLY what the extension states: "On success, the server MUST
   * acknowledge the request with an empty result." It deliberately does NOT
   * require the task to become `cancelled` — the spec says cancellation is
   * eventually consistent, that the status "MAY remain working (or some other
   * non-terminal status) after the ack", and "MAY ultimately reach a terminal
   * status other than cancelled if the work finished before cancellation could
   * take effect". A check that demanded `cancelled` would fail servers for
   * behavior the spec explicitly permits.
   */
  async probeCancelAck(
    manager: MCPClientManager,
    serverId: string,
    taskId: string,
    /** Live rpc-log window, so the ack can be judged as it arrived. */
    received: unknown[]
  ): Promise<{
    problems: string[];
    warnings: string[];
    detail: Record<string, unknown>;
    /** Set when the probe never produced a server verdict to grade. */
    unavailable?: string;
  }> {
    const problems: string[] = [];
    const warnings: string[] = [];

    this.config.signal?.throwIfAborted();
    const receivedBefore = received.length;
    let ack: unknown;
    try {
      ack = await manager.cancelTaskExt(serverId, taskId);
    } catch (error) {
      const code = errorCode(error);
      // The same "is this a server verdict?" test `runUndeclaredProbe` makes:
      // a numeric code is minted only from a server error response, while a
      // local or transport fault carries none. Grading the latter as a
      // conformance failure would report a defect we never observed.
      if (code === undefined) {
        return {
          problems: [],
          warnings: [],
          detail: { taskId },
          unavailable: `tasks/cancel produced no JSON-RPC response (${errorMessage(
            error
          )}), so the acknowledgement requirement was not put to the server`,
        };
      }
      // A server that has already finished and forgotten the task answers the
      // unknown-id error, which is a legitimate outcome for a probe that runs
      // after the task reached a terminal status. Reported, not failed.
      if (code === INVALID_PARAMS) {
        return {
          problems: [],
          warnings: [],
          detail: { taskId, cancelCode: code },
          unavailable:
            "The task was no longer available when cancellation was sent, so its acknowledgment could not be checked.",
        };
      }
      problems.push(
        `tasks/cancel raised ${code ?? "no JSON-RPC code"}: ${errorMessage(error)}`
      );
      return { problems, warnings, detail: { taskId, cancelCode: code } };
    }

    const ackVerdict = validateCompletionAck(
      ack,
      "tasks/cancel",
      findRawResult(received.slice(receivedBefore))
    );
    problems.push(...ackVerdict.violations);
    warnings.push(...ackVerdict.warnings);

    return {
      problems,
      warnings,
      detail: {
        taskId,
        ackKeys: isRecord(ack) ? Object.keys(ack) : undefined,
        ...(isRecord(ack) ? {} : { ack }),
      },
    };
  }

  async pollToTerminal(
    manager: MCPClientManager,
    serverId: string,
    wire: TasksWire,
    taskId: string,
    options?: { stopOnInputRequired?: boolean }
  ): Promise<{
    task?: Record<string, unknown>;
    error?: unknown;
    /** Set when polling stopped because the task parked on `input_required`. */
    inputRequired?: boolean;
  }> {
    const deadline = Date.now() + this.config.pollTimeoutMs;
    let last: Record<string, unknown> | undefined;
    let consecutiveInputRequired = 0;

    while (Date.now() < deadline) {
      this.config.signal?.throwIfAborted();
      try {
        const task =
          wire === "extension"
            ? ((await manager.getTaskExt(serverId, taskId)) as unknown)
            : ((await manager.getTask(serverId, taskId)) as unknown);
        last = isRecord(task) ? task : undefined;
      } catch (error) {
        return { task: last, error };
      }

      // A task PARKED on `input_required` cannot advance until the CLIENT
      // answers, so polling it to the deadline burns `pollTimeoutMs` to arrive
      // at the state it was already in — and every dependent check then reports
      // `could-not-run` many seconds later than it had to. Stopping returns the
      // same task, sooner.
      //
      // But "parked" has to be OBSERVED, not assumed from one frame.
      // `input_required` is also a state a task can pass THROUGH: a server may
      // time its own gate out, fail the task, or have the request answered by
      // something outside this run. Returning on first sight would freeze such
      // a task mid-flight and report `tasks-inline-result` — a check the
      // `mcp-tasks` profile SCORES — as could-not-run for a server whose task
      // would have completed well inside the budget. That is a scored verdict
      // moving on our polling strategy rather than on the server.
      //
      // Requiring consecutive observations distinguishes the two: a genuinely
      // parked task still stops after a handful of polls, and a transiting one
      // is allowed to advance.
      if (
        options?.stopOnInputRequired === true &&
        last &&
        String(last.status) === "input_required"
      ) {
        consecutiveInputRequired += 1;
        if (consecutiveInputRequired >= PARKED_INPUT_REQUIRED_POLLS) {
          return { task: last, inputRequired: true };
        }
      } else {
        consecutiveInputRequired = 0;
      }

      if (last && TERMINAL_STATUSES.has(String(last.status)))
        return { task: last };

      const suggested = last
        ? Number(last.pollIntervalMs ?? last.pollInterval)
        : NaN;
      const waitMs =
        Number.isFinite(suggested) && suggested > 0 ? suggested : 250;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await delay(Math.min(waitMs, remainingMs), undefined, {
        signal: this.config.signal,
      });
    }

    return { task: last };
  }
}
