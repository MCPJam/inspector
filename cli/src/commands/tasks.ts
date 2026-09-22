import { conformanceExitCode } from "../lib/conformance-exit-code.js";
import { Command } from "commander";
import { reportScore } from "../lib/conformance-exit-code.js";
import {
  MCP_TASKS_CHECK_CATEGORIES,
  MCP_TASKS_CHECK_IDS,
  MCPTasksConformanceTest,
  isMCPTasksWireError,
  isUnknownTaskError,
  type MCPClientManager,
  type MCPTasksCheckCategory,
  type MCPTasksCheckId,
  type MCPTasksConformanceConfig,
  type TasksSupport,
  scoreFromTasksResult,
} from "@mcpjam/sdk";
import {
  renderConformanceForCli,
  resolveConformanceOutputFormatForCli,
} from "../lib/conformance-output.js";
import { maybeUploadSingleSuite } from "../lib/conformance-upload.js";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { parseReporterFormat } from "../lib/reporting.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parsePositiveInteger,
  parseServerConfig,
  type GlobalOptions,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import {
  cliError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";
import {
  buildMrtrBeforeConnect,
  sanitizeTerminalText,
} from "../lib/mrtr-input.js";
import {
  assertWireCapability,
  buildTaskInputDriverOptions,
  driveTaskWatch,
  getTaskForWire,
  parseTasksWireOption,
  RELATED_TASK_META_KEY,
  resolveTasksSupportOrThrow,
  taskUnknownError,
  taskWatchExitCode,
  type AssertableTasksWire,
  type TaskWatchTuning,
} from "../lib/tasks-cli.js";

const TASKS_CHECK_IDS_BY_CATEGORY: Record<
  MCPTasksCheckCategory,
  readonly MCPTasksCheckId[]
> = {
  dispatch: ["tasks-wire-resolvable", "tasks-declaration-hygiene"],
  creation: [
    "tasks-result-type-discipline",
    "tasks-undeclared-creation-refused",
  ],
  lifecycle: [
    "tasks-ttl-shape",
    "tasks-inline-result",
    "tasks-mcp-name-routing",
    "tasks-undeclared-capability-rejected",
    // Scenario depth from the conformance-gap program. All in `lifecycle`
    // because that is the category their check metadata declares, and the
    // suite's own drift test requires every id to be reachable through one.
    "tasks-invalid-task-id-rejected",
    "tasks-status-payload-shape",
    "tasks-cancel-ack-shape",
    "tasks-input-required-update-completes",
    "tasks-ttl-integer-shape",
    "tasks-undeclared-capability-names-requirements",
  ],
};

/**
 * @deprecated Use {@link conformanceExitCode}. Kept as a re-export so existing
 * imports (and its tests) keep working.
 */
export const tasksConformanceExitCode = conformanceExitCode;

export interface TasksConformanceOptions extends SharedServerTargetOptions {
  category?: string[];
  checkId?: string[];
  toolName?: string;
  toolArgs?: string;
  pollTimeout?: number;
  inputResponses?: string;
}

function collectInvalidEntries(
  values: string[] | undefined,
  allowed: readonly string[]
): string[] {
  return (values ?? []).filter((value) => !allowed.includes(value));
}

export function buildTasksConformanceConfig(
  options: TasksConformanceOptions
): MCPTasksConformanceConfig {
  const serverConfig = parseServerConfig(options);

  const categories = options.category?.filter(Boolean);
  const invalidCategories = collectInvalidEntries(
    categories,
    MCP_TASKS_CHECK_CATEGORIES
  );
  if (invalidCategories.length > 0) {
    throw usageError(
      invalidCategories.length === 1
        ? `Unknown category: ${invalidCategories[0]}`
        : `Unknown categories: ${invalidCategories.join(", ")}`
    );
  }

  const checkIds = options.checkId?.filter(Boolean);
  const invalidCheckIds = collectInvalidEntries(checkIds, MCP_TASKS_CHECK_IDS);
  if (invalidCheckIds.length > 0) {
    throw usageError(
      `Unknown check id${
        invalidCheckIds.length === 1 ? "" : "s"
      }: ${invalidCheckIds.join(", ")}`
    );
  }

  const resolvedCheckIds =
    checkIds && checkIds.length > 0
      ? checkIds
      : categories && categories.length > 0
      ? Array.from(
          new Set(
            categories.flatMap(
              (category) =>
                TASKS_CHECK_IDS_BY_CATEGORY[category as MCPTasksCheckCategory]
            )
          )
        )
      : undefined;

  return {
    ...serverConfig,
    ...(resolvedCheckIds && resolvedCheckIds.length > 0
      ? { checkIds: resolvedCheckIds as MCPTasksConformanceConfig["checkIds"] }
      : {}),
    ...(options.toolName ? { toolName: options.toolName } : {}),
    ...(options.toolArgs
      ? { toolArguments: parseJsonRecord(options.toolArgs, "--tool-args") }
      : {}),
    ...(options.pollTimeout ? { pollTimeoutMs: options.pollTimeout } : {}),
    ...(options.inputResponses
      ? {
          inputResponses: parseJsonRecord(
            options.inputResponses,
            "--input-responses"
          ),
        }
      : {}),
  };
}

export interface TaskVerbOptions extends SharedServerTargetOptions {
  taskId?: string;
  wire?: AssertableTasksWire;
  cursor?: string;
  inputResponses?: string;
}

interface TaskVerbContext {
  manager: MCPClientManager;
  serverId: string;
  support: TasksSupport;
  taskId: string;
  globalOptions: GlobalOptions;
  note: (message: string) => void;
}

function requireTaskId(options: TaskVerbOptions): string {
  if (!options.taskId) {
    throw usageError("--task-id is required.");
  }
  return options.taskId;
}

/**
 * Connects, resolves the tasks wire, runs one verb, and writes its envelope.
 *
 * Every task verb re-resolves the wire from the live handshake rather than
 * remembering it between invocations: tasks are durable server-side on both
 * wires, so an ephemeral reconnect per command is correct, and a server that
 * changed eras between runs must not be driven on a stale assumption.
 */
async function runTaskVerb<T>(
  options: TaskVerbOptions,
  command: Command,
  fn: (ctx: TaskVerbContext) => Promise<T>,
  verbOptions: { requiresTaskId?: boolean } = {},
): Promise<void> {
  const globalOptions = getGlobalOptions(command);
  const taskId = verbOptions.requiresTaskId === false ? "" : requireTaskId(options);
  const collector = globalOptions.rpc
    ? createCliRpcLogCollector({ __cli__: describeTarget(options) })
    : undefined;

  const note = (message: string) => {
    if (!globalOptions.quiet) process.stderr.write(`${message}\n`);
  };

  const config = parseServerConfig({ ...options, timeout: globalOptions.timeout });

  const result = await withEphemeralManager(
    config,
    async (manager, serverId) => {
      const support = resolveTasksSupportOrThrow(manager, serverId, options.wire);
      return fn({ manager, serverId, support, taskId, globalOptions, note });
    },
    { timeout: globalOptions.timeout, rpcLogger: collector?.rpcLogger },
  );

  writeResult(
    withRpcLogsIfRequested(result, collector, globalOptions),
    globalOptions.format,
  );
}

function addTaskIdOption(command: Command): Command {
  return command.option("--task-id <id>", "The task to act on");
}

function addWireOption(command: Command): Command {
  return command.option(
    "--wire <wire>",
    "Assert the connection resolves to this tasks wire: legacy or extension",
    parseTasksWireOption,
  );
}

function registerTaskVerbs(tasks: Command): void {
  addSharedServerOptions(
    tasks
      .command("capabilities")
      .description(
        "Report the tasks wire this connection resolves to and which task " +
          "verbs it carries. Always exits 0 — branch on `.wire`.",
      ),
  ).action(async (options: TaskVerbOptions, command: Command) => {
    const globalOptions = getGlobalOptions(command);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: describeTarget(options) })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    // Deliberately NOT routed through `runTaskVerb`: reporting "this server has
    // no tasks" is this command's whole job, so `wire: "none"` is a successful
    // answer here rather than the operational failure it is everywhere else.
    const support = await withEphemeralManager(
      config,
      async (manager, serverId) => manager.getTasksSupport(serverId),
      { timeout: globalOptions.timeout, rpcLogger: collector?.rpcLogger },
    );

    writeResult(
      withRpcLogsIfRequested(support, collector, globalOptions),
      globalOptions.format,
    );
  });

  addSharedServerOptions(
    addWireOption(
      tasks
        .command("list")
        .description("List tasks the server is tracking (legacy wire only)")
        .option("--cursor <cursor>", "Pagination cursor"),
    ),
  ).action((options: TaskVerbOptions, command: Command) =>
    runTaskVerb(
      options,
      command,
      async ({ manager, serverId, support, note }) => {
        if (support.wire === "extension") {
          // The manager answers `{ tasks: [] }` here rather than erroring, and
          // an empty list with no explanation reads as "no tasks running".
          note(
            "Note: SEP-2663 removed tasks/list — a server cannot enumerate " +
              "tasks for you on the extension wire, so this is always empty. " +
              "Track task ids from `tools call --task` instead.",
          );
        } else {
          // A 2025-11-25 server can land on the legacy wire by declaring only
          // `tasks.cancel` or `tasks.requests`. Issuing `tasks/list` anyway
          // yields the same `{ tasks: [] }` the extension returns by design —
          // which would read as "this server has no tasks" when the truth is
          // "this server cannot tell you". Refuse instead of answering falsely.
          assertWireCapability(
            support,
            "list",
            "The server did not declare `capabilities.tasks.list`.",
          );
        }
        const result = await manager.listTasks(serverId, options.cursor);
        // Resolved wire LAST. The list schema is permissive, so a server that
        // returns its own `wire` key would otherwise overwrite the value the
        // CLI resolved from the handshake — and these commands exist to
        // diagnose nonconforming servers, which is exactly the population that
        // would send one. What the connection actually negotiated is not the
        // server's to restate.
        return { ...result, wire: support.wire };
      },
      { requiresTaskId: false },
    ),
  );

  addSharedServerOptions(
    addWireOption(
      addTaskIdOption(
        tasks
          .command("get")
          .description("Read one task's current state"),
      ),
    ),
  ).action((options: TaskVerbOptions, command: Command) =>
    runTaskVerb(options, command, ({ manager, serverId, support, taskId }) =>
      getTaskForWire(manager, serverId, taskId, support),
    ),
  );

  addSharedServerOptions(
    addWireOption(
      addTaskIdOption(
        tasks
          .command("result")
          .description(
            "Read a completed task's result (legacy wire only — extension " +
              "results are inline on `tasks get`)",
          ),
      ),
    ),
  ).action((options: TaskVerbOptions, command: Command) =>
    runTaskVerb(options, command, async ({ manager, serverId, support, taskId }) => {
      try {
        const result = (await manager.getTaskResult(serverId, taskId)) as
          | Record<string, unknown>
          | null;

        // Same stamp the Inspector route applies: a result read out of band
        // carries no other trace of which task produced it.
        if (result && typeof result === "object") {
          const meta = (result._meta ?? {}) as Record<string, unknown>;
          result._meta = { ...meta, [RELATED_TASK_META_KEY]: { taskId } };
        }
        return result;
      } catch (error) {
        if (isUnknownTaskError(error)) throw taskUnknownError(taskId);
        if (isMCPTasksWireError(error)) {
          // A server condition, not flag misuse: the same command line is
          // correct against a 2025-11-25 server.
          throw cliError(
            "TASKS_UNSUPPORTED",
            "tasks/result exists only on the 2025-11-25 wire. This server " +
              "resolved to the extension wire, where a completed task carries " +
              "its result inline — use `mcpjam tasks get` instead.",
            1,
            { wire: support.wire },
          );
        }
        throw error;
      }
    }),
  );

  addSharedServerOptions(
    addWireOption(
      addTaskIdOption(
        tasks.command("cancel").description("Request cancellation of a task"),
      ),
    ),
  ).action((options: TaskVerbOptions, command: Command) =>
    runTaskVerb(
      options,
      command,
      async ({ manager, serverId, support, taskId, note }) => {
        assertWireCapability(
          support,
          "cancel",
          "The server did not declare `capabilities.tasks.cancel`.",
        );

        try {
          if (support.wire === "extension") {
            await manager.cancelTaskExt(serverId, taskId);
            note(
              "Cancellation requested. SEP-2663 cancellation is cooperative " +
                "and the ack is empty: the task may still be running, and may " +
                "still reach `completed`. Re-poll with `mcpjam tasks get`.",
            );
            return { wire: support.wire, task: null, cooperative: true };
          }

          const task = await manager.cancelTask(serverId, taskId);
          return { wire: support.wire, task };
        } catch (error) {
          if (isUnknownTaskError(error)) throw taskUnknownError(taskId);
          throw error;
        }
      },
    ),
  );

  addSharedServerOptions(
    addWireOption(
      addTaskIdOption(
        tasks
          .command("update")
          .description(
            "Answer a task's `input_required` requests (extension wire only)",
          )
          .option(
            "--input-responses <json>",
            "Responses keyed by input key, as a JSON object, @path, or - for stdin",
          ),
      ),
    ),
  ).action((options: TaskVerbOptions, command: Command) =>
    runTaskVerb(
      options,
      command,
      async ({ manager, serverId, support, taskId, note }) => {
        assertWireCapability(
          support,
          "update",
          "tasks/update is part of the io.modelcontextprotocol/tasks " +
            "extension; the 2025-11-25 wire answers task input out of band " +
            "via elicitation instead.",
        );

        if (!options.inputResponses) {
          throw usageError("--input-responses is required for `tasks update`.");
        }
        const responses = parseJsonRecord(
          options.inputResponses,
          "--input-responses",
        );
        if (!responses) {
          throw usageError("--input-responses must be a JSON object.");
        }

        try {
          const ack = await manager.updateTask(
            serverId,
            taskId,
            responses as never,
          );
          note(
            "Responses accepted. The ack is empty by design — the task's " +
              "status does not move until a later `mcpjam tasks get`.",
          );
          return { wire: support.wire, ack };
        } catch (error) {
          if (!isUnknownTaskError(error)) throw error;

          // `-32602` is only a HINT on a mutation, and this is the one verb
          // where the ambiguity bites: `tasks/update` carries an arbitrary
          // user-supplied JSON object, so Invalid Params is exactly what a
          // server returns when it rejects the RESPONSES. Translating blindly
          // would replace the server's actionable validation message with
          // "the task expired" — sending the user to re-create a task that is
          // alive and well.
          //
          // The rule is the SDK's own (`task-lifecycle-adapters.ts`): `MUST`
          // for `tasks/get`, `SHOULD` for mutations, so only a `tasks/get`
          // rejection proves a handle is gone. `get`/`cancel`/`result` take
          // nothing but the id and so have no second cause to disambiguate;
          // this one does.
          let provenUnknown = false;
          try {
            await manager.getTaskExt(serverId, taskId);
          } catch (confirmation) {
            // A confirmation that fails for any OTHER reason proves nothing,
            // so the original error stands rather than being overwritten by a
            // guess about a transport failure.
            provenUnknown = isUnknownTaskError(confirmation);
          }
          throw provenUnknown ? taskUnknownError(taskId) : error;
        }
      },
    ),
  );
}

