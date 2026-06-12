import type { Command } from "commander";
import {
  closeTunnelOperation,
  createTunnelOperation,
  type CreateTunnelResult,
} from "@mcpjam/sdk/platform";
import { cliError, usageError, writeResult } from "../lib/output.js";
import { buildPlatformClient, toCliError } from "../lib/platform-client.js";
import { getGlobalOptions, parseServerConfig } from "../lib/server-config.js";
import { startLocalBridge, type TunnelTarget } from "../lib/tunnel/local-bridge.js";
import { RelayConnection } from "../lib/tunnel/relay-client.js";
import { TunnelSession } from "../lib/tunnel/tunnel-session.js";

type TunnelCommandOptions = {
  id: string;
  project?: string;
  apiKey?: string;
  apiUrl?: string;
  env?: string[];
  cwd?: string;
};

export type ParsedTunnelTarget =
  | { kind: "http"; url: string }
  | { kind: "stdio"; command: string; args: string[] };

/**
 * One variadic operand covers both target forms: a single http(s) URL, or a
 * stdio command whose argv arrives after the `--` separator (commander
 * treats everything past `--` as operands, so no parser-mode changes).
 */
export function parseTunnelTarget(tokens: string[]): ParsedTunnelTarget {
  const isUrl = (token: string) => /^https?:\/\//i.test(token);
  if (tokens.length === 0) {
    throw usageError(
      "Specify a target: a local server URL (mcpjam tunnel http://localhost:9090/mcp --id my-server) or a stdio command (mcpjam tunnel --id my-server -- npx -y @modelcontextprotocol/server-everything).",
    );
  }
  if (isUrl(tokens[0])) {
    if (tokens.length > 1) {
      throw usageError(
        "Pass either a URL or a stdio command (after --), not both.",
      );
    }
    try {
      new URL(tokens[0]);
    } catch {
      throw usageError(`Invalid URL: ${tokens[0]}`);
    }
    return { kind: "http", url: tokens[0] };
  }
  return { kind: "stdio", command: tokens[0], args: tokens.slice(1) };
}

function overwriteWarning(result: CreateTunnelResult): string | undefined {
  const grant = result.grant;
  if (!grant.existed) return undefined;
  if (grant.previousTransportType === "stdio") {
    return `WARNING: server "${grant.name ?? grant.serverId}" already existed as a stdio server — its config was converted to an HTTP server pointing at this tunnel.`;
  }
  if (grant.previousUrl) {
    return `WARNING: server "${grant.name ?? grant.serverId}" already existed — its URL was overwritten (was: ${grant.previousUrl}).`;
  }
  return undefined;
}

