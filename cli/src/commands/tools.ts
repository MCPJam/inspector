import { Command } from "commander";
import {
  buildToolCallValidationReport,
  isCallToolResultError,
  validateToolCallResult,
} from "@mcpjam/sdk";
import type { HttpExchangeLogEvent, MCPServerConfig } from "@mcpjam/sdk";
// The mirrored-header vocabulary, from the SDK that builds the headers — a
// local copy of "which header names are Mcp-Param-*" or of the sentinel
// decoder would be a second answer to a question the wire already settled.
import { classifyMcpHeader, decodeMcpHeaderValue } from "@mcpjam/sdk";
import { writeCommandDebugArtifact } from "../lib/debug-artifact.js";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { buildMrtrBeforeConnect } from "../lib/mrtr-input.js";
import {
  addTaskWatchTuningOptions,
  taskWatchTuningFrom,
  watchStateReporter,
  withWatchSignals,
} from "./tasks.js";
import {
  assertWireCapability,
  buildTaskInputDriverOptions,
  detectCreatedTask,
  driveTaskWatch,
  parseTasksWireOption,
  resolveTasksSupportOrThrow,
  taskWatchExitCode,
  type AssertableTasksWire,
} from "../lib/tasks-cli.js";
import {
  buildInspectorServerName,
  findInspectorRenderError,
  parseRenderDevice,
  parseRenderProtocol,
  parseRenderTheme,
  runUiRender,
  trimOptional,
} from "../lib/inspector-render.js";
import { parseReporterFormat, writeReporterResult } from "../lib/reporting.js";
import {
  attachCliDurationMs,
  createCliRpcLogCollector,
} from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import { normalizeInspectorFrontendUrl } from "../lib/inspector-api.js";
import {
  estimateTokensFromChars,
  listToolsWithMetadata,
} from "../lib/server-ops.js";
import { summarizeServerDoctorTarget } from "../lib/server-doctor.js";
import {
  addHostOption,
  addConformanceOptions,
  conformanceConfigFromOptions,
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parseRetryPolicy,
  parsePositiveInteger,
  parseServerConfig,
  resolveAliasedStringOption,
  type GlobalOptions,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import {
  applyHostToConfig,
  applyHostVisibility,
  assertToolVisibleToHost,
  resolveHostFromOptions,
} from "../lib/host-resolve.js";
import {
  cliError,
  normalizeCliError,
  setProcessExitCode,
  toStructuredError,
  usageError,
  writeResult,
} from "../lib/output.js";

interface ToolsCallOptions extends SharedServerTargetOptions {
  toolName?: string;
  name?: string;
  interactive?: boolean;
  yes?: boolean;
  toolArgs?: string;
  toolArgsStdin?: boolean;
  params?: string;
  validateResponse?: boolean;
  expectSuccess?: boolean;
  reporter?: string;
  debugOut?: string;
  ui?: boolean;
  requireRender?: boolean;
  open?: boolean;
  attachOnly?: boolean;
  inspectorUrl?: string;
  frontendUrl?: string;
  serverName?: string;
  protocol?: string;
  device?: string;
  theme?: string;
  locale?: string;
  timeZone?: string;
  task?: boolean;
  taskTtl?: number;
  taskWatch?: boolean;
  durationMs?: number;
  pollIntervalMs?: number;
  maxInputRounds?: number;
  maxConsecutiveErrors?: number;
  wire?: AssertableTasksWire;
  /**
   * `--no-param-headers`. Commander defaults a `--no-x` flag to `true`, so
   * `false` here means the user explicitly asked to suppress SEP-2243
   * `Mcp-Param-*` mirroring — i.e. to call the tool as a client that has not
   * implemented it.
   */
  paramHeaders?: boolean;
  /** `--mcp-header Name=Value`, repeatable. Raw request headers, caller-wins. */
  mcpHeader?: string[];
  /** `--first-page-only`. Read only page one of paginated lists. */
  firstPageOnly?: boolean;
  /**
   * `--no-mrtr`. Commander defaults a `--no-x` flag to `true`, so `false`
   * here means the user explicitly asked to call as a client that does not
   * drive MRTR rounds.
   */
  mrtr?: boolean;
}

/**
 * Parse `--mcp-header Name=Value` into a header map.
 *
 * Deliberately NOT `Key: Value` like `--header`: these are the mirrored
 * protocol headers, and the `=` form keeps a value containing `:` (a URI, a
 * timestamp) unambiguous. Repeats of the same name are last-wins, matching how
 * a single HTTP field would behave.
 */
export function parseMcpHeaderOption(
  values: string[] | undefined,
): Record<string, string> | undefined {
  if (!values || values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw usageError(
        `--mcp-header must be in "Name=Value" format (got "${entry}").`,
      );
    }
    const name = entry.slice(0, index).trim();
    if (name === "") {
      throw usageError(
        `--mcp-header must be in "Name=Value" format (got "${entry}").`,
      );
    }
    out[name] = entry.slice(index + 1);
  }
  return out;
}

/**
 * Capture the `Mcp-Param-*` headers of the FIRST `tools/call` on the wire.
 *
 * Rides the headers-only `httpLogger` channel rather than `rpcLogger`, because
 * that is the only place these exist: SEP-2243 mirrors argument values into the
 * HTTP envelope, and the JSON-RPC body a `rpcLogger` sees carries no trace of
 * them. stdio emits nothing here, which is correct — mirroring is Streamable
 * HTTP only.
 */
function createMcpParamHeaderProbe(): {
  httpLogger: (event: HttpExchangeLogEvent) => void;
  mirrored: () => Record<string, string> | undefined;
} {
  let captured: Record<string, string> | undefined;
  return {
    httpLogger: (event) => {
      if (captured !== undefined) return;
      if (event.bodyValues?.method !== "tools/call") return;
      const params: Record<string, string> = {};
      for (const [name, value] of Object.entries(event.request.headers)) {
        if (classifyMcpHeader(name) === "param") {
          const decoded = decodeMcpHeaderValue(value);
          params[name] = decoded.decodeError ? value : decoded.value;
        }
      }
      captured = params;
    },
    mirrored: () => captured,
  };
}