export interface TaskWatchOptions extends TaskVerbOptions {
  durationMs?: number;
  pollIntervalMs?: number;
  maxInputRounds?: number;
  maxConsecutiveErrors?: number;
  interactive?: boolean;
  yes?: boolean;
}

export function addTaskWatchTuningOptions(command: Command): Command {
  return command
    .option(
      "--duration-ms <ms>",
      "How long to keep watching before giving up",
      (value: string) => parsePositiveInteger(value, "Duration"),
    )
    .option(
      "--poll-interval-ms <ms>",
      "Your minimum interval between polls. The server's pollIntervalMs, any Retry-After, and error backoff still apply as floors on top of it.",
      (value: string) => parsePositiveInteger(value, "Poll interval"),
    )
    .option(
      "--max-input-rounds <n>",
      "Give up after this many input_required rounds",
      (value: string) => parsePositiveInteger(value, "Max input rounds"),
    )
    .option(
      "--max-consecutive-errors <n>",
      "Give up after this many consecutive failed reads",
      (value: string) => parsePositiveInteger(value, "Max consecutive errors"),
    );
}

/**
 * `--interactive`/`--yes` are registered separately from the tuning flags
 * because `tools call` already declares both for the standalone MRTR path;
 * registering them twice on the same command is a commander error.
 */
