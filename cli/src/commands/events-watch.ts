/**
 * `mcpjam events watch`: stream one event as NDJSON through the SDK's
 * coordinator, push runtime and in-memory inbox, with an optional local
 * webhook receiver, then unsubscribe.
 */

import { randomBytes } from "node:crypto";
import { Command } from "commander";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  computeBindingKey,
  createManagerPushPort,
  EventsCoordinator,
  EventsPushRuntime,
  MemoryEventInbox,
  selectDeliveryMode,
  type DeliveryMode,
  type EventsRpcPort,
  type PushConnectionPort,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";
import {
  assertEventsDeclaredOrForced,
  checkCallbackUrl,
  describeDeliveryMismatch,
  insecureModeWarning,
  listAllServerEvents,
  parseDurationSeconds,
  parseEventArguments,
  parseListenAddress,
  redactSecrets,
  withEventsErrors,
} from "../lib/events-cli.js";
import { startEventsReceiver, type EventsReceiverHandle } from "../lib/events-receiver.js";
import { EventsWatchSession, type EventsWatchResult } from "../lib/events-watch.js";
import { cliError, usageError } from "../lib/output.js";
import { parseNonNegativeInteger } from "../lib/server-config.js";
import {
  addEventArgsOption,
  addEventsTargetOptions,
  buildContext,
  positiveInteger,
  withEventsConnection,
  type EventsCommandOptions,
  type EventsContext,
} from "./events-context.js";

export interface EventsWatchOptions extends EventsCommandOptions {
  mode?: string;
  duration?: number;
  listen?: string;
  publicUrl?: string;
  insecureLocalReceiver?: boolean;
}

const WATCH_MODES = ["poll", "push", "webhook"] as const;

interface WatchReceiverPlan {
  /** `--public-url`, validated; absent ⇒ derive from the bound listener (insecure only). */
  publicUrl?: URL;
  insecure: boolean;
  listen: { host: string; port: number };
}

function planWatchReceiver(options: EventsWatchOptions): {
  forcedMode?: DeliveryMode;
  receiver?: WatchReceiverPlan;
} {
  const mode = options.mode?.trim();
  if (mode !== undefined && !(WATCH_MODES as readonly string[]).includes(mode)) {
    throw usageError(`--mode must be one of ${WATCH_MODES.join(", ")} (got "${mode}").`);
  }
  const receiverFlags =
    options.publicUrl !== undefined ||
    options.insecureLocalReceiver === true ||
    options.listen !== undefined;
  if (mode !== undefined && mode !== "webhook" && receiverFlags) {
    throw usageError(
      "--public-url, --listen and --insecure-local-receiver apply only to --mode webhook.",
    );
  }
  const wantsWebhook = mode === "webhook" || receiverFlags;
  if (!wantsWebhook) {
    return mode ? { forcedMode: mode as DeliveryMode } : {};
  }
  if (options.publicUrl === undefined && options.insecureLocalReceiver !== true) {
    throw usageError(
      "Webhook mode needs --public-url <https-origin> pointing at the local receiver (for example a tunnel), " +
        "or --insecure-local-receiver to give the server the receiver's own plain-http address (NON-CONFORMANT).",
    );
  }
  let publicUrl: URL | undefined;
  let insecure = options.insecureLocalReceiver === true && options.publicUrl === undefined;
  if (options.publicUrl !== undefined) {
    const checked = checkCallbackUrl(options.publicUrl, {
      flag: "--public-url",
      insecureFlag: "--insecure-local-receiver",
      allowInsecure: options.insecureLocalReceiver === true,
    });
    if (checked.url.search || checked.url.hash) {
      throw usageError("--public-url must not carry a query string or fragment.");
    }
    publicUrl = checked.url;
    insecure = checked.insecure;
  }
  return {
    forcedMode: "webhook",
    receiver: { publicUrl, insecure, listen: parseListenAddress(options.listen) },
  };
}

function buildRpcPort(
  manager: MCPClientManager,
  serverId: string,
  allowUndeclared: boolean | undefined,
): EventsRpcPort {
  const options = { allowUndeclared };
  return {
    list: (params) => manager.listServerEvents(serverId, params, options),
    poll: (params) => manager.pollServerEvents(serverId, params, options),
    subscribe: (params) => manager.subscribeServerEvents(serverId, params, options),
    unsubscribe: (params) => manager.unsubscribeServerEvents(serverId, params, options),
  };
}