/**
 * The one line `tools call` prints about mirrored headers, and only when the
 * user is actually debugging them (`--mcp-header` / `--no-param-headers` /
 * `--rpc`). Default runs stay byte-identical.
 */
/**
 * Emit the mirrored-header line on STDERR, never stdout: `tools call` output is
 * a machine-readable tool result, and a diagnostic line would corrupt a
 * `| jq` pipeline for anyone who did not ask for it.
 */
function reportMirroredParamHeaders(
  probe: { mirrored: () => Record<string, string> | undefined } | undefined,
  globalOptions: GlobalOptions,
): void {
  if (!probe || globalOptions.quiet) return;
  process.stderr.write(`${describeMirroredParamHeaders(probe.mirrored())}\n`);
}

function describeMirroredParamHeaders(
  mirrored: Record<string, string> | undefined,
): string {
  if (mirrored === undefined) return "Mcp-Param-*: none (no HTTP tools/call observed)";
  const entries = Object.entries(mirrored);
  if (entries.length === 0) return "Mcp-Param-*: none sent";
  return `Mcp-Param-*: ${entries
    .map(([name, value]) => `${name}=${value}`)
    .join(", ")}`;
}

/**
 * Runs a task-augmented `tools/call`, optionally watching the created task to a
 * terminal status in the SAME connection.
 *
 * Chaining inside one `withEphemeralManager` is not just an optimization: on
 * the legacy wire a task's `input_required` arrives as an out-of-band
 * `elicitation/create`, so a create and a watch split across two invocations
 * could never answer it.
 */
