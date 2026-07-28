import {
  canDeclareTasksExtension,
  driveTaskToTerminal,
  extensionTaskToObservation,
  isUnknownTaskError,
  legacyTaskToObservation,
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

/** Refuses a verb the resolved wire does not carry. */
export function assertWireCapability(
  support: TasksSupport,
  capability: "list" | "cancel" | "update",
  hint: string,
): void {
  if (support[capability]) return;
  throw cliError(
    "TASKS_UNSUPPORTED",
    `tasks/${capability} is not available on the ${support.wire} wire. ${hint}`,
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
  task: Record<string, unknown>;
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
 */
export function detectCreatedTask(
  wire: TasksWire,
  result: unknown,
): CreatedTaskEnvelope | null {
  if (wire === "none") return null;

  const body = asRecord(result);
  if (!body) return null;

  if (wire === "extension") {
    if (body.resultType !== "task") return null;
    return {
      status: "task_created",
      wire,
      task: body,
      ...withModelImmediateResponse(result),
    };
  }

  const nested = asRecord(body.task);
  if (!nested || typeof nested.taskId !== "string" || !nested.status) {
    return null;
  }
  return {
    status: "task_created",
    wire,
    task: nested,
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
  return {
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : JSON.stringify(error),
  };
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
    outcome: result.outcome,
    wire: support.wire,
    taskId,
    ...(result.task ? { task: result.task } : {}),
    ...(result.unansweredInput?.length
      ? { unansweredInput: result.unansweredInput }
      : {}),
    ...(lastError ? { lastError } : {}),
  };
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

  const elicitationHandler = createStdinElicitationHandler({
    nonInteractive,
    ...args.collectorOptions,
  });
  const handlers: TaskInputHandlers = {
    // The two sides describe the same `elicitation/create` params with
    // different precision: the task input driver hands over an opaque record
    // because it has already validated the request shape and the declared mode
    // before dispatching, while the standalone handler is typed against the
    // narrowed union. Casting here is the seam between them.
    elicitation: (params) =>
      elicitationHandler(params as never) as Promise<Record<string, unknown>>,
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
