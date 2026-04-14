import { probeMcpServer, runServerDoctor } from "@mcpjam/sdk";
import { Command } from "commander";
import {
  buildCommandArtifactError,
  writeCommandDebugArtifact,
  writeDebugArtifact,
} from "../lib/debug-artifact";
import { withEphemeralManager } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers";
import {
  formatServerDoctorHuman,
  summarizeServerDoctorTarget,
} from "../lib/server-doctor";
import { exportServerSnapshot } from "../lib/server-ops";
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
} from "../lib/server-config";
import {
  operationalError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output";

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
        "--header <header>",
        'HTTP header in "Key: Value" format. Repeat to send multiple headers.',
        (value: string, previous: string[] = []) => [...previous, value],
        [],
      )
      .option(
        "--client-capabilities <json>",
        "Client capabilities advertised in the initialize probe as a JSON object",
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
    const config = parseServerConfig({
      ...options,
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
        accessToken: resolveHttpAccessToken(options),
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
        .description(
          "Connect to a server and verify the debugger surface works",
        ),
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

    const result = await withEphemeralManager(
      config,
      (manager, serverId) => exportServerSnapshot(manager, serverId, target),
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
}