async function runTaskAugmentedToolCall(args: {
  options: ToolsCallOptions;
  globalOptions: GlobalOptions;
  config: MCPServerConfig;
  host: ReturnType<typeof resolveHostFromOptions>;
  toolName: string;
  params: Record<string, unknown>;
  collector: ReturnType<typeof createCliRpcLogCollector> | undefined;
  targetSummary: ReturnType<typeof summarizeServerDoctorTarget>;
  snapshotCollector: ReturnType<typeof createCliRpcLogCollector> | undefined;
}): Promise<void> {
  const {
    options,
    globalOptions,
    config,
    host,
    toolName,
    params,
    collector,
    targetSummary,
    snapshotCollector,
  } = args;

  /**
   * Same debug artifact the plain path writes.
   *
   * A task creation that fails on the wire is precisely when `--debug-out` is
   * wanted, so this path honours the flag rather than refusing it — accepting
   * it and writing nothing would read as a broken flag.
   */
  const writeArtifact = (outcome: {
    status: "success" | "error";
    result?: unknown;
    error?: unknown;
  }) =>
    writeCommandDebugArtifact({
      outputPath: options.debugOut,
      format: globalOptions.format,
      quiet: globalOptions.quiet,
      commandName: "tools call",
      commandInput: { toolName, params },
      target: targetSummary,
      outcome: outcome as never,
      snapshot: options.debugOut
        ? {
            input: {
              config,
              target: targetSummary,
              timeout: globalOptions.timeout,
            },
            collector: snapshotCollector,
          }
        : undefined,
      collectors: [collector],
    });

  const input = buildTaskInputDriverOptions({
    config: host ? applyHostToConfig(config, host.connection) : config,
    interactive: options.interactive,
    yes: options.yes,
  });
  const onState = options.taskWatch ? watchStateReporter(globalOptions) : undefined;
  const note = (message: string) => {
    if (!globalOptions.quiet) process.stderr.write(`${message}\n`);
  };

  // `withWatchSignals` goes INSIDE the connect, not around it. Its listeners
  // suppress Node's default SIGINT termination, and `withEphemeralClient` gives
  // the handshake no signal to observe — so wrapping the connect would leave a
  // Ctrl-C against an unreachable server doing nothing until `--timeout`, with
  // repeat presses swallowed too. That is worse than no signal handling at all.
  // Scoping them to the work that can actually honour an abort is the shape
  // `subscriptions listen` uses.
  const run = () =>
    withEphemeralManager(
      config,
      async (manager, serverId) => {
        if (host) {
          await assertToolVisibleToHost(manager, serverId, toolName, host);
        }
        const support = resolveTasksSupportOrThrow(manager, serverId, options.wire);

        // A 2025-11-25 server reaches the legacy wire by declaring ANY of
        // `tasks.list`/`cancel`/`requests`, so the wire alone does not mean it
        // accepts task-augmented tool calls — and the manager's guard checks
        // only the wire. Without this, the CLI sends an opt-in the server never
        // advertised and the user debugs a protocol error instead of reading
        // the reason.
        assertWireCapability(
          support,
          "toolCalls",
          "The server did not declare `capabilities.tasks.requests` for " +
            "`tools/call`, so it cannot turn this call into a task.",
        );

        if (options.taskTtl !== undefined && support.wire !== "legacy") {
          throw usageError(
            "--task-ttl applies only to the 2025-11-25 tasks wire. This " +
              "server resolved to the extension wire, where the server owns " +
              "the TTL and a client cannot set one.",
          );
        }

        return withWatchSignals(async (signal) => {
        // Exactly one of the two opt-ins is ever set: the legacy in-params
        // augmentation, or the extension's per-call declaration that this
        // client can handle a `CreateTaskResult`.
        //
        // They go in through DIFFERENT parameters, and this is not stylistic.
        // `executeTool`'s fourth argument is discriminated at runtime on the
        // presence of `request`/`retry`/`allowTaskResult` — `task` is not in
        // that set, so `{ task: … }` passed there is silently read as
        // `ClientRequestOptions` and the augmentation never reaches the wire.
        // The legacy opt-in must use the dedicated fifth parameter, the same
        // way the Inspector's own tools route does.
        //
        // Both branches carry the watch's `signal` so a hung creation can be
        // interrupted at all — but forwarding it means an interrupt now REJECTS
        // the in-flight request instead of hanging, and that rejection has to
        // be translated. Left to propagate it would surface as a generic
        // `INTERNAL_ERROR` exit 1, contradicting the documented `aborted`
        // outcome for exactly the case the signal was plumbed in to serve.
        let result: unknown;
        try {
          result =
            support.wire === "legacy"
              ? await manager.executeTool(
                  serverId,
                  toolName,
                  params,
                  { signal },
                  options.taskTtl !== undefined ? { ttl: options.taskTtl } : {},
                )
              : await manager.executeTool(serverId, toolName, params, {
                  allowTaskResult: true,
                  request: { signal },
                });
        } catch (error) {
          if (!signal.aborted) throw error;
          // No task exists yet, so there is no watch envelope to report and no
          // task id to name. `phase` says where the interrupt landed.
          return {
            aborted: { wire: support.wire, phase: "create" as const },
            created: null,
            result: null,
          };
        }

        const created = detectCreatedTask(support.wire, result);
        if (!created) {
          // "No task" means different things per wire, and reporting the
          // extension's meaning on the legacy wire would hide a broken server.
          //
          // Extension: a server may decide any given call is cheap enough to
          // answer synchronously, and `unwrapCreatedTaskExt` hands back the
          // plain result. Legal, so say so and return it.
          //
          // Legacy: a synchronous answer never reaches here at all — the SDK
          // throws unless `isCreateTaskResult` holds. But that guard checks
          // only that `task.taskId` is a string, so a `CreateTaskResult` with
          // no `status` passes it and then fails our own check. On this wire
          // `null` therefore has exactly one cause: a nonconforming task. Exit
          // 0 with "answered synchronously" would be a plain lie.
          if (support.wire === "legacy") {
            throw cliError(
              "TASK_MALFORMED",
              `Server returned a task-augmented result for ${toolName} that ` +
                "is not a usable task: the 2025-11-25 `CreateTaskResult` " +
                "requires a `taskId` and a `status` of `working`, " +
                "`input_required`, `completed`, `failed`, or `cancelled`.",
              1,
              { wire: support.wire, result },
            );
          }

          note(
            `No task materialized: the server answered ${toolName} ` +
              "synchronously. Returning the tool result as-is.",
          );
          return { aborted: null, created: null, result };
        }

        if (!options.taskWatch) {
          return { aborted: null, created, result: null };
        }

        const taskId = created.task.taskId;
        const watch = await driveTaskWatch({
          manager,
          serverId,
          support,
          taskId,
          tuning: taskWatchTuningFrom(options),
          ...(input ? { input } : {}),
          signal,
          ...(onState ? { onState } : {}),
        });
        return { aborted: null, created, watch, result: null };
        });
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        host: host?.connection,
        ...(options.interactive
          ? {
              beforeConnect: buildMrtrBeforeConnect(options),
              interactiveElicitation: true,
            }
          : {}),
      },
    );

  let envelope: Awaited<ReturnType<typeof run>>;
  try {
    envelope = await run();
  } catch (error) {
    await writeArtifact({ status: "error", error });
    throw error;
  }

  const payload = envelope.aborted
    ? { status: "aborted", ...envelope.aborted }
    : envelope.created
      ? envelope.watch
        ? { created: envelope.created, watch: envelope.watch }
        : envelope.created
      : envelope.result;

  // The extension server declined to create a task and answered synchronously.
  // That answer is an ordinary tool result, so it keeps the ordinary contract:
  // plain `tools call` exits 1 on `isError: true`, and adding `--task` — an
  // invitation the server turned down — must not silently soften that. The
  // 0-on-`isError` rule is for a COMPLETED TASK, where the error rides in the
  // watch envelope.
  const syncToolResultError =
    !envelope.aborted &&
    !envelope.created &&
    isCallToolResultError(envelope.result as never);

  // An interrupt is 130 wherever it lands, so a caller reads the same code
  // whether the signal arrived during creation or mid-watch.
  const exitCode = envelope.aborted
    ? 130
    : envelope.watch
      ? taskWatchExitCode(envelope.watch.outcome)
      : syncToolResultError
        ? 1
        : 0;

  // A watch that ended anywhere but `completed` is an error outcome for the
  // artifact, even though the command itself ran correctly — the artifact
  // records what happened to the task, not to the process.
  await writeArtifact(
    exitCode === 0
      ? { status: "success", result: payload }
      : envelope.aborted
        ? {
            status: "error",
            result: payload,
            error: {
              code: "task_aborted",
              message: `Interrupted during task ${envelope.aborted.phase}.`,
            },
          }
        : syncToolResultError
          ? {
              // Same code the plain path stamps for `isError: true`: the task
              // machinery was a bystander here, so the artifact must not
              // suggest a task outcome that never existed.
              status: "error",
              result: payload,
              error: {
                code: "tool_result_error",
                message: "Tool returned an error result.",
              },
            }
          : {
              status: "error",
              result: payload,
              error: {
                code: `task_${envelope.watch?.outcome ?? "unknown"}`,
                message: `Task watch ended with outcome "${envelope.watch?.outcome}".`,
              },
            },
  );

  writeResult(
    withRpcLogsIfRequested(payload, collector, globalOptions),
    globalOptions.format,
  );

  if (exitCode !== 0) setProcessExitCode(exitCode);
}

