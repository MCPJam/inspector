/**
 * `mcpjam events conformance` — a terminal front end for the SDK's
 * profile-aware MCP Events conformance runner (`runEventsConformance`).
 *
 * The runner owns every check and verdict. This module only:
 *   - turns flags into the runner's inputs (per-event arguments, checks, a
 *     trigger that calls a tool);
 *   - starts the conformance receiver the webhook checks deliver to, when the
 *     flags make one reachable (local TLS, a public https origin, or the
 *     labelled plain-http override), and always closes it;
 *   - renders the human table.
 *
 * A run with no receiver is still useful — the capability, list, poll and
 * subscribe-refusal checks run — and the webhook checks report
 * `could-not-run`, which makes the outcome `incomplete`, never `passed`.
 */

import { readFileSync } from "node:fs";
import {
  EVENTS_CHECK_IDS,
  runEventsConformance,
  startEventsConformanceReceiver,
  type EventsCheckId,
  type EventsCheckResult,
  type EventsConformanceReceiver,
  type EventsConformanceResult,
  type MCPClientManager,
} from "@mcpjam/sdk";
import type { EventsProfileId } from "@mcpjam/sdk/events";
import { checkCallbackUrl, parseListenAddress, redactSecrets } from "./events-cli.js";
import { usageError } from "./output.js";
import { parseJsonRecord } from "./server-config.js";

export interface EventsConformanceReceiverPlan {
  tls?: { cert: string; key: string };
  publicOrigin?: string;
  host: string;
  port: number;
  /** Plain-http callback URLs: the runner labels the run and it cannot pass. */
  insecure: boolean;
}

/**
 * `--event-args <name>=<json>`, repeatable. The runner never invents
 * subscription arguments, so an event whose schema requires fields not
 * supplied here is reported `could-not-run` naming them.
 */
export function parseConformanceEventArguments(
  values: string[] | undefined,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const raw of values ?? []) {
    const separator = raw.indexOf("=");
    if (separator <= 0) {
      throw usageError(
        `--event-args must be <eventName>=<json> (got "${raw}"). Repeat it for several events.`,
      );
    }
    const name = raw.slice(0, separator).trim();
    const value = raw.slice(separator + 1);
    if (!name) throw usageError(`--event-args is missing the event name: "${raw}".`);
    if (name in out) throw usageError(`--event-args names "${name}" twice.`);
    out[name] = parseJsonRecord(value, `--event-args ${name}`) ?? {};
  }
  return out;
}

/** `--checks id,id` (comma-separated, repeatable), validated against the runner's ids. */
export function parseConformanceCheckIds(
  values: string[] | undefined,
): EventsCheckId[] | undefined {
  const ids = (values ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  const unknown = ids.filter(
    (id) => !(EVENTS_CHECK_IDS as readonly string[]).includes(id),
  );
  if (unknown.length > 0) {
    throw usageError(
      `Unknown check id${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}. Known: ${EVENTS_CHECK_IDS.join(", ")}`,
    );
  }
  return [...new Set(ids)] as EventsCheckId[];
}

function readPem(path: string, flag: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw usageError(`Cannot read ${flag} ${path}.`, {
      source: (error as NodeJS.ErrnoException).code ?? String(error),
    });
  }
}

