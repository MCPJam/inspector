import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Command } from "commander";
import {
  generateWebhookSecret,
  isValidWebhookSecret,
  type EventsProfile,
} from "@mcpjam/sdk/events";
import {
  assertEventsDeclaredOrForced,
  checkCallbackUrl,
  insecureModeWarning,
  listAllServerEvents,
  parseEventArguments,
  withEventsErrors,
} from "../lib/events-cli.js";
import {
  parseConformanceCheckIds,
  parseConformanceEventArguments,
  planConformanceReceiver,
  renderEventsConformanceTable,
  runEventsConformanceForCli,
} from "../lib/events-conformance.js";
import { conformanceExitCode } from "../lib/conformance-exit-code.js";
import { setProcessExitCode, usageError } from "../lib/output.js";
import {
  addHostOption,
  addRetryOptions,
  addSharedServerOptions,
  parseJsonRecord,
  parseNonNegativeInteger,
} from "../lib/server-config.js";
import {
  addEventArgsOption,
  addEventsTargetOptions,
  buildContext,
  positiveInteger,
  withEventsConnection,
  writeEventsResult,
  type EventsCommandOptions,
  type EventsContext,
  type EventsTargetOptions,
} from "./events-context.js";
import { registerWatch } from "./events-watch.js";

export type { EventsCommandOptions, EventsTargetOptions } from "./events-context.js";
export type { EventsWatchOptions } from "./events-watch.js";

/**
 * `mcpjam events` — MCP Events (triggers), draft@28ec35e.
 *
 * Every verb connects directly to the server you name, like `tools call`.
 * The lifecycle rules live in `@mcpjam/sdk/events` (coordinator, push runtime,
 * in-memory inbox); these commands are a terminal front end for them.
 */

export interface EventsSubscribeOptions extends EventsCommandOptions {
  callbackUrl?: string;
  ttlMs?: number;
  expiry?: boolean;
  secretFile?: string;
  insecureCallback?: boolean;
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