export function registerToolsCommands(program: Command): void {
  const tools = program
    .command("tools")
    .description("List and invoke MCP server tools");

  addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        addConformanceOptions(
          tools
            .command("list")
            .description("List tools exposed by an MCP server")
            .option("--cursor <cursor>", "Pagination cursor")
            .option("--model-id <model>", "Model id used for token counting"),
        ),
      ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = {
      ...parseServerConfig({
        ...options,
        timeout: globalOptions.timeout,
      }),
      ...conformanceConfigFromOptions(options),
    } as MCPServerConfig;

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        const listed = await listToolsWithMetadata(manager, {
          serverId,
          cursor: options.cursor,
          modelId: options.modelId,
        });
        if (!host) return listed;
        // As a host: drop tools its model can't see (app-only) and report it.
        // Scope the SIBLING metadata + token count to the visible set too, so
        // `tools list --host` is consistently host-scoped (no app-only leak via
        // toolsMetadata/tokenCount).
        const { tools: visibleTools, toolsDroppedVisibility } =
          applyHostVisibility(
            listed.tools as Array<Record<string, unknown>>,
            manager,
            serverId,
            host.policy,
          );
        const visibleNames = new Set(
          visibleTools.map((tool) => String(tool.name)),
        );
        return {
          ...listed,
          tools: visibleTools,
          toolsMetadata: Object.fromEntries(
            Object.entries(listed.toolsMetadata).filter(([name]) =>
              visibleNames.has(name),
            ),
          ),
          ...(listed.tokenCount === undefined
            ? {}
            : { tokenCount: estimateTokensFromChars(JSON.stringify(visibleTools)) }),
          host: host.id,
          toolsDroppedVisibility,
        };
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
        host: host?.connection,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addHostOption(
    addSharedServerOptions(
    addTaskWatchTuningOptions(
    addConformanceOptions(
    tools
      .command("call")
      .description("Call an MCP tool")
      .option("--tool-name <tool>", "Tool name")
      .option("--name <tool>", "Alias for --tool-name")
      .option(
        "--interactive",
        "Drive the modern input_required (multi-round-trip) loop: render embedded elicitations to the terminal and collect responses from stdin",
      )
      .option(
        "--yes",
        "With --interactive, run non-interactively: decline every embedded input request instead of prompting",
      )
      .option(
        "--tool-args <json>",
        "Tool parameter object as JSON, @path, or - for stdin",
      )
      .option("--params <json>", "Alias for --tool-args")
      .option("--tool-args-stdin", "Read tool parameter JSON from stdin")
      .option(
        "--no-param-headers",
        "Do NOT mirror x-mcp-header tool arguments into Mcp-Param-* request headers (SEP-2243). Calls the tool as a client that has not implemented the mirroring — a conforming 2026-07-28 server should answer -32020 HeaderMismatch.",
      )
      .option(
        "--mcp-header <Name=Value>",
        "Send a raw MCP request header on the tools/call. Repeat for several. Use it to reproduce a header mismatch on purpose. Supplying any Mcp-Param-* header turns OFF the automatic mirroring for that call, so the headers you pass are the only Mcp-Param-* ones sent.",
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--validate-response",
        "Validate the MCP tool-call envelope returned by the server",
      )
      .option(
        "--expect-success",
        "Evaluate the tool-call outcome policy against isError",
      )
      .option(
        "--reporter <reporter>",
        "Structured reporter output: json-summary, junit-xml, or html",
      )
      .option(
        "--debug-out <path>",
        "Write a structured debug artifact to a file",
      )
      .option(
        "--ui",
        "Render the tool result in Inspector Playground; opens a browser by default in a TTY",
      )
      .option(
        "--require-render",
        "Treat skipped Inspector renders as errors (with --ui)",
      )
      .option(
        "--open",
        "Open Inspector in the system browser before rendering (default with --ui in a TTY)",
      )
      .option(
        "--no-open",
        "Start/use Inspector without opening a system browser",
      )
      .option(
        "--attach-only",
        "Require an already-running Inspector browser client; do not start or open Inspector",
      )
      .option("--inspector-url <url>", "Local Inspector base URL (with --ui)")
      .option(
        "--frontend-url <url>",
        "Inspector frontend URL (with --ui; overrides health-advertised frontend and skips discovery)",
      )
      .option(
        "--server-name <name>",
        "Server name inside Inspector (with --ui)",
      )
      .option(
        "--protocol <protocol>",
        'Render protocol: "mcp-apps" or "openai-sdk" (with --ui)',
      )
      .option(
        "--device <device>",
        'Render device: "mobile", "tablet", "desktop", or "custom" (with --ui)',
      )
      .option("--theme <theme>", 'Render theme: "light" or "dark" (with --ui)')
      .option("--locale <locale>", "Render locale (with --ui)")
      .option("--time-zone <iana>", "Render IANA timezone (with --ui)")
      .option(
        "--task",
        "Invite the server to answer with a task instead of a result. Uses whichever tasks wire the connection resolves to.",
      )
      .option(
        "--task-ttl <ms>",
        "Requested task TTL (2025-11-25 wire only; the extension server owns its TTL). Requires --task.",
        (value: string) => parsePositiveInteger(value, "Task TTL"),
      )
      .option(
        "--task-watch",
        "After creating the task, poll it to a terminal status in the same connection. Requires --task.",
      )
      .option(
        "--wire <wire>",
        "Assert the connection resolves to this tasks wire: legacy or extension (with --task)",
        parseTasksWireOption,
      ),
    ),
    ),
    ),
  ).action(async (options: ToolsCallOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const host = resolveHostFromOptions(options);
    const target = describeTarget(options);
    const primaryCollector =
      globalOptions.rpc || options.debugOut
        ? createCliRpcLogCollector({ __cli__: target })
        : undefined;
    const snapshotCollector = options.debugOut
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const baseConfig = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
    const mcpHeaders = parseMcpHeaderOption(options.mcpHeader);
    // A `Mcp-Param-*` override has to SUPPRESS the mirroring to take effect.
    // Upstream `callTool` merges `{ ...options.headers, ...paramHeaders }` —
    // the mirrored value wins — so a caller-supplied `Mcp-Param-Region=wrong`
    // would be silently overwritten by the correct one and the -32020 this
    // flag exists to provoke would never happen. (The MRTR path spreads caller
    // headers last and would have honored it; the plain path is the default,
    // so relying on that would make the flag work only under --interactive.)
    //
    // With mirroring off, the supplied headers are the ONLY `Mcp-Param-*` on
    // the request — which is the honest contract for an override flag, and is
    // what `--mcp-header`'s help text promises.
    const overridesParamHeader = Object.keys(mcpHeaders ?? {}).some(
      // The SDK's classifier, not a local prefix literal — "what counts as a
      // mirrored param header" has one definition and it lives on the wire.
      (name) => classifyMcpHeader(name) === "param",
    );
    const suppressParamHeaders =
      options.paramHeaders === false || overridesParamHeader;
    const headerDebugging =
      suppressParamHeaders || mcpHeaders !== undefined || globalOptions.rpc;
    if ((suppressParamHeaders || mcpHeaders) && !("url" in baseConfig)) {
      // stdio never reaches a fetch, so neither flag can do anything there.
      // Refusing beats running a call that silently ignores what was asked.
      throw usageError(
        "--no-param-headers and --mcp-header apply to HTTP servers only (SEP-2243 mirroring is Streamable HTTP); they cannot be used with --command.",
      );
    }
    const paramHeaderProbe = headerDebugging
      ? createMcpParamHeaderProbe()
      : undefined;
    const config: MCPServerConfig = {
      ...baseConfig,
      ...(suppressParamHeaders ? { mirrorToolParamHeaders: false } : {}),
      ...conformanceConfigFromOptions(options),
      ...(paramHeaderProbe ? { httpLogger: paramHeaderProbe.httpLogger } : {}),
    } as MCPServerConfig;
    const reporter = parseReporterFormat(options.reporter);
    const toolName = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolName", flag: "--tool-name" },
        { key: "name", flag: "--name" },
      ],
      "Tool name",
      { required: true },
    ) as string;
    const resolvedParamsInput = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolArgs", flag: "--tool-args" },
        { key: "params", flag: "--params" },
      ],
      "Tool parameters",
    );
    if (options.toolArgsStdin && resolvedParamsInput !== undefined) {
      throw usageError(
        "--tool-args-stdin cannot be used together with --tool-args or --params.",
      );
    }
    const paramsInput = options.toolArgsStdin ? "-" : resolvedParamsInput;
    if (options.interactive && paramsInput === "-") {
      // Both would read `process.stdin`: the JSON parse drains it first, so the
      // collector would hit EOF (or, on a TTY, a stream the user already closed)
      // and could never answer an embedded elicitation.
      throw usageError(
        "--interactive cannot be used together with tool parameters read from " +
          "stdin (--tool-args-stdin or --tool-args/--params -): interactive " +
          "answers are read from stdin too. Pass the parameters as JSON or @path.",
      );
    }
    const params = parseJsonRecord(paramsInput, "Tool parameters") ?? {};
    const targetSummary = summarizeServerDoctorTarget(target, config);
    const shouldValidateResponse = options.validateResponse === true;
    const shouldExpectSuccess = options.expectSuccess === true;

    if (options.ui && reporter) {
      throw usageError("--ui cannot be used together with --reporter.");
    }
    if (options.requireRender && !options.ui) {
      throw usageError("--require-render requires --ui.");
    }
    if (options.attachOnly && options.open === true) {
      throw usageError("--attach-only cannot be used together with --open.");
    }

    if (reporter && !shouldValidateResponse && !shouldExpectSuccess) {
      throw usageError(
        "--reporter requires --validate-response and/or --expect-success.",
      );
    }

    // `--mcp-header` rides `executeTool`'s request options, which the
    // task-augmented path does not thread (its two wire branches build their
    // own request shapes). Refusing beats accepting a flag that would be
    // silently dropped — the whole point of the flag is to make the request
    // wrong ON PURPOSE, so a silently-ignored one would produce a passing call
    // that looks like it disproved the mismatch. `--no-param-headers` is NOT
    // refused: it lives on the server config, so it applies on both paths.
    if (options.task && mcpHeaders) {
      throw usageError(
        "--mcp-header cannot be used together with --task: the task-augmented " +
          "call path does not carry per-request headers. Drop --task to " +
          "reproduce a header mismatch, or drop --mcp-header.",
      );
    }

    // Every task-only flag is refused without its enabling flag. Accepting one
    // silently would let a misspelled or half-finished task invocation run an
    // ordinary tool call that looks like it worked.
    const watchTuningFlags = [
      ["--duration-ms", options.durationMs],
      ["--poll-interval-ms", options.pollIntervalMs],
      ["--max-input-rounds", options.maxInputRounds],
      ["--max-consecutive-errors", options.maxConsecutiveErrors],
    ] as const;

    if (!options.task) {
      if (options.taskTtl !== undefined) {
        throw usageError("--task-ttl requires --task.");
      }
      if (options.taskWatch) throw usageError("--task-watch requires --task.");
      if (options.wire !== undefined) {
        throw usageError("--wire requires --task.");
      }
      for (const [flag, value] of watchTuningFlags) {
        if (value !== undefined) {
          throw usageError(`${flag} requires --task --task-watch.`);
        }
      }
    } else {
      if (!options.taskWatch) {
        for (const [flag, value] of watchTuningFlags) {
          if (value !== undefined) {
            throw usageError(
              `${flag} tunes the watch loop, so it requires --task-watch.`,
            );
          }
        }
      }
      // A `task_created` envelope is not a `CallToolResult`, and the renderers
      // and validators all assume one. Refusing beats emitting a validation
      // failure that says nothing about the real mistake.
      if (options.ui) {
        throw usageError("--task cannot be used together with --ui.");
      }
      if (reporter) {
        throw usageError("--task cannot be used together with --reporter.");
      }
      if (shouldValidateResponse || shouldExpectSuccess) {
        throw usageError(
          "--task cannot be used together with --validate-response or " +
            "--expect-success: a task-creation envelope is not a tool result. " +
            "Validate the result of `tasks watch` instead.",
        );
      }

      try {
        await runTaskAugmentedToolCall({
          options,
          globalOptions,
          // Carries `mirrorToolParamHeaders` and the mirrored-header probe,
          // both of which live on the config and therefore apply here too.
          config,
          host,
          toolName,
          params,
          collector: primaryCollector,
          targetSummary,
          snapshotCollector,
        });
      } finally {
        // In a `finally`, not after: the -32020 this flag exists to provoke
        // makes the call THROW, and "which headers actually went out" is
        // exactly the diagnostic a reader needs on that path.
        reportMirroredParamHeaders(paramHeaderProbe, globalOptions);
      }
      return;
    }

    const renderContext = options.ui
      ? {
          protocol: parseRenderProtocol(options.protocol),
          deviceType: parseRenderDevice(options.device),
          theme: parseRenderTheme(options.theme),
          locale: trimOptional(options.locale),
          timeZone: trimOptional(options.timeZone),
        }
      : undefined;
    const frontendUrl = options.ui
      ? parseInspectorFrontendUrl(options.frontendUrl)
      : undefined;

    let result: unknown;
    let commandError: unknown;
    const startedAt = Date.now();
    // The TOOL CALL only — not connect, not the host visibility probe. This is
    // what `_durationMs` reports, so it means the same thing as `durationMs` on
    // `POST /v1/.../tools/call`; two fields that near-share a name must not
    // measure different windows. The reporter keeps the end-to-end clock below,
    // which is what a JUnit case duration is expected to cover.
    let toolCallDurationMs = 0;

    try {
      result = await withEphemeralManager(
        config,
        async (manager, serverId) => {
          // As a host: an app-only tool isn't callable by that host's model.
          if (host) await assertToolVisibleToHost(manager, serverId, toolName, host);
          const toolStartedAt = Date.now();
          try {
            return await manager.executeTool(
              serverId,
              toolName,
              params,
              // Caller-supplied headers WIN over the mirrored ones (the seam in
              // `MCPClientManager`), which is the whole point of `--mcp-header`:
              // sending a deliberately wrong value is how you exercise a
              // server's -32020.
              mcpHeaders ? { headers: mcpHeaders } : undefined,
            );
          } finally {
            toolCallDurationMs = Math.max(0, Date.now() - toolStartedAt);
          }
        },
        {
          timeout: globalOptions.timeout,
          rpcLogger: primaryCollector?.rpcLogger,
          host: host?.connection,
          beforeConnect: buildMrtrBeforeConnect(options),
          interactiveElicitation: options.interactive === true,
        },
      );
    } catch (error) {
      commandError = error;
    }
    // Stop the clock at tool-call completion so the reporter's `durationMs`
    // does not include validation, Inspector render, or debug I/O. This one is
    // end-to-end (connect + call); `toolCallDurationMs` above is the call.
    const durationMs = Math.max(0, Date.now() - startedAt);

    if (commandError) {
      await writeCommandDebugArtifact({
        outputPath: options.debugOut,
        format: globalOptions.format,
        quiet: globalOptions.quiet,
        commandName: "tools call",
        commandInput: {
          toolName,
          params,
        },
        target: targetSummary,
        outcome: {
          status: "error",
          error: commandError,
        },
        snapshot: options.debugOut
          ? {
              input: {
                config,
                target: targetSummary,
                timeout: globalOptions.timeout,
              },
              collector: snapshotCollector,
            }
          : undefined,
        collectors: [primaryCollector],
      });
      // Printed on the FAILURE path too — arguably especially there. The whole
      // reason to reach for these flags is a -32020, and "which headers
      // actually went out" is the fact that explains it.
      reportMirroredParamHeaders(paramHeaderProbe, globalOptions);
      throw commandError;
    }

    const validationResult =
      shouldValidateResponse || shouldExpectSuccess
        ? validateToolCallResult(result, {
            envelope: shouldValidateResponse,
            outcome: shouldExpectSuccess ? { failOnIsError: true } : undefined,
          })
        : undefined;
    const validationFailed = Boolean(
      validationResult && !validationResult.passed,
    );
    const toolResultError = isCallToolResultError(result);
    const resultWithDuration = attachCliDurationMs(result, toolCallDurationMs);

    let outputPayload = resultWithDuration;
    let debugOutputPayload: unknown = outputPayload;
    let inspectorRenderError:
      | { code: string; message: string; details?: unknown }
      | undefined;
    let inspectorRenderSkipped = false;
    let inspectorRenderIssue: InspectorRenderIssue | undefined;
    const requireRender = options.requireRender === true;

    if (options.ui) {
      const serverName =
        typeof options.serverName === "string" && options.serverName.trim()
          ? options.serverName.trim()
          : buildInspectorServerName(options);
      const openBrowser = resolveInspectorOpenBrowser(options);
      const skipDiscovery = resolveInspectorSkipDiscovery(
        options,
        globalOptions,
        { openBrowser },
      );
      let uiResult: Record<string, unknown>;

      try {
        uiResult = await runUiRender({
          baseUrl: options.inspectorUrl,
          config,
          frontendUrl,
          onProgress: createInspectorUiProgressReporter({
            enabled: openBrowser && !globalOptions.quiet,
            stderrIsTTY: resolveInspectorUiStderrIsTTY(),
          }),
          heartbeatEnabled: resolveInspectorUiStderrIsTTY(),
          openBrowser,
          params,
          renderContext: renderContext!,
          skipDiscovery,
          serverName,
          startIfNeeded: resolveInspectorStartIfNeeded(options),
          timeoutMs: globalOptions.timeout,
          toolName,
          toolResult: result,
        });
        inspectorRenderError = findInspectorRenderError(uiResult);
      } catch (error) {
        inspectorRenderError = toStructuredError(
          normalizeCliError(error),
        ).error;
        uiResult = {
          status: "error",
          error: inspectorRenderError,
          ...extractInspectorRenderErrorUrls(inspectorRenderError),
        };
      }

      const inspectorRenderClassification = classifyInspectorRenderError(
        inspectorRenderError,
        {
          noActiveClientIsSkippable: options.attachOnly !== true,
        },
      );
      inspectorRenderSkipped = inspectorRenderClassification.skippable;
      inspectorRenderIssue = buildInspectorRenderIssue(
        inspectorRenderError,
        uiResult,
        inspectorRenderClassification,
      );
      const compactInspectorRender = buildCompactInspectorRender(uiResult, {
        skipped: inspectorRenderSkipped,
        remediation: inspectorRenderClassification.remediation,
        issue: inspectorRenderIssue,
      });
      const renderFailure =
        inspectorRenderError &&
        (!inspectorRenderSkipped || requireRender);
      const compactOutputPayload = {
        success:
          !renderFailure &&
          !validationFailed &&
          !toolResultError,
        command: "tools call",
        inspectorUi: true,
        ...(typeof compactInspectorRender.browserUrl === "string"
          ? { inspectorBrowserUrl: compactInspectorRender.browserUrl }
          : {}),
        ...(typeof compactInspectorRender.frontendUrl === "string"
          ? { inspectorFrontendUrl: compactInspectorRender.frontendUrl }
          : {}),
        target,
        toolName,
        parameterKeys: Object.keys(params),
        result: resultWithDuration,
        inspectorRender: compactInspectorRender,
        ...(inspectorRenderError
          ? inspectorRenderSkipped && !requireRender
            ? { warning: inspectorRenderIssue ?? inspectorRenderError }
            : { error: inspectorRenderIssue ?? inspectorRenderError }
          : {}),
      };
      outputPayload = compactOutputPayload;
      debugOutputPayload = {
        ...compactOutputPayload,
        params,
        inspectorRender: uiResult,
      };

      writeInspectorRenderWarning({
        issue: inspectorRenderIssue,
        globalOptions,
        render: compactInspectorRender,
        required: requireRender,
        skipped: inspectorRenderSkipped,
      });
    }

    const renderIsFailure = Boolean(
      inspectorRenderError && (!inspectorRenderSkipped || requireRender),
    );
    const debugOutcomeError = renderIsFailure
      ? (inspectorRenderIssue ?? inspectorRenderError)
      : validationFailed
        ? {
            code: "validation_failed",
            message: "Tool call validation failed.",
            details: validationResult,
          }
        : toolResultError
          ? {
              code: "tool_result_error",
              message: "Tool returned an error result.",
            }
          : undefined;

    await writeCommandDebugArtifact({
      outputPath: options.debugOut,
      format: globalOptions.format,
      quiet: globalOptions.quiet,
      commandName: "tools call",
      commandInput: {
        toolName,
        params,
      },
      target: targetSummary,
      outcome: debugOutcomeError
        ? {
            status: "error",
            error: debugOutcomeError,
            result: debugOutputPayload,
          }
        : {
            status: "success",
            result: debugOutputPayload,
          },
      snapshot: options.debugOut
        ? {
            input: {
              config,
              target: targetSummary,
              timeout: globalOptions.timeout,
            },
            collector: snapshotCollector,
          }
        : undefined,
      collectors: [primaryCollector],
    });

    if (reporter) {
      writeReporterResult(
        reporter,
        buildToolCallValidationReport(validationResult!, {
          durationMs,
          rawResult: result,
          metadata: {
            toolName,
          },
        }),
      );
    } else {
      writeResult(
        withRpcLogsIfRequested(
          outputPayload,
          primaryCollector,
          globalOptions,
        ),
        globalOptions.format,
      );
    }
    reportMirroredParamHeaders(paramHeaderProbe, globalOptions);

    if (validationResult && !validationResult.passed) {
      setProcessExitCode(1);
    }
    if (toolResultError) {
      setProcessExitCode(1);
    }
    if (inspectorRenderError && (!inspectorRenderSkipped || requireRender)) {
      setProcessExitCode(1);
    }
  });
}

