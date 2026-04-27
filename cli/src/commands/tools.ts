import { Command } from "commander";
import {
  buildToolCallValidationReport,
  isCallToolResultError,
  validateToolCallResult,
} from "@mcpjam/sdk";
import { writeCommandDebugArtifact } from "../lib/debug-artifact.js";
import { withEphemeralManager } from "../lib/ephemeral.js";
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
} from "../lib/server-config.js";
import { setProcessExitCode, usageError, writeResult } from "../lib/output.js";

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
      ),
  ).action(async (options, command) => {
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
    const reporter = parseReporterFormat(
      options.reporter as string | undefined,
    );
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

    if (reporter && !shouldValidateResponse && !shouldExpectSuccess) {
      throw usageError(
        "--reporter requires --validate-response and/or --expect-success.",
      );
    }

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

    await writeCommandDebugArtifact({
      outputPath: options.debugOut as string | undefined,
      format: globalOptions.format,
      quiet: globalOptions.quiet,
      commandName: "tools call",
      commandInput: {
        toolName,
        params,
      },
      target: targetSummary,
      outcome: commandError
        ? {
            status: "error",
            error: commandError,
          }
        : {
            status: "success",
            result,
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

    if (commandError) {
      throw commandError;
    }

    const validationResult =
      shouldValidateResponse || shouldExpectSuccess
        ? validateToolCallResult(result, {
            envelope: shouldValidateResponse,
            outcome: shouldExpectSuccess ? { failOnIsError: true } : undefined,
          })
        : undefined;

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
        withRpcLogsIfRequested(result, primaryCollector, globalOptions),
        globalOptions.format,
      );
    }

    if (validationResult && !validationResult.passed) {
      setProcessExitCode(1);
    }
    if (isCallToolResultError(result)) {
      setProcessExitCode(1);
    }
  });
}
