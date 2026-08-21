import type { Command } from "commander";
import { addRequiredOptionWithHiddenAlias } from "../lib/commander-options.js";
import {
  createTunnelOperation,
  type CreateTunnelResult,
} from "@mcpjam/sdk/platform";
import { cliError, usageError, writeResult } from "../lib/output.js";
import {
  announceCloudContext,
  preflightCloudCredentials,
} from "../lib/cloud-context.js";
import { buildCloudClientContext, platformOptionsOf } from "../lib/platform-command.js";
import { resolveCloudProjectArgs } from "../lib/cloud-scope.js";
import { toCliError } from "../lib/platform-client.js";
import { getGlobalOptions, parseServerConfig } from "../lib/server-config.js";
import { startLocalBridge, type TunnelTarget } from "../lib/tunnel/local-bridge.js";
import { RelayConnection } from "../lib/tunnel/relay-client.js";
import { TunnelSession } from "../lib/tunnel/tunnel-session.js";

type TunnelCommandOptions = {
  server: string;
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
      "Specify a target: a local server URL (mcpjam cloud tunnel http://localhost:9090/mcp --server my-server) or a stdio command (mcpjam cloud tunnel --server my-server -- npx -y @modelcontextprotocol/server-everything).",
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
  const tunnel = program
    .command("tunnel")
    .description(
      "Expose a local MCP server through an MCPJam tunnel and register it as a server in your project",
    )
    .argument(
      "[target...]",
      "Local http(s) MCP server URL, or a stdio command after `--`",
    );
  addRequiredOptionWithHiddenAlias(
    tunnel,
    "--server <name>",
    "--id",
    "Server name to register in the project (an existing server with this name is pointed at the tunnel)",
  );
  tunnel
    .option(
      "--project <id-or-name>",
      "Project name or ID (defaults to the most recently updated project)",
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

        // Client request timeouts still use `--timeout`. The tunnel itself
        // is not wrapped in `runPlatformOperation`: a session is meant to
        // outlive the default 30-second whole-command deadline.
        const platform = platformOptionsOf(command);
        preflightCloudCredentials(platform);
        const resolved = resolveCloudProjectArgs(options);
        announceCloudContext({
          scope: resolved.projectScope,
          options: platform,
          quiet: globalOptions.quiet,
        });
        let client;
        try {
          ({ client } = buildCloudClientContext(
            platform,
            globalOptions.timeout,
          ));
        } catch (error) {
          throw toCliError(error);
        }

        const printStartup = (result: CreateTunnelResult) => {
          const warning = overwriteWarning(result);
          if (warning) status(warning);
          if (globalOptions.format === "human") {
            process.stdout.write(
              `Tunnel live: ${result.grant.url}\n` +
                `Registered server "${result.grant.name ?? options.server}" in project "${result.project.name}" (${result.grant.serverId})\n`,
            );
            status("Press Ctrl-C to stop the tunnel.");
          } else {
            writeResult(
              {
                url: result.grant.url,
                serverId: result.grant.serverId,
                name: result.grant.name ?? options.server,
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
              { project: resolved.project, name: options.server },
              { client, signal },
            ),
          closeGrant: async (result, signal) => {
            // Deliberately NOT the close_tunnel operation: it re-resolves
            // the project via listProjects first, which would add a second
            // round-trip inside the 5s revocation grace window and an
            // independent failure mode (a listing hiccup skipping a close
            // that would have succeeded). The create result already holds
            // the resolved project id — revoke with it directly.
            await client.closeTunnel(
              {
                projectId: result.project.id,
                serverId: result.grant.serverId,
              },
              { signal },
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