type InspectorRenderRemediation =
  | "open_browser"
  | "retry"
  | "reconnect_server"
  | "none";

type InspectorRenderSkippableCode =
  | "no_active_client"
  | "timeout"
  | "disconnected_server"
  | "unsupported_in_mode";

type InspectorRenderIssue = {
  code: InspectorRenderSkippableCode;
  message: string;
  remediation: InspectorRenderRemediation;
  browserUrl?: string;
  hasActiveClient?: boolean;
  inspectorStarted?: boolean;
};

type InspectorRenderErrorClassification =
  {
    skippable: boolean;
    remediation: InspectorRenderRemediation;
    code?: InspectorRenderSkippableCode;
  };

function parseInspectorUiTtyOverride(name: string): boolean | undefined {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return undefined;
}

function resolveInspectorUiStdoutIsTTY(): boolean {
  return (
    parseInspectorUiTtyOverride("MCPJAM_CLI_TEST_STDOUT_TTY") ??
    Boolean(process.stdout.isTTY)
  );
}

function resolveInspectorUiStderrIsTTY(): boolean {
  return (
    parseInspectorUiTtyOverride("MCPJAM_CLI_TEST_STDERR_TTY") ??
    Boolean(process.stderr.isTTY)
  );
}

export function resolveInspectorOpenBrowser(
  options: Pick<ToolsCallOptions, "attachOnly" | "open">,
  environment: { stdoutIsTTY?: boolean } = {},
): boolean {
  const stdoutIsTTY =
    environment.stdoutIsTTY ?? resolveInspectorUiStdoutIsTTY();
  if (options.attachOnly) {
    return false;
  }
  if (options.open !== undefined) {
    return options.open;
  }
  return stdoutIsTTY;
}