function addWatchInteractivityOptions(command: Command): Command {
  return command
    .option("--interactive", "Answer the task's input requests from the terminal")
    .option("--yes", "Never prompt; a task that needs input exits 6");
}

export function taskWatchTuningFrom(options: TaskWatchOptions): TaskWatchTuning {
  return {
    ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(options.pollIntervalMs !== undefined
      ? { pollIntervalMs: options.pollIntervalMs }
      : {}),
    ...(options.maxInputRounds !== undefined
      ? { maxInputRounds: options.maxInputRounds }
      : {}),
    ...(options.maxConsecutiveErrors !== undefined
      ? { maxConsecutiveErrors: options.maxConsecutiveErrors }
      : {}),
  };
}

/**
 * Runs `fn` with SIGINT/SIGTERM wired to an `AbortController`.
 *
 * The listeners are registered for the watch's duration only and removed in
 * `finally`, so the process neither leaks handlers nor keeps the default kill
 * behaviour suppressed after the command is done — the shape `subscriptions
 * listen` uses. Aborting is what lets the driver unwind its in-flight read and
 * report `aborted` instead of the process dying mid-poll with no envelope.
 */
export async function withWatchSignals<T>(
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    return await fn(controller.signal);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

/** Emits status transitions to stderr so stdout stays a single envelope. */
export function watchStateReporter(
  globalOptions: GlobalOptions,
): ((snapshot: { status: string; statusMessage?: string }) => void) | undefined {
  if (globalOptions.quiet) return undefined;
  let last: string | undefined;
  return (snapshot) => {
    if (snapshot.status === last) return;
    last = snapshot.status;
    // `statusMessage` is free text the server chose, and a watch prints it on
    // every transition. Unsanitized, a server could emit ANSI escapes to
    // repaint the terminal, erase the status lines above, or forge a prompt —
    // and the operator most likely to be watching a task is the one pointed at
    // a server they do not trust. `status` is enum-constrained by both
    // observation adapters, but this reporter takes a bare string, so it gets
    // the same treatment rather than relying on every future caller.
    const detail = snapshot.statusMessage
      ? ` — ${sanitizeTerminalText(snapshot.statusMessage)}`
      : "";
    process.stderr.write(
      `task: ${sanitizeTerminalText(snapshot.status)}${detail}\n`,
    );
  };
}

function registerTaskWatch(tasks: Command): void {
  addSharedServerOptions(
    addWatchInteractivityOptions(
      addTaskWatchTuningOptions(
      addWireOption(
        addTaskIdOption(
          tasks.command("watch").description(
            "Poll a task until it reaches a terminal status. " +
              "Exit codes: 0 completed (including a tool-level isError result), " +
              "6 input_required, 7 timed out, 130 interrupted, 1 otherwise. " +
              "The host tasks policy is not consulted — this is a debugging " +
              "affordance, like the Inspector's Tools tab.",
          ),
        ),
      ),
      ),
    ),
  ).action(async (options: TaskWatchOptions, command: Command) => {
    const globalOptions = getGlobalOptions(command);
    const taskId = requireTaskId(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: describeTarget(options) })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const input = buildTaskInputDriverOptions({
      config,
      interactive: options.interactive,
      yes: options.yes,
    });
    const onState = watchStateReporter(globalOptions);

    // `withWatchSignals` goes INSIDE the connect, not around it. Its listeners
    // suppress Node's default SIGINT termination, and `withEphemeralClient`
    // gives the handshake no signal to observe — so wrapping the connect would
    // leave a Ctrl-C against an unreachable server doing nothing until
    // `--timeout`, with repeat presses swallowed too. That is worse than no
    // signal handling at all, and there is no task to report on before the
    // connection exists. Scoping them to the drive is the shape
    // `subscriptions listen` uses.
    const envelope = await withEphemeralManager(
        config,
        async (manager, serverId) => {
          const support = resolveTasksSupportOrThrow(
            manager,
            serverId,
            options.wire,
          );
          return withWatchSignals((signal) =>
            driveTaskWatch({
              manager,
              serverId,
              support,
              taskId,
              tuning: taskWatchTuningFrom(options),
              ...(input ? { input } : {}),
              signal,
              ...(onState ? { onState } : {}),
            }),
          );
        },
        {
          timeout: globalOptions.timeout,
          rpcLogger: collector?.rpcLogger,
          // On the legacy wire a task's `input_required` surfaces as an
          // out-of-band `elicitation/create` stamped with the task id, not as
          // data on `tasks/get`. Registering the terminal handler is the only
          // way a single invocation can answer it.
          ...(options.interactive
            ? {
                beforeConnect: buildMrtrBeforeConnect(options),
                interactiveElicitation: true,
              }
            : {}),
        },
      );

    writeResult(
      withRpcLogsIfRequested(envelope, collector, globalOptions),
      globalOptions.format,
    );

    const exitCode = taskWatchExitCode(envelope.outcome);
    if (exitCode !== 0) setProcessExitCode(exitCode);
  });
}

