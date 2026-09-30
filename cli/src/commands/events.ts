import { randomBytes } from "node:crypto";
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import type { MCPClientManager } from "@mcpjam/sdk";
import {
  computeBindingKey,
  createManagerPushPort,
  EventsCoordinator,
  EventsPushRuntime,
  generateWebhookSecret,
  isValidWebhookSecret,
  MemoryEventInbox,
  selectDeliveryMode,
  type DeliveryMode,
  type EventsProfile,
  type EventsRpcPort,
  type PushConnectionPort,
  type SubscriptionRecord,
} from "@mcpjam/sdk/events";
import { withEphemeralManager } from "../lib/ephemeral.js";
import {
  applyEventsProtocolVersion,
  assertEventsDeclaredOrForced,
  checkCallbackUrl,
  describeDeliveryMismatch,
  insecureModeWarning,
  listAllServerEvents,
  parseDurationSeconds,
  parseEventArguments,
  parseEventsProfile,
  parseListenAddress,
  redactSecrets,
  withEventsErrors,
} from "../lib/events-cli.js";
import { startEventsReceiver, type EventsReceiverHandle } from "../lib/events-receiver.js";
import { EventsWatchSession, type EventsWatchResult } from "../lib/events-watch.js";
import {
  parseConformanceCheckIds,
  parseConformanceEventArguments,
  planConformanceReceiver,
  renderEventsConformanceTable,
  runEventsConformanceForCli,
} from "../lib/events-conformance.js";
import { conformanceExitCode } from "../lib/conformance-exit-code.js";
import { resolveHostFromOptions } from "../lib/host-resolve.js";
import {
  cliError,
  setProcessExitCode,
  usageError,
  writeResult,
} from "../lib/output.js";
import { createCliRpcLogCollector, type CliRpcLogCollector } from "../lib/rpc-logs.js";
import { withRpcLogsIfRequested } from "../lib/rpc-helpers.js";
import {
  addHostOption,
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseJsonRecord,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parseRetryPolicy,
  parseServerConfig,
  type GlobalOptions,
  type SharedServerTargetOptions,
} from "../lib/server-config.js";

/**
 * `mcpjam events` — MCP Events (triggers), draft@28ec35e.
 *
 * Every verb connects directly to the server you name, like `tools call`.
 * The lifecycle rules live in `@mcpjam/sdk/events` (coordinator, push runtime,
 * in-memory inbox); these commands are a terminal front end for them.
 */

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

export interface EventsWatchOptions extends EventsCommandOptions {
  mode?: string;
  duration?: number;
  listen?: string;
  publicUrl?: string;
  insecureLocalReceiver?: boolean;
}

export interface EventsSubscribeOptions extends EventsCommandOptions {
  callbackUrl?: string;
  ttlMs?: number;
  expiry?: boolean;
  secretFile?: string;
  insecureCallback?: boolean;
}

const WATCH_MODES = ["poll", "push", "webhook"] as const;

interface EventsContext {
  globalOptions: GlobalOptions;
  profile: EventsProfile;
  collector?: CliRpcLogCollector;
  target: string;
  /** Progress text on stderr; suppressed by `--quiet`. */
  status: (message: string) => void;
  /** Warnings on stderr; never suppressed. */
  warn: (message: string) => void;
}