function publicHost(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function registerTunnelCommands(program: Command): void {
  program
    .command("tunnel")
    .description(
      "Expose a local MCP server through an MCPJam tunnel and register it as a server in your project",
    )
    .argument(
      "[target...]",
      "Local http(s) MCP server URL, or a stdio command after `--`",
    )
    .requiredOption(
      "--id <name>",
      "Server name to register in the project (an existing server with this name is pointed at the tunnel)",
    )
    .option(
      "--project <id-or-name>",
      "Project name or ID (defaults to the most recently updated project)",
    )
    .option("--api-key <key>", "MCPJam sk_ API key (overrides MCPJAM_API_KEY)")
    .option(
      "--api-url <url>",
      "MCPJam API base URL (defaults to https://app.mcpjam.com/api/v1)",
    )
    .option(
      "-e, --env <env...>",
      'Stdio environment assignment in "KEY=VALUE" format. Pass multiple values or repeat the flag.',
    )
    .option("--cwd <path>", "Working directory for the stdio MCP server process")
    .action(
      async (target: string[], options: TunnelCommandOptions, command) => {
        const globalOptions = getGlobalOptions(command);
        const parsedTarget = parseTunnelTarget(target);

        if (
          parsedTarget.kind === "http" &&
          ((options.env?.length ?? 0) > 0 || options.cwd)
        ) {
          throw usageError(
            "--env and --cwd can only be used with a stdio command target.",
          );
        }

        // Status and progress go to stderr in BOTH formats so `--format
        // json` keeps stdout to exactly one machine-readable startup object.
        const status = (message: string) => {
          process.stderr.write(`${message}\n`);
        };

        const bridgeTarget: TunnelTarget =
          parsedTarget.kind === "http"
            ? { kind: "http", url: parsedTarget.url }
            : {
                kind: "stdio",
                config: parseServerConfig({
                  transport: "stdio",
                  command: parsedTarget.command,
                  args: parsedTarget.args,
                  env: options.env,
                  cwd: options.cwd,
                  timeout: globalOptions.timeout,
                }),
              };

        let client;
        try {
          ({ client } = buildPlatformClient({
            apiKey: options.apiKey,
            apiUrl: options.apiUrl,
            timeoutMs: globalOptions.timeout,
          }));
        } catch (error) {
          throw toCliError(error);
        }

        const printStartup = (result: CreateTunnelResult) => {
          const warning = overwriteWarning(result);
          if (warning) status(warning);
          if (globalOptions.format === "human") {
            process.stdout.write(
              `Tunnel live: ${result.grant.url}\n` +
                `Registered server "${result.grant.name ?? options.id}" in project "${result.project.name}" (${result.grant.serverId})\n`,
            );
            status("Press Ctrl-C to stop the tunnel.");
          } else {
            writeResult(
              {
                url: result.grant.url,
                serverId: result.grant.serverId,
                name: result.grant.name ?? options.id,
                slug: result.grant.slug,
                project: result.project,
                existed: result.grant.existed ?? false,
                ...(result.grant.previousUrl
                  ? { previousUrl: result.grant.previousUrl }
                  : {}),
                ...(result.grant.previousTransportType
                  ? { previousTransportType: result.grant.previousTransportType }
                  : {}),
                ...(result.grant.secretVersion !== undefined
                  ? { secretVersion: result.grant.secretVersion }
                  : {}),
                target:
                  parsedTarget.kind === "http"
                    ? { kind: "http", url: parsedTarget.url }
                    : {
                        kind: "stdio",
                        command: parsedTarget.command,
                        args: parsedTarget.args,
                      },
              },
              globalOptions.format,
            );
          }
        };

        const session = new TunnelSession({
          createGrant: (signal) =>
            createTunnelOperation.execute(
              { project: options.project, name: options.id },
              { client, signal },
            ),
          closeGrant: async (result, signal) => {
            await closeTunnelOperation.execute(
              {
                project: result.project.id,
                serverId: result.grant.serverId,
              },
              { client, signal },
            );
          },
          startBridge: (serverId) =>
            startLocalBridge({
              serverId,
              target: bridgeTarget,
              timeoutMs: globalOptions.timeout,
              log: status,
            }),
          connectRelay: ({ grant, localAddr, onPermanentFailure }) =>
            new RelayConnection({
              serverId: grant.serverId,
              slug: grant.slug,
              relayWsUrl: grant.relayWsUrl,
              connectToken: grant.connectToken,
              localAddr,
              publicHost: publicHost(grant.url),
              logger: { info: status, warn: status },
              onPermanentFailure,
            }),
          log: status,
          onGrant: (result, rotated) => {
            if (rotated) {
              status(`Tunnel secret rotated; new URL: ${result.grant.url}`);
              return;
            }
            printStartup(result);
          },
        });

        if (parsedTarget.kind === "stdio") {
          status(
            `Starting stdio server: ${parsedTarget.command}${parsedTarget.args.length ? ` ${parsedTarget.args.join(" ")}` : ""}`,
          );
        }

        let sigints = 0;
        const onSignal = () => {
          sigints += 1;
          if (sigints === 1) {
            status("Shutting down tunnel... (Ctrl-C again to force quit)");
            void session.stop();
            return;
          }
          process.exit(130);
        };
        // Attached BEFORE start(): an interrupt while the grant/bridge/relay
        // are still coming up must run the same graceful stop (revoking
        // whatever was already minted) instead of the default kill.
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        try {
          const startPromise = session.start();
          try {
            // An interrupt mid-startup settles the session via stop()
            // while start() may still be unwinding (e.g. a relay connect
            // waiting out its timeout) — don't stay blocked on it.
            await Promise.race([startPromise, session.waitUntilClosed()]);
          } catch (error) {
            if (sigints === 0) {
              throw toCliError(error);
            }
          }
          if (sigints > 0) {
            // Interrupted startup: the rejection (if any) IS the
            // interruption; the session result below is the real outcome.
            startPromise.catch(() => {});
          }
          const result = await session.waitUntilClosed();
          if (result.exitCode !== 0) {
            throw cliError(
              "TUNNEL_CLOSED",
              result.reason ?? "Tunnel closed",
              result.exitCode,
            );
          }
        } finally {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }
      },
    );
}
