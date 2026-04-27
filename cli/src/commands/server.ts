import { readFile } from "node:fs/promises";
import {
  buildServerDiffReport,
  collectServerSnapshot,
  diffServerSnapshots,
  probeMcpServer,
  runServerDoctor,
  serializeServerSnapshot,
  serializeStableServerSnapshot,
  ServerSnapshotFormatError,
} from "@mcpjam/sdk";
import { Command } from "commander";
import {
  buildCommandArtifactError,
  writeCommandDebugArtifact,
  writeDebugArtifact,
} from "../lib/debug-artifact.js";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  formatServerDoctorHuman,
  summarizeServerDoctorTarget,
} from "../lib/server-doctor.js";
import {
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseHeadersOption,
  parseRetryPolicy,
  parseServerConfig,
  parsePositiveInteger,
  resolveHttpAccessToken,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import {
  assertNoCredentialsFileAuthConflicts,
  resolveCredentialsFileAccessToken,
} from "../lib/credentials-file.js";
import {
  parseReporterFormat,
  writeJsonArtifact,
  writeReporterResult,
} from "../lib/reporting.js";
import {
  operationalError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";

export function registerServerCommands(program: Command): void {
  const server = program
    .command("server")
    .description("Inspect MCP server connectivity and capabilities");

  addRetryOptions(
    server
      .command("probe")
      .description(
        "Probe an HTTP MCP server without using the full client connect flow",
      )
      .requiredOption("--url <url>", "HTTP MCP server URL")
      .option("--access-token <token>", "Bearer access token for HTTP servers")
      .option(
        "--oauth-access-token <token>",
        "OAuth bearer access token for HTTP servers",
      )
      .option(
        "--credentials-file <path>",
        "Load OAuth access token from a file created by oauth login or oauth conformance --credentials-out",
      )
      .option(
        "--header <header>",
        'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--client-capabilities <json>",
        "Client capabilities as JSON, @path, or - for stdin",
      )
      .option(
        "--protocol-version <version>",
        "OAuth/MCP protocol version hint used for the initialize probe",
        "2025-11-25",
      )
      .option(
        "--timeout <ms>",
        "Request timeout in milliseconds",
        (value: string) => parsePositiveInteger(value, "Timeout"),
      )
      .option(
        "--debug-out <path>",
        "Write a structured debug artifact to a file",
      ),
  ).action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const retryPolicy = parseRetryPolicy(options);
      const protocolVersion = options.protocolVersion as
        | "2025-03-26"
        | "2025-06-18"
        | "2025-11-25";
      const accessToken = resolveServerProbeAccessToken(options);
      const config = parseServerConfig({
        ...options,
        ...(options.credentialsFile
          ? { accessToken, credentialsFile: undefined }
          : {}),
        timeout: options.timeout ?? globalOptions.timeout,
      });
      const target = describeTarget(options);
      const targetSummary = summarizeServerDoctorTarget(target, config);
      const snapshotCollector = options.debugOut
        ? createCliRpcLogCollector({ __cli__: target })
        : undefined;

      if (
        protocolVersion !== "2025-03-26" &&
        protocolVersion !== "2025-06-18" &&
        protocolVersion !== "2025-11-25"
      ) {
        throw usageError(
          `Invalid protocol version "${options.protocolVersion}".`,
        );
      }

      let result: Awaited<ReturnType<typeof probeMcpServer>> | undefined;
      let commandError: unknown;

      try {
        const probeUrl = "url" in config ? config.url : undefined;
        if (!probeUrl) {
          throw usageError("HTTP probe requires --url.");
        }

        result = await probeMcpServer({
          url: probeUrl,
          protocolVersion,
          headers: parseHeadersOption(options.header),
          accessToken,
          clientCapabilities:
            "clientCapabilities" in config
              ? config.clientCapabilities
              : undefined,
          timeoutMs: options.timeout ?? globalOptions.timeout,
          retryPolicy,
        });
      } catch (error) {
        commandError = error;
      }

      await writeCommandDebugArtifact({
        outputPath: options.debugOut as string | undefined,
        format: globalOptions.format,
        quiet: globalOptions.quiet,
        commandName: "server probe",
        commandInput: {
          protocolVersion,
          clientCapabilities:
            "clientCapabilities" in config
              ? config.clientCapabilities
              : undefined,
        },
        target: targetSummary,
        outcome: commandError
          ? {
              status: "error",
              error: commandError,
            }
          : result?.status === "error"
            ? {
                status: "error",
                result,
                error: buildCommandArtifactError(
                  "PROBE_FAILED",
                  result.error ?? "Probe failed.",
                ),
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
                timeout: options.timeout ?? globalOptions.timeout,
              },
              collector: snapshotCollector,
            }
          : undefined,
      });

      if (commandError) {
        throw commandError;
      }
      if (!result) {
        throw operationalError("Probe did not return a result.");
      }

      writeResult(result, globalOptions.format);
      if (result.status === "error") {
        setProcessExitCode(1);
      }
    });

  addRetryOptions(
    addSharedServerOptions(
      server
        .command("doctor")
        .description("Run a stateless diagnostic sweep against an MCP server")
        .option("--out <path>", "Write the doctor JSON artifact to a file"),
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
    const doctorTarget = summarizeServerDoctorTarget(target, config);

    const result = await runServerDoctor({
      config,
      target: doctorTarget,
      timeout: globalOptions.timeout,
      rpcLogger: collector?.rpcLogger,
      retryPolicy,
    });

    const jsonPayload = globalOptions.rpc
      ? attachCliRpcLogs(result, collector)
      : result;
    const artifactPath = options.out
      ? await writeDebugArtifact(options.out as string, jsonPayload)
      : undefined;

    if (globalOptions.format === "human") {
      process.stdout.write(
        `${formatServerDoctorHuman(result, { artifactPath })}\n`,
      );
    } else {
      writeResult(jsonPayload, globalOptions.format);
    }

    if (result.status !== "ready") {
      setProcessExitCode(1);
    }
  });

  addRetryOptions(
    addSharedServerOptions(
      server
        .command("info")
        .description("Get initialization info for an MCP server"),
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
      async (manager, serverId) => {
        const info = manager.getInitializationInfo(serverId);
        if (!info) {
          throw operationalError(
            "Server connected but did not return initialization info.",
          );
        }

        return info;
      },
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

  addRetryOptions(
    addSharedServerOptions(
      server
        .command("validate")
        .description("Connect to a server and verify the debugger surface works"),
    ),
  )
    .option("--debug-out <path>", "Write a structured debug artifact to a file")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const retryPolicy = parseRetryPolicy(options);
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
      const targetSummary = summarizeServerDoctorTarget(target, config);

      let result:
        | {
            success: true;
            status: "connected";
            target: string;
            initInfo: unknown | null;
          }
        | undefined;
      let commandError: unknown;

      try {
        result = await withEphemeralManager(
          config,
          async (manager, serverId) => {
            await manager.getToolsForAiSdk([serverId]);
            return {
              success: true,
              status: "connected" as const,
              target,
              initInfo: manager.getInitializationInfo(serverId) ?? null,
            };
          },
          {
            timeout: globalOptions.timeout,
            rpcLogger: primaryCollector?.rpcLogger,
            retryPolicy,
          },
        );
      } catch (error) {
        commandError = error;
      }

      await writeCommandDebugArtifact({
        outputPath: options.debugOut as string | undefined,
        format: globalOptions.format,
        quiet: globalOptions.quiet,
        commandName: "server validate",
        commandInput: {},
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

      writeResult(
        withRpcLogsIfRequested(result, primaryCollector, globalOptions),
        globalOptions.format,
      );
    });

  addRetryOptions(
    addSharedServerOptions(
      server.command("ping").description("Ping an MCP server"),
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
      async (manager, serverId) => ({
        target,
        status: "connected",
        result: await manager.pingServer(serverId),
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

  addRetryOptions(
    addSharedServerOptions(
      server
        .command("capabilities")
        .description("Get resolved server capabilities"),
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
      async (manager, serverId) => ({
        target,
        capabilities: manager.getServerCapabilities(serverId) ?? null,
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

  addRetryOptions(
    addSharedServerOptions(
      server
        .command("export")
        .description(
          "Export server tools, resources, prompts, and capabilities",
        )
        .option(
          "--stable",
          "Emit the deterministic versioned snapshot format for baselines",
        ),
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

    const snapshot = await collectServerSnapshot({
      config,
      target,
      timeout: globalOptions.timeout,
      rpcLogger: collector?.rpcLogger,
      retryPolicy,
      clientName: "mcpjam",
      serverId: "__cli__",
    });
    const result = options.stable
      ? serializeStableServerSnapshot(snapshot)
      : serializeServerSnapshot(snapshot, { mode: "raw" });

    writeResult(
      options.stable
        ? result
        : withRpcLogsIfRequested(result, collector, globalOptions),
      globalOptions.format,
    );
  });

  addRetryOptions(
    addSharedServerOptions(
      server
        .command("diff")
        .description(
          "Compare a server snapshot baseline against a live or file snapshot",
        )
        .option(
          "--baseline <path>",
          "Compare a baseline file to a live server target",
        )
        .option(
          "--left <path>",
          "Left snapshot file for file-vs-file comparison",
        )
        .option(
          "--right <path>",
          "Right snapshot file for file-vs-file comparison",
        )
        .option(
          "--fail-on <policy>",
          "Diff failure policy: breaking, any, or none",
        )
        .option(
          "--reporter <reporter>",
          "Structured reporter output: json-summary or junit-xml",
        )
        .option("--out <path>", "Write the raw diff JSON artifact to a file"),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const reporter = parseReporterFormat(
      options.reporter as string | undefined,
    );
    const mode = resolveServerDiffMode(options as Record<string, unknown>);

    let rawDiff: ReturnType<typeof diffServerSnapshots>;
    let collector: ReturnType<typeof createCliRpcLogCollector> | undefined;

    if (mode.kind === "baseline-live") {
      const target = describeTarget(options);
      collector = globalOptions.rpc
        ? createCliRpcLogCollector({ __cli__: target })
        : undefined;
      const config = parseServerConfig({
        ...options,
        timeout: globalOptions.timeout,
      });
      const baselineSnapshot = await readSnapshotFile(mode.baselinePath);
      const currentSnapshot = await collectServerSnapshot({
        config,
        target,
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
        clientName: "mcpjam",
        serverId: "__cli__",
      });
      rawDiff = createServerDiffResult(
        baselineSnapshot,
        currentSnapshot,
        parseDiffFailOn(options.failOn as string | undefined),
      );
    } else {
      if (hasServerTargetOptions(options as Record<string, unknown>)) {
        throw usageError(
          "Do not pass live target options together with --left/--right file comparison.",
        );
      }

      const [leftSnapshot, rightSnapshot] = await Promise.all([
        readSnapshotFile(mode.leftPath),
        readSnapshotFile(mode.rightPath),
      ]);
      rawDiff = createServerDiffResult(
        leftSnapshot,
        rightSnapshot,
        parseDiffFailOn(options.failOn as string | undefined),
      );
    }

    if (options.out) {
      await writeJsonArtifact(options.out as string, rawDiff);
    }

    if (reporter) {
      writeReporterResult(
        reporter,
        buildServerDiffReport(rawDiff, {
          metadata:
            mode.kind === "baseline-live"
              ? {
                  comparisonMode: mode.kind,
                  baselinePath: mode.baselinePath,
                }
              : {
                  comparisonMode: mode.kind,
                  leftPath: mode.leftPath,
                  rightPath: mode.rightPath,
                },
        }),
      );
    } else {
      writeResult(
        withRpcLogsIfRequested(rawDiff, collector, globalOptions),
        globalOptions.format,
      );
    }

    if (!rawDiff.passed) {
      setProcessExitCode(1);
    }
  });
}

export function resolveServerProbeAccessToken(
  options: Pick<
    SharedServerTargetOptions,
    "url" | "accessToken" | "oauthAccessToken" | "credentialsFile"
  >,
): string | undefined {
  assertNoCredentialsFileAuthConflicts(options);

  if (options.credentialsFile) {
    const url = options.url?.trim();
    if (!url) {
      throw usageError("--credentials-file requires --url.");
    }

    return resolveCredentialsFileAccessToken(options.credentialsFile, url);
  }

  return resolveHttpAccessToken(options);
}

function hasServerTargetOptions(options: Record<string, unknown>): boolean {
  return typeof options.url === "string" || typeof options.command === "string";
}

function resolveServerDiffMode(
  options: Record<string, unknown>,
):
  | { kind: "baseline-live"; baselinePath: string }
  | { kind: "file-file"; leftPath: string; rightPath: string } {
  const baselinePath = toOptionalString(options.baseline);
  const leftPath = toOptionalString(options.left);
  const rightPath = toOptionalString(options.right);

  if (baselinePath && (leftPath || rightPath)) {
    throw usageError(
      "Specify either --baseline with a live target or --left/--right for file comparison.",
    );
  }

  if (baselinePath) {
    return {
      kind: "baseline-live",
      baselinePath,
    };
  }

  if (leftPath && rightPath) {
    return {
      kind: "file-file",
      leftPath,
      rightPath,
    };
  }

  if (leftPath || rightPath) {
    throw usageError(
      "Both --left and --right are required for file comparison.",
    );
  }

  throw usageError(
    "Specify either --baseline with a live target or --left/--right for file comparison.",
  );
}

function parseDiffFailOn(
  value: string | undefined,
): "breaking" | "any" | "none" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "breaking" || value === "any" || value === "none") {
    return value;
  }

  throw usageError(
    `Invalid fail-on policy "${value}". Use "breaking", "any", or "none".`,
  );
}

async function readSnapshotFile(filePath: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    throw operationalError(`Failed to read snapshot file "${filePath}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw usageError(`Snapshot file "${filePath}" must contain valid JSON.`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function createServerDiffResult(
  left: unknown,
  right: unknown,
  failOn: "breaking" | "any" | "none" | undefined,
) {
  try {
    return diffServerSnapshots(left, right, { failOn });
  } catch (error) {
    if (error instanceof ServerSnapshotFormatError) {
      throw usageError(error.message);
    }
    throw error;
  }
}
