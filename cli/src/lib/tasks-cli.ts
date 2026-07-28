import {
  canDeclareTasksExtension,
  driveTaskToTerminal,
  extensionTaskToObservation,
  isUnknownTaskError,
  legacyTaskToObservation,
  LEGACY_TASK_STATUSES,
  TaskLifecycleEngine,
  type MCPClientManager,
  type MCPServerConfig,
  type TaskAwaitOutcome,
  type TaskInputDriverOptions,
  type TaskInputHandlers,
  type TaskInputRejection,
  type TaskLifecycleIdentity,
  type TaskLifecycleSnapshot,
  type TasksSupport,
  type TasksWire,
} from "@mcpjam/sdk";
import { applyInteractiveElicitationCapability } from "./ephemeral.js";
import {
  createStdinElicitationHandler,
  resolveNonInteractive,
  type StdinMrtrCollectorOptions,
} from "./mrtr-input.js";
import { cliError, usageError, type CliError } from "./output.js";

/**
 * `_meta` key carrying the synchronous stand-in a server may return alongside a
 * created task. Output-only on every CLI surface — the same key the Inspector
 * route reads (`server/utils/task-route-handlers.ts`).
 */
export const MODEL_IMMEDIATE_RESPONSE_META_KEY =
  "io.modelcontextprotocol/model-immediate-response";

/**
 * `_meta` key the CLI stamps onto a legacy `tasks/result` payload so a result
 * read out of band still names the task it belongs to. Mirrors the route.
 */
export const RELATED_TASK_META_KEY = "io.modelcontextprotocol/related-task";

/** The wires a user may assert with `--wire`. */
export const ASSERTABLE_TASKS_WIRES = ["legacy", "extension"] as const;

export type AssertableTasksWire = (typeof ASSERTABLE_TASKS_WIRES)[number];

export function parseTasksWireOption(value: string): AssertableTasksWire {
  if ((ASSERTABLE_TASKS_WIRES as readonly string[]).includes(value)) {
    return value as AssertableTasksWire;
  }
  throw usageError(
    `Invalid wire "${value}". Use "legacy" or "extension".`,
  );
}

/**
 * Resolves the connection's tasks support, refusing a server that has no wire.
 *
 * A server without tasks is an operational condition (exit 1), not flag misuse:
 * the same command line is correct against a server that does support them.
 * `--wire` is an assertion, so a mismatch is reported against the wire the
 * server actually resolved to rather than silently proceeding on the other one.
 */
export function resolveTasksSupportOrThrow(
  manager: MCPClientManager,
  serverId: string,
  requiredWire?: AssertableTasksWire,
): TasksSupport {
  const support = manager.getTasksSupport(serverId);

  if (support.wire === "none") {
    throw cliError(
      "TASKS_UNSUPPORTED",
      "This server does not support MCP Tasks on either wire: it neither " +
        "declares `capabilities.tasks` on 2025-11-25 nor the " +
        "`io.modelcontextprotocol/tasks` extension on 2026-07-28.",
      1,
      { wire: support.wire },
    );
  }

  if (requiredWire && support.wire !== requiredWire) {
    throw cliError(
      "TASKS_WIRE_MISMATCH",
      `--wire ${requiredWire} was asserted, but this connection resolved to ` +
        `the ${support.wire} wire.`,
      1,
      { requestedWire: requiredWire, wire: support.wire },
    );
  }

  return support;
}

const CAPABILITY_LABELS: Record<TaskCapability, string> = {
  list: "tasks/list",
  cancel: "tasks/cancel",
  update: "tasks/update",
  toolCalls: "task-augmented tools/call",
};

export type TaskCapability = "list" | "cancel" | "update" | "toolCalls";

/** Refuses an operation the resolved wire does not actually carry. */
export function assertWireCapability(
  support: TasksSupport,
  capability: TaskCapability,
  hint: string,
): void {
  if (support[capability]) return;
  throw cliError(
    "TASKS_UNSUPPORTED",
    `${CAPABILITY_LABELS[capability]} is not available on the ` +
      `${support.wire} wire. ${hint}`,
    1,
    { wire: support.wire, capability },
  );
}