export function resolveInspectorSkipDiscovery(
  options: Pick<ToolsCallOptions, "attachOnly" | "frontendUrl" | "open">,
  globalOptions: GlobalOptions,
  environment: { openBrowser?: boolean; stdoutIsTTY?: boolean } = {},
): boolean {
  const stdoutIsTTY =
    environment.stdoutIsTTY ?? resolveInspectorUiStdoutIsTTY();
  const openBrowser =
    environment.openBrowser ?? resolveInspectorOpenBrowser(options, { stdoutIsTTY });
  if (typeof options.frontendUrl === "string" && options.frontendUrl.trim()) {
    return true;
  }
  if (options.attachOnly) {
    return true;
  }
  if (openBrowser) {
    return false;
  }
  if (options.open === undefined && !stdoutIsTTY) {
    return true;
  }
  if (options.open === false && (globalOptions.format === "json" || globalOptions.quiet)) {
    return true;
  }
  return false;
}

export function resolveInspectorStartIfNeeded(options: {
  attachOnly?: boolean;
  open?: boolean;
}): boolean {
  return options.attachOnly !== true;
}

function extractInspectorRenderErrorUrls(error: {
  details?: unknown;
}): Record<string, unknown> {
  if (!error.details || typeof error.details !== "object") {
    return {};
  }

  const details = error.details as Record<string, unknown>;
  return {
    ...(typeof details.inspectorBrowserUrl === "string"
      ? { browserUrl: details.inspectorBrowserUrl }
      : {}),
    ...(typeof details.inspectorFrontendUrl === "string"
      ? { frontendUrl: details.inspectorFrontendUrl }
      : {}),
    ...(typeof details.inspectorStarted === "boolean"
      ? { inspectorStarted: details.inspectorStarted }
      : {}),
    ...(typeof details.hasActiveClient === "boolean"
      ? { hasActiveClient: details.hasActiveClient }
      : {}),
  };
}

