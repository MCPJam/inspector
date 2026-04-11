import { probeMcpServer } from "@mcpjam/sdk";
import { Command } from "commander";
import { withEphemeralManager } from "../lib/ephemeral";
import { attachCliRpcLogs, createCliRpcLogCollector } from "../lib/rpc-logs";
import { exportServerSnapshot } from "../lib/server-ops";
import {
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseHeadersOption,
  parseJsonRecord,
  parseServerConfig,
  parsePositiveInteger,
  resolveHttpAccessToken,
} from "../lib/server-config";
import { operationalError, setProcessExitCode, usageError, writeResult } from "../lib/output";

export function registerServerCommands(program: Command): void {
  const server = program
    .command("server")
    .description("Inspect MCP server connectivity and capabilities");

  server
    .command("probe")
    .description("Probe an HTTP MCP server without using the full client connect flow")
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
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const accessToken = resolveHttpAccessToken(options);
      const protocolVersion = options.protocolVersion as
        | "2025-03-26"
        | "2025-06-18"
        | "2025-11-25";

      if (
        protocolVersion !== "2025-03-26" &&
        protocolVersion !== "2025-06-18" &&
        protocolVersion !== "2025-11-25"
      ) {
        throw usageError(
          `Invalid protocol version "${options.protocolVersion}".`,
        );
      }

      const result = await probeMcpServer({
        url: options.url as string,
        protocolVersion,
        headers: parseHeadersOption(options.header),
        accessToken,
        clientCapabilities: parseJsonRecord(
          options.clientCapabilities,
          "Client capabilities",
        ),
        timeoutMs: options.timeout ?? globalOptions.timeout,
      });

      writeResult(result, globalOptions.format);
      if (result.status === "error") {
        setProcessExitCode(1);
      }
    });

  addSharedServerOptions(
    server
      .command("info")
      .description("Get initialization info for an MCP server"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server
      .command("validate")
      .description("Connect to a server and verify the debugger surface works"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
        await manager.getToolsForAiSdk([serverId]);
        return {
          success: true,
          status: "connected",
          target,
          initInfo: manager.getInitializationInfo(serverId) ?? null,
        };
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server.command("ping").description("Ping an MCP server"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server
      .command("capabilities")
      .description("Get resolved server capabilities"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });

  addSharedServerOptions(
    server.command("export").description("Export server tools, resources, prompts, and capabilities"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
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
      },
    );

    writeResult(withRpcLogsIfRequested(result, collector, globalOptions), globalOptions.format);
  });
}

function withRpcLogsIfRequested(
  value: unknown,
  collector: ReturnType<typeof createCliRpcLogCollector> | undefined,
  options: { format: string; rpc: boolean },
) {
  if (!options.rpc || options.format !== "json") {
    return value;
  }

  return attachCliRpcLogs(value, collector);
}