/**
 * Turns the SDK's `-32602`-shaped unknown-task rejection into a stable CLI
 * error. The value is SCREAMING_SNAKE to match every other CLI error code; the
 * Inspector route's kebab spelling is an HTTP-body contract, not this one.
 */
export function taskUnknownError(taskId: string): CliError {
  return cliError(
    "TASK_UNKNOWN_OR_EXPIRED",
    `The server does not know task "${taskId}". It was never created, or its ` +
      "TTL elapsed and the server dropped it.",
    1,
    { taskId },
  );
}

export interface TaskForWire {
  wire: TasksWire;
  task: unknown;
}

/**
 * Reads one task on whichever wire the connection resolved to.
 *
 * The extension carries the result, `inputRequests`, `ttlMs` and
 * `pollIntervalMs` inline on this single read; the legacy wire returns bare
 * status fields and needs `tasks/result` for the payload.
 */
export async function getTaskForWire(
  manager: MCPClientManager,
  serverId: string,
  taskId: string,
  support: TasksSupport,
): Promise<TaskForWire> {
  try {
    const task =
      support.wire === "extension"
        ? await manager.getTaskExt(serverId, taskId)
        : await manager.getTask(serverId, taskId);
    return { wire: support.wire, task };
  } catch (error) {
    if (isUnknownTaskError(error)) throw taskUnknownError(taskId);
    throw error;
  }
}