export function registerTasksCommands(program: Command): void {
  const tasks = program
    .command("tasks")
    .description(
      "Create, inspect and drive MCP Tasks (legacy 2025-11-25 and SEP-2663), " +
        "and validate a server's tasks wire behavior",
    );

  registerTaskVerbs(tasks);
  registerTaskWatch(tasks);

  addSharedServerOptions(
    tasks
      .command("conformance")
      .description("Run MCP Tasks conformance checks")
      .option(
        "--category <category>",
        "Check category to run. Repeat for multiple. Default: all.",
        (value: string, previous: string[] = []) => [...previous, value],
        []
      )
      .option(
        "--check-id <id>",
        "Specific check ID to run. Repeat for multiple. Default: all.",
        (value: string, previous: string[] = []) => [...previous, value],
        []
      )
      .option(
        "--tool-name <tool>",
        "Tool used to provoke a task. Required for servers whose tools carry no task metadata (the extension wire)."
      )
      .option("--tool-args <json>", "Tool arguments as a JSON object")
      .option(
        "--input-responses <json>",
        'Responses to submit when the probed task reports input_required, keyed by inputRequests key: {"name":{"result":{"action":"accept","content":{"name":"Ada"}}}}. Without it the run stops as soon as the task parks on input_required, and the round-trip check reports what it needs.'
      )
      .option(
        "--poll-timeout <ms>",
        "How long to poll a created task for a terminal status",
        (value: string) => parsePositiveInteger(value, "Poll timeout"),
        30_000
      )
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary or junit-xml"
      )
      .option("--upload", "Upload this suite's result into MCPJam run history")
      .option(
        "--require-upload",
        "Fail if reporting is configured but the UI record cannot be written"
      )
  ).action(async (options, command) => {
    const reporter = parseReporterFormat(
      options.reporter as string | undefined
    );
    const globalOptions = command.optsWithGlobals() as {
      format?: string;
      timeout?: number;
      rpc?: boolean;
      quiet?: boolean;
    };
    const format = resolveConformanceOutputFormatForCli(
      globalOptions.format,
      process.stdout.isTTY,
      reporter
    );
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;

    const config: MCPTasksConformanceConfig = {
      ...buildTasksConformanceConfig({
        ...(options as TasksConformanceOptions),
        timeout: globalOptions.timeout ?? 30_000,
      }),
      ...(collector ? { rpcLogger: collector.rpcLogger } : {}),
    };
    const result = await new MCPTasksConformanceTest(config).run();

    const outputResult = reporter
      ? result
      : (withRpcLogsIfRequested(result, collector, {
          format,
          rpc: globalOptions.rpc ?? false,
        }) as typeof result);
    const output = renderConformanceForCli(outputResult, reporter, format);
    process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);

    reportScore(scoreFromTasksResult(result), command);
    const incompleteReason = (result as { incompleteReason?: string })
      .incompleteReason;
    if (incompleteReason && !globalOptions.quiet) {
      // The JSON payload carries it too, but a human running this in a terminal
      // must not have to dig for the reason six checks never ran.
      process.stderr.write(`Run incomplete: ${incompleteReason}\n`);
    }

    const exitCode = tasksConformanceExitCode(result);
    await maybeUploadSingleSuite({
      suiteKind: "tasks",
      result,
      serverUrl:
        "url" in config && typeof config.url === "string" ? config.url : undefined,
      upload: Boolean((options as { upload?: boolean }).upload),
      requireUpload: Boolean(
        (options as { requireUpload?: boolean }).requireUpload
      ),
      command,
    });
    if (exitCode !== 0) {
      setProcessExitCode(exitCode);
    }
  });
}
