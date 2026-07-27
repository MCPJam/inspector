import { Command } from "commander";
import {
  DEFAULT_SUBSCRIPTION_RECONNECT_POLICY,
  SubscriptionCoordinator,
  type DesiredSubscriptionInterests,
  type SubscriptionClientPort,
  type SubscriptionReconnectPolicy,
} from "@mcpjam/sdk";
import { withEphemeralManager } from "../lib/ephemeral.js";
import { createCliRpcLogCollector } from "../lib/rpc-logs.js";
import {
  addHostOption,
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRetryPolicy,
  parseServerConfig,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";
import { resolveHostFromOptions } from "../lib/host-resolve.js";
import { cliError, operationalError, usageError } from "../lib/output.js";
import {
  SubscriptionListenSession,
  hasAnyInterest,
  type SubscriptionListenEvent,
  type SubscriptionListenResult,
} from "../lib/subscriptions-session.js";

export interface SubscriptionListenOptions extends SharedServerTargetOptions {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  listChanged?: boolean;
  resourceUri?: string[];
  relisten?: number;
  relistenDelayMs?: number;
  relistenMaxDelayMs?: number;
  maxNotifications?: number;
  durationMs?: number;
}

/**
 * Desired interests are era-neutral: the same flags describe a 2026-07-28
 * `subscriptions/listen` filter and a legacy list-changed + `resources/
 * subscribe` set. `--list-changed` is a convenience for all three toggles.
 */
export function buildDesiredInterests(
  options: SubscriptionListenOptions,
): DesiredSubscriptionInterests {
  const all = options.listChanged === true;
  return {
    toolsListChanged: all || options.toolsListChanged === true,
    promptsListChanged: all || options.promptsListChanged === true,
    resourcesListChanged: all || options.resourcesListChanged === true,
    resourceUris: [...new Set(options.resourceUri ?? [])],
  };
}

/**
 * Re-listen is OFF unless asked for: a debugger that silently reopens a lost
 * stream hides the loss, which is usually the fact the user is chasing.
 */
export function parseRelistenPolicy(
  options: SubscriptionListenOptions,
): SubscriptionReconnectPolicy {
  const maxAttempts = options.relisten ?? 0;
  if (maxAttempts === 0) {
    if (
      options.relistenDelayMs !== undefined ||
      options.relistenMaxDelayMs !== undefined
    ) {
      throw usageError(
        "--relisten-delay-ms/--relisten-max-delay-ms require --relisten with a positive attempt count.",
      );
    }
    return { ...DEFAULT_SUBSCRIPTION_RECONNECT_POLICY, maxAttempts: 0 };
  }
  const initialDelayMs =
    options.relistenDelayMs ??
    DEFAULT_SUBSCRIPTION_RECONNECT_POLICY.initialDelayMs;
  const maxDelayMs = Math.max(
    initialDelayMs,
    options.relistenMaxDelayMs ??
      DEFAULT_SUBSCRIPTION_RECONNECT_POLICY.maxDelayMs,
  );
  return {
    ...DEFAULT_SUBSCRIPTION_RECONNECT_POLICY,
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
  };
}

/** Non-zero outcomes get a code the caller can branch on in CI. */
export function listenResultError(result: SubscriptionListenResult) {
  if (result.exitCode === 0) return undefined;
  return result.outcome === "remote"
    ? cliError(
        "SUBSCRIPTION_REMOTE_CLOSED",
        "The subscription stream was lost remotely (no completion result from the server).",
        result.exitCode,
        { notifications: result.notifications, relistenAttempts: result.relistenAttempts },
      )
    : cliError(
        "SUBSCRIPTION_FAILED",
        result.error ?? "The subscription stream failed to open.",
        result.exitCode,
      );
}

export function registerSubscriptionsCommands(program: Command): void {
  const subscriptions = program
    .command("subscriptions")
    .description(
      "Open a long-lived MCP subscription and stream its notifications (2026-07-28 subscriptions/listen, with a legacy fallback)",
    );

  addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        subscriptions
          .command("listen")
          .description(
            "Open a subscription, print the acknowledgement, and stream notifications as NDJSON on stdout until the stream closes or Ctrl-C",
          )
          .option("--tools-list-changed", "Subscribe to tools/list_changed")
          .option("--prompts-list-changed", "Subscribe to prompts/list_changed")
          .option(
            "--resources-list-changed",
            "Subscribe to resources/list_changed",
          )
          .option(
            "--list-changed",
            "Subscribe to all three list_changed notifications",
          )
          .option(
            "--resource-uri <uri...>",
            "Watch a resource URI for resources/updated. Pass multiple values or repeat the flag.",
          )
          .option(
            "--relisten <count>",
            "After an unexpected remote loss, re-listen up to this many times with exponential backoff (0 disables)",
            (value: string) => parseNonNegativeInteger(value, "Relisten count"),
          )
          .option(
            "--relisten-delay-ms <ms>",
            "Initial re-listen backoff delay in milliseconds",
            (value: string) => parsePositiveInteger(value, "Relisten delay"),
          )
          .option(
            "--relisten-max-delay-ms <ms>",
            "Maximum re-listen backoff delay in milliseconds",
            (value: string) =>
              parsePositiveInteger(value, "Relisten max delay"),
          )
          .option(
            "--max-notifications <count>",
            "Stop after this many delivered notifications",
            (value: string) =>
              parsePositiveInteger(value, "Max notifications"),
          )
          .option(
            "--duration-ms <ms>",
            "Stop after this many milliseconds",
            (value: string) => parsePositiveInteger(value, "Duration"),
          ),
      ),
    ),
  ).action(async (options: SubscriptionListenOptions, command) => {
    const globalOptions = getGlobalOptions(command);
    const desired = buildDesiredInterests(options);
    if (!hasAnyInterest(desired)) {
      throw usageError(
        "Select at least one subscription interest: --tools-list-changed, --prompts-list-changed, --resources-list-changed, --list-changed, or --resource-uri.",
      );
    }
    const reconnect = parseRelistenPolicy(options);
    const retryPolicy = parseRetryPolicy(options);
    const host = resolveHostFromOptions(options);
    const target = describeTarget(options);
    const collector = globalOptions.rpc
      ? createCliRpcLogCollector({ __cli__: target })
      : undefined;
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    // stdout is the NDJSON event stream in BOTH formats — a listen stream is
    // consumed incrementally, so pretty-printing would break line framing and
    // human status would corrupt it. Status goes to stderr.
    const emit = (event: SubscriptionListenEvent) => {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    };
    const status = (message: string) => {
      if (globalOptions.quiet) return;
      process.stderr.write(`${message}\n`);
    };

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        const client = manager.getManagedClient(serverId);
        if (!client) {
          throw operationalError(
            `MCP server "${serverId}" is not connected; cannot open a subscription.`,
          );
        }
        const session = new SubscriptionListenSession(
          {
            desired,
            reconnect,
            ...(options.maxNotifications !== undefined
              ? { maxNotifications: options.maxNotifications }
              : {}),
            ...(options.durationMs !== undefined
              ? { durationMs: options.durationMs }
              : {}),
          },
          {
            createCoordinator: (handlers) =>
              new SubscriptionCoordinator({
                client: client as unknown as SubscriptionClientPort,
                reconnect,
                ...handlers,
              }),
            emit,
            status,
          },
        );
        const onSignal = () => {
          void session.stop("signal");
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        try {
          return await session.run();
        } finally {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }
      },
      {
        timeout: globalOptions.timeout,
        rpcLogger: collector?.rpcLogger,
        retryPolicy,
        host: host?.connection,
      },
    );

    const error = listenResultError(result);
    if (error) throw error;
  });
}
