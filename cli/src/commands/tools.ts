import { Command } from "commander";
import {
  buildToolCallValidationReport,
  isCallToolResultError,
  validateToolCallResult,
} from "@mcpjam/sdk";
import { writeCommandDebugArtifact } from "../lib/debug-artifact.js";
import { withEphemeralManager } from "../lib/ephemeral.js";
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
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import { normalizeInspectorFrontendUrl } from "../lib/inspector-api.js";
import { listToolsWithMetadata } from "../lib/server-ops.js";
import { summarizeServerDoctorTarget } from "../lib/server-doctor.js";
import {
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parseRetryPolicy,
  parseServerConfig,
  resolveAliasedStringOption,
  type GlobalOptions,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import {
  normalizeCliError,
  setProcessExitCode,
  toStructuredError,
  usageError,
  writeResult,
} from "../lib/output.js";

interface ToolsCallOptions extends SharedServerTargetOptions {
  toolName?: string;
  name?: string;
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
}

export function registerToolsCommands(program: Command): void {
  const tools = program
    .command("tools")
    .description("List and invoke MCP server tools");

  addRetryOptions(
    addSharedServerOptions(
      tools
        .command("list")
        .description("List tools exposed by an MCP server")
        .option("--cursor <cursor>", "Pagination cursor")
        .option("--model-id <model>", "Model id used for token counting"),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      (manager, serverId) =>
        listToolsWithMetadata(manager, {
          serverId,
          cursor: options.cursor,
          modelId: options.modelId,
        }),
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
      },
    );

    writeResult(
      withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addSharedServerOptions(
    tools
      .command("call")
      .description("Call an MCP tool")
      .option("--tool-name <tool>", "Tool name")
      .option("--name <tool>", "Alias for --tool-name")
      .option(
        "--tool-args <json>",
        "Tool parameter object as JSON, @path, or - for stdin",
      )
      .option("--params <json>", "Alias for --tool-args")
      .option("--tool-args-stdin", "Read tool parameter JSON from stdin")
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
        "Structured reporter output: json-summary or junit-xml",
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
      .option("--time-zone <iana>", "Render IANA timezone (with --ui)"),
  ).action(async (options: ToolsCallOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const target = describeTarget(options);
    const primaryCollector =
      globalOptions.rpc || options.debugOut
        ? createCliRpcLogCollector({ __cli__: target })
        : undefined;
    const snapshotCollector = options.debugOut
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });
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

    try {
      result = await withEphemeralManager(
        config,
        (manager, serverId) => manager.executeTool(serverId, toolName, params),
        {
          timeout: globalOptions.timeout,
          rpcLogger: primaryCollector?.rpcLogger,
        },
      );
    } catch (error) {
      commandError = error;
    }

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

    let outputPayload = result;
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
        result,
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
          durationMs: Date.now() - startedAt,
          rawResult: result,
          metadata: {
            toolName,
          },
        }),
      );
    } else {
      writeResult(
        withRpcLogsIfRequested(outputPayload, primaryCollector, globalOptions),
        globalOptions.format,
      );
    }

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