function buildPushPort(
  manager: MCPClientManager,
  serverId: string,
  allowUndeclared: boolean | undefined,
): PushConnectionPort {
  const base = createManagerPushPort(manager as never, serverId);
  if (!allowUndeclared) return base;
  return {
    ...base,
    openStream: (params, streamOptions) =>
      manager.openEventsStream(serverId, params, {
        ...streamOptions,
        allowUndeclared: true,
      }),
  };
}

export function registerWatch(events: Command): void {
  addEventsTargetOptions(
    addEventArgsOption(
      events
        .command("watch")
        .description(
          "Stream an event as NDJSON on stdout until Ctrl-C, --duration or --max-events, then unsubscribe. " +
            "Modes: push (events/stream), poll (events/poll loop) or webhook (a local receiver behind --public-url). " +
            "Default: webhook when a receiver flag (--public-url, --listen, --insecure-local-receiver) is given, else push when the event offers it, else poll.",
        )
        .argument("<name>", "Event name, from `events list`")
        .option("--mode <mode>", "Delivery mode: poll, push or webhook")
        .option(
          "--duration <seconds>",
          "Stop after this many seconds",
          parseDurationSeconds,
        )
        .option(
          "--max-events <n>",
          "Stop after this many delivered events",
          positiveInteger("Max events"),
        )
        .option("--cursor <cursor>", "Start from this cursor (default: null, start from now)")
        .option("--max-age-ms <ms>", "maxAgeMs sent with poll/stream/subscribe", (value: string) =>
          parseNonNegativeInteger(value, "Max age"),
        )
        .option(
          "--listen <host:port>",
          "Webhook mode: where the local receiver listens (default 127.0.0.1:0)",
        )
        .option(
          "--public-url <url>",
          "Webhook mode: the https origin that forwards to the local receiver (e.g. a tunnel). Callback URLs are <url>/i/<inbox>/s/<slot>.",
        )
        .option(
          "--insecure-local-receiver",
          "Webhook mode: allow a plain-http callback URL (defaults to the receiver's own address). NON-CONFORMANT development mode; never a conformance pass.",
        ),
    ),
  ).action(async (name: string, options: EventsWatchOptions, command: Command) => {
    const ctx = buildContext(options, command);
    const eventArguments = parseEventArguments(options.eventArgs);
    const plan = planWatchReceiver(options);

    const result = await withEventsConnection(options, ctx, async (manager, serverId) => {
      assertEventsDeclaredOrForced(manager, serverId, {
        force: options.force,
        serverLabel: ctx.target,
        warn: ctx.warn,
      });
      const eventTypes = await withEventsErrors("events/list", () =>
        listAllServerEvents(manager, serverId, { allowUndeclared: options.force }),
      );
      const descriptor = eventTypes.find((entry) => entry.name === name);
      if (!descriptor) {
        throw cliError(
          "EVENTS_UNKNOWN_EVENT",
          `The server does not list an event named "${name}". Available: ${
            eventTypes.map((entry) => entry.name).join(", ") || "(none)"
          }.`,
          1,
        );
      }
      const mode = selectDeliveryMode({
        profile: ctx.profile,
        advertised: descriptor.delivery,
        webhookReceiverAvailable: plan.receiver !== undefined,
        pushAvailable: true,
        ...(plan.forcedMode ? { forced: plan.forcedMode } : {}),
      });
      if (!mode) {
        throw cliError(
          "EVENTS_NO_COMPATIBLE_DELIVERY_MODE",
          plan.forcedMode
            ? describeDeliveryMismatch({ profile: ctx.profile, descriptor, mode: plan.forcedMode })
            : `Event "${name}" advertises delivery [${descriptor.delivery.join(", ")}], and none of it is usable under profile ${ctx.profile.id} without a webhook receiver. Pass --public-url (or --insecure-local-receiver) for webhook delivery.`,
          2,
        );
      }

      let receiver: EventsReceiverHandle | undefined;
      let pushRuntime: EventsPushRuntime | undefined;
      try {
        let publicOrigin = "http://127.0.0.1";
        if (mode === "webhook" && plan.receiver) {
          receiver = await startEventsReceiver({
            host: plan.receiver.listen.host,
            port: plan.receiver.listen.port,
            onDelivery: (delivery) => {
              if (delivery.challenge) {
                ctx.status("Receiver: answered the server's verification challenge.");
              } else if (delivery.status >= 300) {
                ctx.status(
                  `Receiver: rejected a delivery (${delivery.status}${delivery.reason ? ` ${delivery.reason}` : ""}).`,
                );
              }
            },
          });
          publicOrigin = (plan.receiver.publicUrl?.toString() ?? receiver.localUrl).replace(/\/$/, "");
          ctx.status(`Receiver listening on ${receiver.localUrl}; callback origin ${publicOrigin}.`);
          if (plan.receiver.insecure) {
            ctx.warn(insecureModeWarning("--insecure-local-receiver", publicOrigin));
          }
        }

        const inbox = new MemoryEventInbox({ publicOrigin });
        receiver?.attach(inbox);
        const record: SubscriptionRecord = {
          id: `esub_cli_${randomBytes(8).toString("hex")}`,
          projectId: "local",
          environmentId: null,
          bindingKey: computeBindingKey({
            serverId: ctx.target,
            credentialOwnerUserId: "local",
            credentialFingerprint: null,
          }),
          serverId,
          profile: ctx.profile.id,
          eventName: name,
          arguments: eventArguments,
          mode,
          desiredState: "active",
          observedState: "pending",
          generation: 1,
          nextActionAt: 0,
          lastCursor: options.cursor ?? null,
          consecutiveFailures: 0,
          ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
        };
        const coordinator = new EventsCoordinator({
          rpc: async () => buildRpcPort(manager, serverId, options.force),
          inbox: async () => inbox,
          // This process is the only refresher, and it has stopped by the time
          // removal runs: nothing can be in flight, so there is no window to
          // wait out before the confirming second unsubscribe.
          lateRefreshWindowMs: 0,
        });
        if (mode === "push") {
          pushRuntime = new EventsPushRuntime({
            port: buildPushPort(manager, serverId, options.force),
            inbox,
          });
        }

        const session = new EventsWatchSession(
          record,
          {
            ...(options.duration !== undefined ? { durationMs: options.duration } : {}),
            ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
          },
          {
            coordinator,
            inbox,
            ...(pushRuntime ? { push: pushRuntime } : {}),
            emit: (line) => {
              process.stdout.write(`${redactSecrets(JSON.stringify(line))}\n`);
            },
            status: ctx.status,
          },
        );
        ctx.status(`Watching ${name} (${mode}, profile ${ctx.profile.id}). Ctrl-C to stop.`);

        let signals = 0;
        const onSignal = () => {
          signals += 1;
          if (signals === 1) {
            ctx.status("Stopping...");
            session.stop("signal");
            return;
          }
          ctx.warn(
            "Forced exit: the server subscription (if any) remains until its TTL expires.",
          );
          process.exit(130);
        };
        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
        try {
          return await session.run();
        } finally {
          process.removeListener("SIGINT", onSignal);
          process.removeListener("SIGTERM", onSignal);
        }
      } finally {
        pushRuntime?.close();
        await receiver?.close();
      }
    });

    reportWatchResult(result, ctx);
  });
}

function reportWatchResult(result: EventsWatchResult, ctx: EventsContext): void {
  ctx.status(
    `Stopped (${result.stopReason}) after ${result.events} event${result.events === 1 ? "" : "s"}.`,
  );
  if (result.exitCode === 0) return;
  if (result.failure) {
    throw cliError(
      result.stopReason === "terminated" ? "EVENTS_TERMINATED" : "EVENTS_WATCH_FAILED",
      redactSecrets(result.failure.message),
      1,
      {
        kind: result.failure.kind,
        stopReason: result.stopReason,
        observedState: result.record.observedState,
        events: result.events,
        removed: result.removed,
      },
    );
  }
  throw cliError(
    "EVENTS_UNSUBSCRIBE_FAILED",
    "The watch stopped but the unsubscribe could not be confirmed; the server subscription may remain until its TTL expires.",
    1,
    { stopReason: result.stopReason, events: result.events },
  );
}