function buildContext(
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
async function withEventsConnection<T>(
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
function writeEventsResult(value: unknown, ctx: EventsContext): void {
  const withLogs = withRpcLogsIfRequested(value, ctx.collector, ctx.globalOptions);
  writeResult(
    JSON.parse(redactSecrets(JSON.stringify(withLogs))),
    ctx.globalOptions.format,
  );
}

function addEventsTargetOptions(command: Command): Command {
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

function addEventArgsOption(command: Command): Command {
  return command.option(
    "--event-args <json>",
    "Event arguments as a JSON object, @path, or - for stdin (default {})",
  );
}

function positiveInteger(label: string) {
  return (value: string) => parsePositiveInteger(value, label);
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

function registerList(events: Command): void {
  addEventsTargetOptions(
    events
      .command("list")
      .description(
        "Report the server's events capability and every event type it offers (events/list, all pages). Exits 2 when the server did not declare capabilities.events, unless --force.",
      ),
  ).action(async (options: EventsCommandOptions, command: Command) => {
    const ctx = buildContext(options, command);
    const result = await withEventsConnection(options, ctx, async (manager, serverId) => {
      const support = assertEventsDeclaredOrForced(manager, serverId, {
        force: options.force,
        serverLabel: ctx.target,
        warn: ctx.warn,
      });
      const captured = manager.getCapturedEventsCapability(serverId);
      const eventTypes = await withEventsErrors("events/list", () =>
        listAllServerEvents(manager, serverId, { allowUndeclared: options.force }),
      );
      return {
        support,
        rawCapabilities: captured?.rawCapabilities ?? null,
        ...(captured?.protocolVersion ? { protocolVersion: captured.protocolVersion } : {}),
        profile: ctx.profile.id,
        events: eventTypes,
      };
    });
    writeEventsResult(result, ctx);
  });
}

// ---------------------------------------------------------------------------
// poll
// ---------------------------------------------------------------------------

function registerPoll(events: Command): void {
  addEventsTargetOptions(
    addEventArgsOption(
      events
        .command("poll")
        .description(
          "Send one events/poll and print the result. A null cursor (the default) starts from now: it returns no events, only the cursor to poll from next.",
        )
        .argument("<name>", "Event name, from `events list`")
        .option("--cursor <cursor>", "Resume from this cursor (default: null, start from now)")
        .option("--max-events <n>", "maxEvents for the request", positiveInteger("Max events"))
        .option("--max-age-ms <ms>", "maxAgeMs for the request", (value: string) =>
          parseNonNegativeInteger(value, "Max age"),
        ),
    ),
  ).action(async (name: string, options: EventsCommandOptions, command: Command) => {
    const ctx = buildContext(options, command);
    const eventArguments = parseEventArguments(options.eventArgs);
    if (!ctx.profile.deliveryModes.value.includes("poll")) {
      ctx.status(
        `Note: profile ${ctx.profile.id} never polls (it uses ${ctx.profile.deliveryModes.value.join(", ")}); this poll is a direct probe of the server.`,
      );
    }
    const result = await withEventsConnection(options, ctx, async (manager, serverId) => {
      assertEventsDeclaredOrForced(manager, serverId, {
        force: options.force,
        serverLabel: ctx.target,
        warn: ctx.warn,
      });
      return withEventsErrors("events/poll", () =>
        manager.pollServerEvents(
          serverId,
          {
            name,
            arguments: eventArguments,
            cursor: options.cursor ?? null,
            ...(options.maxEvents !== undefined ? { maxEvents: options.maxEvents } : {}),
            ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
          },
          { allowUndeclared: options.force },
        ),
      );
    });
    writeEventsResult(result, ctx);
  });
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

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

function registerWatch(events: Command): void {
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

// ---------------------------------------------------------------------------
// subscribe / unsubscribe
// ---------------------------------------------------------------------------

interface ResolvedSecret {
  secret: string;
  source: "file" | "generated";
  path?: string;
}

/**
 * The only place a secret is written is `--secret-file`, created 0600. An
 * existing non-empty file is READ instead, so re-running `subscribe` with the
 * same file refreshes the same subscription with the same secret.
 */
function resolveSecret(secretFile: string | undefined, ctx: EventsContext): ResolvedSecret {
  if (secretFile === undefined) {
    ctx.warn(
      "Warning: no --secret-file, so the generated webhook secret is not saved anywhere and your receiver cannot verify deliveries. Pass --secret-file <path> to keep it.",
    );
    return { secret: generateWebhookSecret(), source: "generated" };
  }
  let existing: string | undefined;
  try {
    const stats = statSync(secretFile);
    if (stats.isDirectory()) throw usageError(`--secret-file is a directory: ${secretFile}`);
    existing = readFileSync(secretFile, "utf8").trim();
    if (existing && (stats.mode & 0o077) !== 0) {
      ctx.warn(
        `Warning: ${secretFile} is readable by other users (mode ${(stats.mode & 0o777).toString(8)}); chmod 600 it.`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (error instanceof Error && error.name === "CliError") throw error;
      throw usageError(`Cannot read --secret-file ${secretFile}.`, {
        source: (error as NodeJS.ErrnoException).code ?? String(error),
      });
    }
  }
  if (existing) {
    if (!isValidWebhookSecret(existing)) {
      throw usageError(
        `--secret-file ${secretFile} does not hold a valid webhook secret (whsec_ + base64 of 24–64 bytes).`,
      );
    }
    return { secret: existing, source: "file", path: secretFile };
  }
  const secret = generateWebhookSecret();
  try {
    writeFileSync(secretFile, `${secret}\n`, { mode: 0o600 });
    // `mode` applies only on creation; an existing empty file keeps its own.
    chmodSync(secretFile, 0o600);
  } catch (error) {
    throw usageError(`Cannot write --secret-file ${secretFile}.`, {
      source: (error as NodeJS.ErrnoException).code ?? String(error),
    });
  }
  return { secret, source: "generated", path: secretFile };
}

function defaultTtlMs(profile: EventsProfile): number | null | undefined {
  const requested = profile.requestedTtlMs.value;
  return typeof requested === "number" || requested === null ? requested : undefined;
}

function registerSubscribe(events: Command): void {
  addEventsTargetOptions(
    addEventArgsOption(
      events
        .command("subscribe")
        .description(
          "Send one events/subscribe for a webhook receiver you run yourself, and print the result. The secret is generated unless --secret-file already holds one, and is written only to --secret-file (0600) — never printed.",
        )
        .argument("<name>", "Event name, from `events list`")
        .option("--callback-url <url>", "Your receiver's https callback URL (required)")
        .option("--ttl-ms <ms>", "Requested subscription lifetime", positiveInteger("TTL"))
        .option("--no-expiry", "Request no expiry (ttlMs: null)")
        .option(
          "--secret-file <path>",
          "Read the webhook secret from this file, or write a newly generated one to it (mode 0600)",
        )
        .option("--cursor <cursor>", "Replay from this cursor (default: null, start from now)")
        .option("--max-age-ms <ms>", "maxAgeMs for the request", (value: string) =>
          parseNonNegativeInteger(value, "Max age"),
        )
        .option(
          "--insecure-callback",
          "Allow a plain-http --callback-url. NON-CONFORMANT development mode; never a conformance pass.",
        ),
    ),
  ).action(async (name: string, options: EventsSubscribeOptions, command: Command) => {
    const ctx = buildContext(options, command);
    const eventArguments = parseEventArguments(options.eventArgs);
    if (!options.callbackUrl) throw usageError("--callback-url is required.");
    const callback = checkCallbackUrl(options.callbackUrl, {
      flag: "--callback-url",
      insecureFlag: "--insecure-callback",
      allowInsecure: options.insecureCallback === true,
    });
    if (options.ttlMs !== undefined && options.expiry === false) {
      throw usageError("Pass --ttl-ms or --no-expiry, not both.");
    }
    const ttlMs = options.expiry === false ? null : (options.ttlMs ?? defaultTtlMs(ctx.profile));
    if (callback.insecure) {
      ctx.warn(insecureModeWarning("--insecure-callback", callback.url.toString()));
    }
    const secret = resolveSecret(options.secretFile, ctx);

    const result = await withEventsConnection(options, ctx, async (manager, serverId) => {
      assertEventsDeclaredOrForced(manager, serverId, {
        force: options.force,
        serverLabel: ctx.target,
        warn: ctx.warn,
      });
      return withEventsErrors("events/subscribe", () =>
        manager.subscribeServerEvents(
          serverId,
          {
            name,
            arguments: eventArguments,
            delivery: { url: callback.url.toString(), secret: secret.secret },
            cursor: options.cursor ?? null,
            ...(options.maxAgeMs !== undefined ? { maxAgeMs: options.maxAgeMs } : {}),
            ...(ttlMs !== undefined ? { ttlMs } : {}),
          },
          { allowUndeclared: options.force },
        ),
      );
    });
    ctx.status(
      secret.path
        ? `Subscribed. Webhook secret ${secret.source === "file" ? "read from" : "written to"} ${secret.path}.`
        : "Subscribed.",
    );
    writeEventsResult(result, ctx);
  });
}

function registerUnsubscribe(events: Command): void {
  addEventsTargetOptions(
    addEventArgsOption(
      events
        .command("unsubscribe")
        .description(
          'Send events/unsubscribe for a webhook subscription and print {"outcome": "removed" | "already-gone"}',
        )
        .argument("<name>", "Event name the subscription is for")
        .option("--callback-url <url>", "The callback URL the subscription was made with (required)"),
    ),
  ).action(async (name: string, options: EventsSubscribeOptions, command: Command) => {
    const ctx = buildContext(options, command);
    const eventArguments = parseEventArguments(options.eventArgs);
    if (!options.callbackUrl) throw usageError("--callback-url is required.");
    let url: URL;
    try {
      url = new URL(options.callbackUrl);
    } catch {
      throw usageError(`--callback-url is not a valid URL: ${options.callbackUrl}`);
    }
    const outcome = await withEventsConnection(options, ctx, async (manager, serverId) => {
      assertEventsDeclaredOrForced(manager, serverId, {
        force: options.force,
        serverLabel: ctx.target,
        warn: ctx.warn,
      });
      return withEventsErrors("events/unsubscribe", () =>
        manager.unsubscribeServerEvents(
          serverId,
          { name, arguments: eventArguments, delivery: { url: url.toString() } },
          { allowUndeclared: options.force },
        ),
      );
    });
    writeEventsResult({ outcome }, ctx);
  });
}

// ---------------------------------------------------------------------------
// conformance
// ---------------------------------------------------------------------------

export interface EventsConformanceOptions extends EventsTargetOptions {
  eventArgs?: string[];
  triggerTool?: string;
  triggerArgs?: string;
  waitMs?: number;
  tlsCert?: string;
  tlsKey?: string;
  publicUrl?: string;
  listen?: string;
  insecureLocalReceiver?: boolean;
  checks?: string[];
  heartbeatWaitMs?: number;
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function registerConformance(events: Command): void {
  addHostOption(
    addRetryOptions(
      addSharedServerOptions(
        events
          .command("conformance")
          .description(
            "Run the profile-aware MCP Events conformance checks (MUST fails, SHOULD warns). " +
              "Result JSON on stdout, a table on stderr. Exit 0 passed, 1 failed, 3 incomplete.",
          )
          .option(
            "--profile <profile>",
            'Profile to judge by: "draft" (draft@28ec35e) or "chatgpt" (chatgpt@2026-09-30)',
            "draft",
          )
          .option(
            "--protocol-version <version>",
            "Pin the MCP protocol version (e.g. 2026-07-28). HTTP targets only.",
          )
          .option(
            "--event-args <name=json>",
            "Subscription arguments for one event type, as <eventName>=<json>. Repeat for several. Required fields are never invented.",
            collect,
            [],
          )
          .option(
            "--trigger-tool <name>",
            "A tool whose call makes the server emit a matching event (needed for the delivery checks)",
          )
          .option("--trigger-args <json>", "Arguments for --trigger-tool, as a JSON object")
          .option(
            "--wait-ms <ms>",
            "How long to wait for a delivery after triggering (default 5000)",
            positiveInteger("Wait"),
          )
          .option("--tls-cert <path>", "PEM certificate for an https receiver (with --tls-key)")
          .option("--tls-key <path>", "PEM private key for an https receiver (with --tls-cert)")
          .option(
            "--public-url <origin>",
            "https origin that forwards to the receiver (e.g. a tunnel)",
          )
          .option(
            "--listen <host:port>",
            "Where the receiver listens (default 127.0.0.1:0)",
          )
          .option(
            "--insecure-local-receiver",
            "Use a plain-http receiver. NON-CONFORMANT: the run is labelled and can never pass.",
          )
          .option(
            "--checks <ids>",
            "Comma-separated check ids to run (default: all but events-push-heartbeat)",
            collect,
            [],
          )
          .option(
            "--heartbeat-wait-ms <ms>",
            "events-push-heartbeat wait window (default 65000)",
            positiveInteger("Heartbeat wait"),
          ),
      ),
    ),
  ).action(async (options: EventsConformanceOptions, command: Command) => {
    const ctx = buildContext(options, command);
    const eventArguments = parseConformanceEventArguments(options.eventArgs);
    const checkIds = parseConformanceCheckIds(options.checks);
    const receiverPlan = planConformanceReceiver(options);
    if (options.triggerArgs !== undefined && !options.triggerTool) {
      throw usageError("--trigger-args requires --trigger-tool.");
    }
    const triggerArgs = parseJsonRecord(options.triggerArgs, "--trigger-args") ?? {};
    if (receiverPlan?.insecure) {
      ctx.warn(
        insecureModeWarning(
          "--insecure-local-receiver",
          receiverPlan.publicOrigin ?? `http://${receiverPlan.host}`,
        ),
      );
    }

    const result = await withEventsConnection(options, ctx, (manager, serverId) =>
      runEventsConformanceForCli({
        manager,
        serverId,
        profile: ctx.profile.id,
        ...(receiverPlan ? { receiverPlan } : {}),
        eventArguments,
        ...(options.triggerTool
          ? {
              triggerEvent: async (eventName: string) => {
                const tool = options.triggerTool!;
                ctx.status(`Triggering ${eventName} with tool ${tool}...`);
                try {
                  const outcome = (await manager.executeTool(
                    serverId,
                    tool,
                    triggerArgs as never,
                  )) as { isError?: unknown };
                  if (outcome?.isError === true) {
                    ctx.warn(`Warning: --trigger-tool ${tool} returned isError: true.`);
                  }
                } catch (error) {
                  // A failed trigger means no delivery: the runner reports the
                  // delivery checks as could-not-run rather than crashing.
                  ctx.warn(
                    `Warning: --trigger-tool ${tool} failed: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              },
            }
          : {}),
        ...(options.waitMs !== undefined ? { waitForEventMs: options.waitMs } : {}),
        ...(checkIds ? { checkIds } : {}),
        ...(options.heartbeatWaitMs !== undefined
          ? { pushHeartbeatWaitMs: options.heartbeatWaitMs }
          : {}),
        status: ctx.status,
      }),
    );

    writeEventsResult(result, ctx);
    ctx.status(renderEventsConformanceTable(result));
    const exitCode = conformanceExitCode(result);
    if (exitCode !== 0) setProcessExitCode(exitCode);
  });
}

export function registerEventsCommands(program: Command): void {
  const events = program
    .command("events")
    .description(
      "List, poll, watch, subscribe to and conformance-check MCP Events (triggers, draft@28ec35e)",
    );
  registerList(events);
  registerPoll(events);
  registerWatch(events);
  registerSubscribe(events);
  registerUnsubscribe(events);
  registerConformance(events);
}
