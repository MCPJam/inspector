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
  params?: string;
  validateResponse?: boolean;
  expectSuccess?: boolean;
  reporter?: string;
  debugOut?: string;
  ui?: boolean;
  inspectorUrl?: string;
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
      .option("--ui", "Open Inspector and render the tool result")
      .option("--inspector-url <url>", "Local Inspector base URL (with --ui)")
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
    const paramsInput = resolveAliasedStringOption(
      options as Record<string, unknown>,
      [
        { key: "toolArgs", flag: "--tool-args" },
        { key: "params", flag: "--params" },
      ],
      "Tool parameters",
    );
    const params = parseJsonRecord(paramsInput, "Tool parameters") ?? {};
    const targetSummary = summarizeServerDoctorTarget(target, config);
    const shouldValidateResponse = options.validateResponse === true;
    const shouldExpectSuccess = options.expectSuccess === true;

    if (options.ui && reporter) {
      throw usageError("--ui cannot be used together with --reporter.");
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
    let inspectorRenderError:
      | { code: string; message: string; details?: unknown }
      | undefined;

    if (options.ui) {
      const serverName =
        typeof options.serverName === "string" && options.serverName.trim()
          ? options.serverName.trim()
          : buildInspectorServerName(options);
      let uiResult: Record<string, unknown>;

      try {
        uiResult = await runUiRender({
          baseUrl: options.inspectorUrl,
          config,
          params,
          renderContext: renderContext!,
          serverName,
          timeoutMs: globalOptions.timeout,
          toolName,
          toolResult: result,
        });
        inspectorRenderError = findInspectorRenderError(uiResult);
      } catch (error) {
        inspectorRenderError = toStructuredError(normalizeCliError(error)).error;
        uiResult = {
          status: "error",
          error: inspectorRenderError,
        };
      }

      outputPayload = {
        success: !inspectorRenderError && !validationFailed && !toolResultError,
        command: "tools call",
        inspectorUi: true,
        target,
        toolName,
        params,
        result,
        inspectorRender: uiResult,
        ...(inspectorRenderError ? { error: inspectorRenderError } : {}),
      };
    }

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
      outcome: inspectorRenderError
        ? {
            status: "error",
            error: inspectorRenderError,
            result: outputPayload,
          }
        : {
            status: "success",
            result: outputPayload,
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
    if (inspectorRenderError) {
      setProcessExitCode(1);
    }
  });
}