function createInspectorUiProgressReporter(options: {
  enabled: boolean;
  stderrIsTTY: boolean;
}): ((message: string) => void) | undefined {
  if (!options.enabled) {
    return undefined;
  }

  let lastMessage = "";
  return (message: string) => {
    if (!message || message === lastMessage) {
      return;
    }
    if (!options.stderrIsTTY && /\(\d+s\)$/.test(message)) {
      return;
    }
    lastMessage = message;
    process.stderr.write(`${message}\n`);
  };
}

function writeInspectorRenderWarning(options: {
  issue: InspectorRenderIssue | undefined;
  globalOptions: Pick<GlobalOptions, "quiet">;
  render: Record<string, unknown>;
  required: boolean;
  skipped: boolean;
}): void {
  if (!options.skipped || !options.issue || options.globalOptions.quiet) {
    return;
  }

  process.stderr.write(
    `${options.required ? "Error" : "Warning"}: Inspector UI render ${
      options.required ? "required but " : ""
    }skipped: ${options.issue.message}\n`,
  );

  if (options.issue.code !== "no_active_client") {
    return;
  }

  const browserUrl =
    typeof options.render.browserUrl === "string"
      ? options.render.browserUrl
      : undefined;
  process.stderr.write(
    `Tip: open the Inspector Playground${browserUrl ? ` at ${browserUrl}` : ""}, or rerun without --no-open or with --open to launch a browser automatically.\n`,
  );
}