/** Which receiver (if any) the webhook checks can use, from the flags. */
export function planConformanceReceiver(options: {
  tlsCert?: string;
  tlsKey?: string;
  publicUrl?: string;
  listen?: string;
  insecureLocalReceiver?: boolean;
}): EventsConformanceReceiverPlan | undefined {
  if ((options.tlsCert === undefined) !== (options.tlsKey === undefined)) {
    throw usageError("--tls-cert and --tls-key must be passed together.");
  }
  const tls =
    options.tlsCert !== undefined && options.tlsKey !== undefined
      ? {
          cert: readPem(options.tlsCert, "--tls-cert"),
          key: readPem(options.tlsKey, "--tls-key"),
        }
      : undefined;
  const insecureFlag = options.insecureLocalReceiver === true;
  if (tls && insecureFlag && options.publicUrl === undefined) {
    throw usageError(
      "--insecure-local-receiver serves plain http; it cannot be combined with --tls-cert/--tls-key.",
    );
  }
  if (!tls && options.publicUrl === undefined && !insecureFlag) {
    if (options.listen !== undefined) {
      throw usageError(
        "--listen needs a receiver: pass --tls-cert/--tls-key, --public-url, or --insecure-local-receiver.",
      );
    }
    return undefined;
  }
  let publicOrigin: string | undefined;
  let insecure = !tls && insecureFlag;
  if (options.publicUrl !== undefined) {
    const checked = checkCallbackUrl(options.publicUrl, {
      flag: "--public-url",
      insecureFlag: "--insecure-local-receiver",
      allowInsecure: insecureFlag,
    });
    if (checked.url.pathname !== "/" || checked.url.search || checked.url.hash) {
      throw usageError(
        "--public-url must be a bare origin (the conformance receiver serves /i/<inbox>/s/<slot> at the root).",
      );
    }
    publicOrigin = checked.url.origin;
    insecure = checked.insecure;
  }
  const listen = parseListenAddress(options.listen);
  return {
    ...(tls ? { tls } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
    host: listen.host,
    port: listen.port,
    insecure,
  };
}

export interface RunEventsConformanceForCliArgs {
  manager: MCPClientManager;
  serverId: string;
  profile: EventsProfileId;
  receiverPlan?: EventsConformanceReceiverPlan;
  eventArguments?: Record<string, Record<string, unknown>>;
  triggerEvent?: (eventName: string, args: Record<string, unknown>) => Promise<void>;
  waitForEventMs?: number;
  checkIds?: EventsCheckId[];
  pushHeartbeatWaitMs?: number;
  status?: (message: string) => void;
}

/** Start the receiver the plan asks for, run the SDK runner, close the receiver. */
export async function runEventsConformanceForCli(
  args: RunEventsConformanceForCliArgs,
): Promise<EventsConformanceResult> {
  let receiver: EventsConformanceReceiver | undefined;
  try {
    if (args.receiverPlan) {
      receiver = await startEventsConformanceReceiver({
        ...(args.receiverPlan.tls ? { tls: args.receiverPlan.tls } : {}),
        host: args.receiverPlan.host,
        port: args.receiverPlan.port,
        ...(args.receiverPlan.publicOrigin
          ? { publicOrigin: args.receiverPlan.publicOrigin }
          : {}),
      });
      args.status?.(`Conformance receiver: callback origin ${receiver.origin}.`);
    } else {
      args.status?.(
        "No webhook receiver (pass --tls-cert/--tls-key or --public-url): the webhook checks will report could-not-run.",
      );
    }
    return await runEventsConformance({
      manager: args.manager,
      serverId: args.serverId,
      profile: args.profile,
      ...(receiver ? { receiver } : {}),
      ...(args.eventArguments ? { eventArguments: args.eventArguments } : {}),
      ...(args.triggerEvent ? { triggerEvent: args.triggerEvent } : {}),
      ...(args.waitForEventMs !== undefined ? { waitForEventMs: args.waitForEventMs } : {}),
      ...(args.checkIds ? { checkIds: args.checkIds } : {}),
      ...(args.pushHeartbeatWaitMs !== undefined
        ? { pushHeartbeatWaitMs: args.pushHeartbeatWaitMs }
        : {}),
    });
  } finally {
    await receiver?.close();
  }
}

const STATUS_LABEL: Record<EventsCheckResult["status"], string> = {
  passed: "PASS",
  failed: "FAIL",
  warned: "WARN",
  skipped: "SKIP",
};

/** The human table for stderr. Never contains secrets. */
export function renderEventsConformanceTable(result: EventsConformanceResult): string {
  const idWidth = Math.max(...result.checks.map((check) => check.id.length), 10);
  const lines = [
    `MCP Events conformance — profile ${result.profile}${
      result.protocolVersion ? `, protocol ${result.protocolVersion}` : ""
    }`,
  ];
  for (const check of result.checks) {
    const note =
      check.status === "passed"
        ? ""
        : ` — ${check.skipReason ? `${check.skipReason}: ` : ""}${check.message}`;
    lines.push(
      `  ${STATUS_LABEL[check.status]}  ${check.strength.padEnd(6)}  ${check.id.padEnd(idWidth)}  ${check.title}${note}`,
    );
  }
  const { passed, failed, warned, skipped } = result.summary;
  lines.push(
    `Outcome: ${result.outcome} (${passed} passed, ${failed} failed, ${warned} warned, ${skipped} skipped)${
      result.overrides.length > 0
        ? `; overrides: ${result.overrides.join(", ")} (NON-CONFORMANT — never a pass)`
        : ""
    }`,
  );
  return redactSecrets(lines.join("\n"));
}