export interface CreatedTaskEnvelope {
  status: "task_created";
  wire: TasksWire;
  /** Always carries a non-empty string `taskId` — see `detectCreatedTask`. */
  task: Record<string, unknown> & { taskId: string };
  modelImmediateResponse?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelImmediateResponseOf(result: unknown): unknown {
  return asRecord(asRecord(result)?._meta)?.[MODEL_IMMEDIATE_RESPONSE_META_KEY];
}

/**
 * Classifies a `tools/call` result as a task creation, per wire.
 *
 * A port of the Inspector route's `detectCreatedTask` — the two cannot share
 * code across workspaces, so the shapes are kept deliberately identical. The
 * asymmetry is real and load-bearing: the extension's `CreateTaskResult` is
 * FLAT (the body itself is the task, discriminated by `resultType: "task"`),
 * while the legacy wire nests it under `task`. Accepting the other wire's shape
 * would hide a nonconforming server from the person debugging it, so each wire
 * accepts only its own.
 *
 * Both wires additionally require a usable `taskId`. Without that check a
 * server that answered `resultType: "task"` and nothing else would be reported
 * as a successful creation, and `--task-watch` would go on to poll `tasks/get`
 * with an undefined id — burying the malformed payload under an opaque polling
 * failure. Returning `null` instead routes it to the "no task materialized"
 * path, which prints the server's actual response.
 */
export function detectCreatedTask(
  wire: TasksWire,
  result: unknown,
): CreatedTaskEnvelope | null {
  if (wire === "none") return null;

  const body = asRecord(result);
  if (!body) return null;

  const task = wire === "extension" ? body : asRecord(body.task);
  if (!task) return null;

  if (wire === "extension") {
    if (task.resultType !== "task") return null;
  } else if (
    typeof task.status !== "string" ||
    !LEGACY_TASK_STATUSES.has(task.status)
  ) {
    // Membership, not mere presence. A status of `"queued"` is exactly as
    // nonconforming as a missing one, but a truthiness check accepts it — and
    // the damage is worse than a bad envelope: `legacyTaskToObservation`
    // normalizes an unrecognized status to `working`, so `--task-watch` would
    // poll a task the server never advances and bury the malformed creation
    // under an opaque timeout.
    //
    // The normalizer is right to be lenient — an unclassifiable handle is
    // still a handle, and inventing a terminal state would strand it. That
    // leniency is for a status observed mid-flight. Creation is the one moment
    // the CLI can still refuse the handle outright, and the legacy wire is a
    // frozen revision, so its five statuses are not a moving target to be
    // forward-compatible with.
    return null;
  }

  const taskId = task.taskId;
  if (typeof taskId !== "string" || taskId.length === 0) return null;

  return {
    status: "task_created",
    wire,
    task: task as Record<string, unknown> & { taskId: string },
    ...withModelImmediateResponse(result),
  };
}

function withModelImmediateResponse(
  result: unknown,
): { modelImmediateResponse?: unknown } {
  const value = modelImmediateResponseOf(result);
  return value === undefined ? {} : { modelImmediateResponse: value };
}

/**
 * Exit code for a finished `tasks watch`.
 *
 * Only outcomes that tell a script to do something DIFFERENT get their own
 * code. `input-required` means "re-run interactively or answer with
 * `tasks update`", and `timeout` means "poll longer" — both are recoverable and
 * distinguishable only by acting on them. `failed`/`cancelled`/`expired`/
 * `unreachable` all mean the same thing to a caller ("no result, and re-running
 * this command will not produce one"), so they collapse onto the CLI's generic
 * failure code; the envelope's `outcome` field still separates them for anyone
 * who cares. `130` follows the shell convention for a SIGINT-terminated run.
 *
 * `completed` is 0 even when the tool reported `isError: true`: a tool error is
 * a task that finished, and the result rides in the envelope. Use
 * `--expect-success` semantics at the call site if you need otherwise.
 */
export function taskWatchExitCode(outcome: TaskAwaitOutcome): number {
  switch (outcome) {
    case "completed":
      return 0;
    case "input-required":
      return 6;
    case "timeout":
      return 7;
    case "aborted":
      return 130;
    case "failed":
    case "cancelled":
    case "expired":
    case "unreachable":
      return 1;
  }
}

export interface TaskWatchTuning {
  durationMs?: number;
  pollIntervalMs?: number;
  maxInputRounds?: number;
  maxConsecutiveErrors?: number;
}

export interface TaskWatchEnvelope {
  outcome: TaskAwaitOutcome;
  wire: TasksWire;
  taskId: string;
  task?: TaskLifecycleSnapshot;
  unansweredInput?: TaskInputRejection[];
  lastError?: { message: string };
}

function describeError(error: unknown): { message: string } | undefined {
  if (error === undefined || error === null) return undefined;
  // `JSON.stringify(new Error(...))` is `{}`, so an Error reaching the envelope
  // verbatim would silently erase the only useful field.
  if (error instanceof Error) return { message: error.message };
  if (typeof error === "string") return { message: error };
  try {
    // This is the last step before the envelope is written. A cyclic or
    // BigInt-bearing value would otherwise turn a perfectly reportable outcome
    // into an unhandled throw, losing the outcome AND the error.
    return { message: JSON.stringify(error) ?? String(error) };
  } catch {
    return { message: String(error) };
  }
}

export interface DriveTaskWatchArgs {
  manager: MCPClientManager;
  serverId: string;
  support: TasksSupport;
  taskId: string;
  tuning?: TaskWatchTuning;
  input?: TaskInputDriverOptions;
  signal?: AbortSignal;
  onState?: (snapshot: TaskLifecycleSnapshot) => void;
}

/**
 * Drives one task to a terminal status and reports the outcome.
 *
 * The polling loop itself belongs to `driveTaskToTerminal`, not here: the
 * lifecycle engine applies the server's `pollIntervalMs`, any `Retry-After`,
 * and error backoff as floors on top of the user's `--poll-interval-ms`, so a
 * caller cannot out-poll a server by construction. This function's only job is
 * to bind the wire-specific reads to the driver's wire-neutral seams, which it
 * does ONCE, up front, rather than branching inside the loop.
 */
export async function driveTaskWatch(
  args: DriveTaskWatchArgs,
): Promise<TaskWatchEnvelope> {
  const { manager, serverId, support, taskId } = args;
  if (support.wire === "none") {
    throw cliError(
      "TASKS_UNSUPPORTED",
      "Cannot watch a task on a server with no tasks wire.",
      1,
    );
  }

  const identity: TaskLifecycleIdentity = {
    serverId,
    wire: support.wire,
    taskId,
  };

  const engine = new TaskLifecycleEngine();
  if (args.tuning?.pollIntervalMs !== undefined) {
    engine.setUserMinimumIntervalMs(args.tuning.pollIntervalMs);
  }

  const extension = support.wire === "extension";

  const result = await driveTaskToTerminal({
    identity,
    engine,
    getTask: async () =>
      extension
        ? extensionTaskToObservation(await manager.getTaskExt(serverId, taskId))
        : legacyTaskToObservation(
            (await manager.getTask(serverId, taskId)) as never,
          ),
    // Extension results are inline on `tasks/get`; the legacy wire has no
    // payload at all without this second call, and the driver reports a
    // completed-but-empty watch as an error rather than inventing one.
    ...(extension
      ? {}
      : {
          getResult: async () =>
            (await manager.getTaskResult(serverId, taskId)) as Record<
              string,
              unknown
            > | null,
        }),
    // Extension only, and not an omission: `tasks/update` does not exist on
    // 2025-11-25, which is why `TasksSupport.update` is hard-`false` for that
    // wire. A legacy task's input arrives out of band as an `elicitation/create`
    // stamped with `relatedTaskId` and its `Task` carries no `inputRequests`, so
    // the poll loop has nothing to answer and nothing to answer it with. The
    // driver reports `input_required` there deliberately rather than re-reading
    // an unchanging status until the deadline — a deterministic exit 6 beats a
    // timeout that looks like a hang.
    ...(extension
      ? {
          updateTask: async (_identity, inputResponses) => {
            await manager.updateTask(serverId, taskId, inputResponses as never);
          },
        }
      : {}),
    ...(args.input ? { input: args.input } : {}),
    ...(args.tuning?.durationMs !== undefined
      ? { timeoutMs: args.tuning.durationMs }
      : {}),
    ...(args.tuning?.maxInputRounds !== undefined
      ? { maxInputRounds: args.tuning.maxInputRounds }
      : {}),
    ...(args.tuning?.maxConsecutiveErrors !== undefined
      ? { maxConsecutiveErrors: args.tuning.maxConsecutiveErrors }
      : {}),
    ...(args.signal ? { signal: args.signal } : {}),
    ...(args.onState ? { onState: args.onState } : {}),
  });

  const lastError = describeError(result.lastError);

  return {
    outcome: abortedDuringResultFetch({
      aborted: args.signal?.aborted === true,
      outcome: result.outcome,
      hasLastError: result.lastError !== undefined,
      hasResult:
        (result.task as { result?: unknown } | undefined)?.result !== undefined,
    })
      ? "aborted"
      : result.outcome,
    wire: support.wire,
    taskId,
    ...(result.task ? { task: result.task } : {}),
    ...(result.unansweredInput?.length
      ? { unansweredInput: result.unansweredInput }
      : {}),
    ...(lastError ? { lastError } : {}),
  };
}

/**
 * Whether a settled watch was really an interrupt during the legacy result
 * fetch, rather than the clean completion it reports as.
 *
 * A legacy fetch that loses to the signal still settles as `completed`: the
 * TASK did finish, and `driveTaskToTerminal` reports the failed `tasks/result`
 * as a `lastError` beside it. That is right for the library — the task's
 * terminal state is a fact independent of whether the payload was retrieved —
 * but wrong for this CLI, whose documented contract is that an interrupt yields
 * `aborted` and exit 130. Left alone, Ctrl-C during that final fetch is the one
 * interrupt in the whole surface that exits 0, and a script would read a
 * resultless envelope as success.
 *
 * Structural rather than message-matching. On the legacy wire the CLI always
 * supplies `getResult`, so a `completed` carrying a `lastError` and no
 * `task.result` means the fetch did not deliver. The abort is attributed only
 * when the signal actually fired: a fetch that failed on its own merits keeps
 * `completed`, and a `null` payload — the server's legitimate "no result" —
 * sets no `lastError` and is untouched.
 */
export function abortedDuringResultFetch(args: {
  aborted: boolean;
  outcome: string;
  hasLastError: boolean;
  hasResult: boolean;
}): boolean {
  return (
    args.aborted &&
    args.outcome === "completed" &&
    args.hasLastError &&
    !args.hasResult
  );
}

export interface BuildTaskInputDriverOptionsArgs {
  /** The post-host-merge server config, so the declaration check sees truth. */
  config: MCPServerConfig;
  interactive?: boolean;
  yes?: boolean;
  /** Test seam: forwarded to the stdin collector. */
  collectorOptions?: StdinMrtrCollectorOptions;
  stdinIsTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the `input_required` driver options for a watch, or `undefined` when
 * the run cannot prompt.
 *
 * `declaredCapabilities` is read off the POST-merge config rather than
 * hardcoded, because `canDeclareTasksExtension` refuses to declare the tasks
 * extension when the connection advertises an input capability nothing here can
 * answer. Hardcoding `{ elicitation: {} }` would paper over exactly that: a
 * `--host`/`--client-capabilities` set that also declares `sampling` would
 * strand any task asking for it, and the user would see a hang instead of the
 * reason.
 */
export function buildTaskInputDriverOptions(
  args: BuildTaskInputDriverOptionsArgs,
): TaskInputDriverOptions | undefined {
  // Without `--interactive` there is no handler at all, so an `input_required`
  // task ends the drive and the caller answers with `mcpjam tasks update`.
  if (args.interactive !== true) return undefined;

  // With `--interactive` the handler is ALWAYS wired, and whether it can
  // actually prompt is the collector's business — the same split
  // `buildMrtrBeforeConnect` uses. Disarming here instead would break the
  // legitimate case of feeding answers in on a pipe, and would make `--yes`
  // silently mean two different things depending on the surface.
  const nonInteractive = resolveNonInteractive({
    yes: args.yes,
    stdinIsTTY: args.stdinIsTTY ?? Boolean(process.stdin.isTTY),
    ...(args.env ? { env: args.env } : {}),
  });

  const resolved = applyInteractiveElicitationCapability(args.config);
  const declaredCapabilities =
    (resolved as { clientCapabilities?: Record<string, unknown> })
      .clientCapabilities ?? resolved.capabilities;

  const handlers: TaskInputHandlers = {
    // Built per invocation rather than once, so each call can be given ITS
    // context's `signal`. A terminal prompt is the one place a watch can block
    // indefinitely, and without the signal reaching `readline` a Ctrl-C during
    // the prompt would leave the drive stuck instead of producing the
    // documented `aborted` outcome.
    //
    // The cast is the seam between two descriptions of the same
    // `elicitation/create` params: the task input driver hands over an opaque
    // record because it has already validated the request shape and the
    // declared mode before dispatching, while the standalone handler is typed
    // against the narrowed union.
    elicitation: (params, ctx) =>
      createStdinElicitationHandler({
        nonInteractive,
        ...(ctx?.signal ? { signal: ctx.signal } : {}),
        ...args.collectorOptions,
      })(params as never) as Promise<Record<string, unknown>>,
  };

  const declaration = canDeclareTasksExtension(
    declaredCapabilities as never,
    handlers,
  );
  if (!declaration.ok) {
    throw usageError(
      "--interactive cannot answer a task's embedded input on this " +
        `connection: it advertises ${declaration.missing.join(", ")} with no ` +
        "handler behind it, so a task requesting one would never be answered. " +
        "Drop the capability from --client-capabilities/--host, or drop " +
        "--interactive and answer with `mcpjam tasks update`.",
      { missing: declaration.missing },
    );
  }

  return { declaredCapabilities: declaredCapabilities as never, handlers };
}