function classifyInspectorRenderError(
  error: { code: string; message: string } | undefined,
  options: { noActiveClientIsSkippable?: boolean } = {},
): InspectorRenderErrorClassification {
  if (!error) {
    return { skippable: false, remediation: "none" };
  }

  const noActiveClientIsSkippable = options.noActiveClientIsSkippable ?? true;
  const code = error.code.toLowerCase();
  if (code === "no_active_client" || isNoActiveClientMessage(error)) {
    return {
      skippable: noActiveClientIsSkippable,
      code: "no_active_client",
      remediation: "open_browser",
    };
  }
  if (code === "timeout") {
    return {
      skippable: true,
      code: "timeout",
      remediation: "retry",
    };
  }
  if (code === "disconnected_server") {
    return {
      skippable: true,
      code: "disconnected_server",
      remediation: "reconnect_server",
    };
  }
  if (code === "unsupported_in_mode") {
    return {
      skippable: true,
      code: "unsupported_in_mode",
      remediation: "none",
    };
  }

  return { skippable: false, remediation: "none" };
}

function buildInspectorRenderIssue(
  error: { code: string; message: string } | undefined,
  render: Record<string, unknown>,
  classification: InspectorRenderErrorClassification,
): InspectorRenderIssue | undefined {
  if (!error || !classification.code) {
    return undefined;
  }

  return {
    code: classification.code,
    message: error.message,
    remediation: classification.remediation,
    ...(typeof render.browserUrl === "string"
      ? { browserUrl: render.browserUrl }
      : {}),
    ...(typeof render.hasActiveClient === "boolean"
      ? { hasActiveClient: render.hasActiveClient }
      : {}),
    ...(typeof render.inspectorStarted === "boolean"
      ? { inspectorStarted: render.inspectorStarted }
      : {}),
  };
}

function isNoActiveClientMessage(error: { code: string; message: string }) {
  return (
    error.code.toLowerCase() === "no_active_client" ||
    /no active (browser )?client/i.test(error.message)
  );
}

function buildCompactInspectorRender(
  uiResult: Record<string, unknown>,
  options: {
    skipped?: boolean;
    remediation?: InspectorRenderRemediation;
    issue?: InspectorRenderIssue;
  } = {},
): Record<string, unknown> {
  const commands: Record<string, unknown> = {};
  let hasCommandError = false;

  for (const [commandName, commandValue] of Object.entries(uiResult)) {
    const response = compactInspectorCommandResponse(commandValue);
    if (!response) {
      continue;
    }
    commands[commandName] = response;
    if (response.status === "error") {
      hasCommandError = true;
    }
  }

  const topLevelError = options.skipped
    ? options.issue
      ? { warning: options.issue }
      : uiResult.status === "error" && isRecord(uiResult.error)
        ? { warning: uiResult.error }
        : {}
    : options.issue
      ? { error: options.issue }
      : uiResult.status === "error" && isRecord(uiResult.error)
        ? { error: uiResult.error }
        : {};

  return {
    status:
      options.skipped
        ? "skipped"
        : hasCommandError || uiResult.status === "error"
          ? "error"
          : "rendered",
    remediation: options.remediation ?? "none",
    // Contract metadata: renders target the active client and fresh tabs do not
    // hydrate this injected state.
    mode: "active-client",
    urlHydratesRender: false,
    ...(typeof uiResult.baseUrl === "string"
      ? { baseUrl: uiResult.baseUrl }
      : {}),
    ...(typeof uiResult.browserUrl === "string"
      ? { browserUrl: uiResult.browserUrl }
      : {}),
    ...(typeof uiResult.frontendUrl === "string"
      ? { frontendUrl: uiResult.frontendUrl }
      : {}),
    ...(typeof uiResult.inspectorStarted === "boolean"
      ? { inspectorStarted: uiResult.inspectorStarted }
      : {}),
    ...(typeof uiResult.browserOpenRequested === "boolean"
      ? { browserOpenRequested: uiResult.browserOpenRequested }
      : {}),
    ...(typeof uiResult.hasActiveClient === "boolean"
      ? { hasActiveClient: uiResult.hasActiveClient }
      : {}),
    ...(Object.keys(commands).length > 0 ? { commands } : {}),
    ...topLevelError,
  };
}

function parseInspectorFrontendUrl(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const frontendUrl = normalizeInspectorFrontendUrl(value);
  if (!frontendUrl) {
    throw usageError(`Invalid --frontend-url "${value}".`);
  }
  return frontendUrl;
}

type CompactInspectorCommandStatus = "success" | "error";

function compactInspectorCommandResponse(
  value: unknown,
): { status: CompactInspectorCommandStatus; error?: unknown } | undefined {
  if (!isRecord(value) || !isCompactInspectorCommandStatus(value.status)) {
    return undefined;
  }
  return {
    status: value.status,
    ...(value.status === "error" && isRecord(value.error)
      ? { error: value.error }
      : {}),
  };
}

function isCompactInspectorCommandStatus(
  value: unknown,
): value is CompactInspectorCommandStatus {
  return value === "success" || value === "error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
