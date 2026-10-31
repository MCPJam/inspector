/**
 * What every `mcpjam events` verb shares: the per-run context (profile, RPC
 * log collector, stderr status), the connect-once wrapper, result output and
 * the common flags.
 */

import { Command } from "commander";
import type { MCPClientManager } from "@mcpjam/sdk";
import type { EventsProfile } from "@mcpjam/sdk/events";
import { withEphemeralManager } from "../lib/ephemeral.js";
import {
  applyEventsProtocolVersion,
  parseEventsProfile,
  redactSecrets,
} from "../lib/events-cli.js";
import { resolveHostFromOptions } from "../lib/host-resolve.js";
import { writeResult } from "../lib/output.js";
import { createCliRpcLogCollector, type CliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addHostOption,
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parsePositiveInteger,
  parseRetryPolicy,
  parseServerConfig,
  type GlobalOptions,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";

/** Flags every events verb takes on top of the shared connection flags. */
export interface EventsTargetOptions extends SharedServerTargetOptions {
  profile?: string;
  protocolVersion?: string;
  force?: boolean;
}

export interface EventsCommandOptions extends EventsTargetOptions {
  eventArgs?: string;
  cursor?: string;
  maxEvents?: number;
  maxAgeMs?: number;
}

export interface EventsContext {
  globalOptions: GlobalOptions;
  profile: EventsProfile;
  collector?: CliRpcLogCollector;
  target: string;
  /** Progress text on stderr; suppressed by `--quiet`. */
  status: (message: string) => void;
  /** Warnings on stderr; never suppressed. */
  warn: (message: string) => void;
}

export function buildContext(
  options: EventsTargetOptions,
  command: Command,
): EventsContext {
  const globalOptions = getGlobalOptions(command);
  const target = describeTarget(options);
  return {
    globalOptions,
    profile: parseEventsProfile(options.profile),
    ...(globalOptions.rpc
      ? { collector: createCliRpcLogCollector({ __cli__: target }) }
      : {}),
    target,
    status: (message) => {
      if (!globalOptions.quiet) process.stderr.write(`${redactSecrets(message)}\n`);
    },
    warn: (message) => {
      process.stderr.write(`${redactSecrets(message)}\n`);
    },
  };
}

/** Connect once, run `fn`, disconnect — with the shared connection flags. */
export async function withEventsConnection<T>(
  options: EventsTargetOptions,
  ctx: EventsContext,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
): Promise<T> {
  const retryPolicy = parseRetryPolicy(options);
  const host = resolveHostFromOptions(options);
  const config = applyEventsProtocolVersion(
    parseServerConfig({ ...options, timeout: ctx.globalOptions.timeout }),
    options,
  );
  return withEphemeralManager(
    config,
    async (manager, serverId) => {
      notePeerProtocol(manager, serverId, ctx);
      return fn(manager, serverId);
    },
    {
      timeout: ctx.globalOptions.timeout,
      rpcLogger: ctx.collector?.rpcLogger,
      retryPolicy,
      host: host?.connection,
    },
  );
}

/** The profile documents protocol versions; say so when this connection is outside them. */
function notePeerProtocol(
  manager: MCPClientManager,
  serverId: string,
  ctx: EventsContext,
): void {
  const negotiated = manager.getCapturedEventsCapability(serverId)?.protocolVersion;
  const documented = ctx.profile.protocolVersions.value;
  if (negotiated && !documented.includes(negotiated)) {
    ctx.status(
      `Note: profile ${ctx.profile.id} covers protocol ${documented.join(", ")}; this connection negotiated ${negotiated}. Pass --protocol-version to match.`,
    );
  }
}

/** Results go to stdout, scrubbed of anything secret-shaped (defense in depth). */
export function writeEventsResult(value: unknown, ctx: EventsContext): void {
  const withLogs = withRpcLogsIfRequested(value, ctx.collector, ctx.globalOptions);
  writeResult(
    JSON.parse(redactSecrets(JSON.stringify(withLogs))),
    ctx.globalOptions.format,
  );
}

export function addEventsTargetOptions(command: Command): Command {
  return addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        command
          .option(
            "--profile <profile>",
            'Events profile the run is judged by: "draft" (draft@28ec35e) or "chatgpt" (chatgpt@2026-09-30)',
            "draft",
          )
          .option(
            "--protocol-version <version>",
            "Pin the MCP protocol version (e.g. 2026-07-28). HTTP targets only.",
          )
          .option(
            "--force",
            "Send events/* even when the server did not declare capabilities.events (conformance probing)",
          ),
      ),
    ),
  );
}

export function addEventArgsOption(command: Command): Command {
  return command.option(
    "--event-args <json>",
    "Event arguments as a JSON object, @path, or - for stdin (default {})",
  );
}

export function positiveInteger(label: string) {
  return (value: string) => parsePositiveInteger(value, label);
}
