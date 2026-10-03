/**
 * Shared plumbing for `mcpjam events` (MCP Events, draft@28ec35e).
 *
 * The protocol lives in the SDK: `@mcpjam/sdk/events` owns the wire schemas,
 * the coordinator (every lifecycle transition), the profiles and the in-memory
 * inbox. This module only turns CLI flags into those inputs, and SDK failures
 * into CLI errors — nothing here re-derives a lifecycle rule.
 *
 * Two rules every events command follows:
 *
 * - **A webhook secret never reaches stdout or stderr.** The only place a
 *   generated secret may be written is the file named by `--secret-file`.
 *   Every status line and error message is scrubbed with {@link redactSecrets}
 *   anyway, because a misbehaving server can quote a secret back inside an
 *   error message, and that sentence is exactly what a CLI prints.
 * - **Advertise = enforce.** `events/*` is not sent to a server that did not
 *   declare `capabilities.events` unless `--force` says so (the SDK's
 *   `allowUndeclared`), and the refusal is a usage-class exit (2).
 */

import {
  classifyEventsRpcError,
  isKnownProtocolVersion,
  isMCPEventsWireError,
  MCP_PROTOCOL_VERSIONS,
  type EventDescriptorWire,
  type EventsSupport,
  type MCPClientManager,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import {
  CHATGPT_PROFILE_ID,
  DRAFT_PROFILE_ID,
  getEventsProfile,
  type EventsProfile,
  type EventsProfileId,
} from "@mcpjam/sdk/events";
import { cliError, usageError, type CliError } from "./output.js";
import { parseJsonRecord } from "./server-config.js";

/** The short `--profile` names and the dated profile ids they select. */
export const EVENTS_PROFILE_ALIASES: Readonly<Record<string, EventsProfileId>> = {
  draft: DRAFT_PROFILE_ID,
  chatgpt: CHATGPT_PROFILE_ID,
  [DRAFT_PROFILE_ID]: DRAFT_PROFILE_ID,
  [CHATGPT_PROFILE_ID]: CHATGPT_PROFILE_ID,
};

export function parseEventsProfile(value: string | undefined): EventsProfile {
  const key = (value ?? "draft").trim();
  const id = EVENTS_PROFILE_ALIASES[key];
  if (!id) {
    throw usageError(
      `Unknown --profile "${key}". Use "draft" (${DRAFT_PROFILE_ID}) or "chatgpt" (${CHATGPT_PROFILE_ID}).`,
    );
  }
  return getEventsProfile(id);
}

/**
 * A `whsec_` secret anywhere in a string — the SDK's own RPC-log pattern
 * (`rpc-log-redaction.ts`), so a secret quoted inside prose is caught too.
 */
const WHSEC_SUBSTRING = /whsec_[A-Za-z0-9+/=_-]{8,}/g;
const REDACTED = "[redacted webhook secret]";

/** Scrub anything secret-shaped from text bound for a terminal. */
export function redactSecrets(text: string): string {
  return text.includes("whsec_") ? text.replace(WHSEC_SUBSTRING, REDACTED) : text;
}

/** `--event-args` as a JSON object (inline, `@path`, or `-` for stdin). */
export function parseEventArguments(
  value: string | undefined,
): Record<string, unknown> {
  return parseJsonRecord(value, "--event-args") ?? {};
}

/**
 * `--protocol-version`, as `apps conformance` takes it: a known literal, HTTP
 * targets only, and not together with `--host` (which pins its own).
 */
export function applyEventsProtocolVersion(
  config: MCPServerConfig,
  options: { protocolVersion?: string; host?: string },
): MCPServerConfig {
  const version = options.protocolVersion?.trim();
  if (options.protocolVersion === undefined) return config;
  if (!version || !isKnownProtocolVersion(version)) {
    throw usageError(
      `Unknown --protocol-version: ${version ?? ""}. Known: ${MCP_PROTOCOL_VERSIONS.join(", ")}`,
    );
  }
  if (!("url" in config) || !config.url) {
    throw usageError(
      "--protocol-version can only be used with an HTTP target (--url).",
    );
  }
  if (options.host) {
    throw usageError(
      "--host pins its own protocol version; pass --host or --protocol-version, not both.",
    );
  }
  return { ...config, mcpProtocolVersion: version } as MCPServerConfig;
}

/** Why the server's events capability refuses this command (exit 2). */
export function eventsNotDeclaredError(
  support: EventsSupport,
  serverLabel: string,
): CliError {
  const reason = support.handshakeObserved
    ? "the server did not declare `capabilities.events` in its handshake"
    : "the server's handshake was not observed on this connection, so its events capability is unknown";
  return cliError(
    "EVENTS_NOT_DECLARED",
    `Refusing to send events/* to ${serverLabel}: ${reason}. Pass --force to send it anyway (a conformance probe of an undeclared server).`,
    2,
    { support },
  );
}

/**
 * Check the declaration before anything reaches the wire. With `--force` an
 * undeclared server is warned about on stderr and the caller proceeds with
 * `allowUndeclared`.
 */
export function assertEventsDeclaredOrForced(
  manager: MCPClientManager,
  serverId: string,
  args: { force?: boolean; serverLabel: string; warn: (message: string) => void },
): EventsSupport {
  const support = manager.getEventsSupport(serverId);
  if (!support.declared) {
    if (!args.force) throw eventsNotDeclaredError(support, args.serverLabel);
    args.warn(
      "Warning: the server did not declare `capabilities.events`; sending events/* anyway because of --force.",
    );
  }
  return support;
}

/** Guard against a server that hands back the same `nextCursor` forever. */
const MAX_LIST_PAGES = 100;

/** `events/list`, every page. */
export async function listAllServerEvents(
  manager: MCPClientManager,
  serverId: string,
  options: { allowUndeclared?: boolean },
): Promise<EventDescriptorWire[]> {
  const events: EventDescriptorWire[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const result = await manager.listServerEvents(
      serverId,
      cursor !== undefined ? { cursor } : undefined,
      { allowUndeclared: options.allowUndeclared },
    );
    events.push(...result.events);
    // Presence, not truthiness: `""` is a valid continuation cursor.
    if (result.nextCursor === undefined) return events;
    if (seen.has(result.nextCursor)) {
      throw cliError(
        "EVENTS_LIST_CURSOR_LOOP",
        `events/list returned the cursor "${result.nextCursor}" twice; stopping instead of looping forever.`,
      );
    }
    seen.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  throw cliError(
    "EVENTS_LIST_TOO_MANY_PAGES",
    `events/list did not finish within ${MAX_LIST_PAGES} pages.`,
  );
}

/**
 * Map an SDK/server failure from an `events/*` request onto a CLI error: the
 * draft's error codes (`-32011`…`-32015`) get a stable `EVENTS_*` code, the
 * manager's own "not declared" refusal is exit 2, and every message is
 * scrubbed of secrets. Anything else is left for `normalizeCliError`.
 */
export function toEventsCliError(method: string, error: unknown): unknown {
  if (isMCPEventsWireError(error)) {
    return cliError("EVENTS_NOT_DECLARED", redactSecrets(error.message), 2);
  }
  const classified = classifyEventsRpcError(method, error);
  if (classified) {
    const code = `EVENTS_${classified.kind
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toUpperCase()}`;
    const message = redactSecrets(
      `${method} failed: ${classified.message || classified.kind} (${classified.code})`,
    );
    return cliError(code, message, 1, {
      method,
      code: classified.code,
      kind: classified.kind,
      retryable: classified.retryable,
      ...(classified.data !== undefined
        ? { data: JSON.parse(redactSecrets(JSON.stringify(classified.data))) }
        : {}),
    });
  }
  if (error instanceof Error && error.message.includes("whsec_")) {
    const scrubbed = new Error(redactSecrets(error.message));
    scrubbed.name = error.name;
    return scrubbed;
  }
  return error;
}

/** Run an `events/*` request, translating its failure with {@link toEventsCliError}. */
export async function withEventsErrors<T>(
  method: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toEventsCliError(method, error);
  }
}

export interface CallbackUrlCheck {
  url: URL;
  /** True for a plain-http URL accepted under the insecure flag. */
  insecure: boolean;
}

/**
 * The draft makes `https` a MUST for callback URLs. Plain http is accepted
 * only behind an explicit flag, and only ever as a labelled development mode.
 */
export function checkCallbackUrl(
  value: string,
  args: { flag: string; insecureFlag: string; allowInsecure: boolean },
): CallbackUrlCheck {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`${args.flag} is not a valid URL: ${value}`);
  }
  if (url.protocol === "https:") return { url, insecure: false };
  if (url.protocol !== "http:") {
    throw usageError(`${args.flag} must be an https:// URL (got ${url.protocol}).`);
  }
  if (!args.allowInsecure) {
    throw usageError(
      `${args.flag} must be https:// — the MCP Events draft requires https callback URLs. ` +
        `Pass ${args.insecureFlag} to use plain http for local development (NON-CONFORMANT; never a conformance pass).`,
    );
  }
  return { url, insecure: true };
}

export function insecureModeWarning(flag: string, url: string): string {
  return (
    `WARNING: ${flag} is a NON-CONFORMANT development mode. The callback URL ${url} is plain http; ` +
    "the MCP Events draft requires https, so a conformant server must refuse it. " +
    "Results from this mode never count as a conformance pass."
  );
}

/** Profile note when the event type cannot be delivered the way the profile needs. */
export function describeDeliveryMismatch(args: {
  profile: EventsProfile;
  descriptor: EventDescriptorWire;
  mode: string;
}): string {
  return (
    `Event "${args.descriptor.name}" advertises delivery [${args.descriptor.delivery.join(", ")}], ` +
    `and profile ${args.profile.id} uses [${args.profile.deliveryModes.value.join(", ")}]; ` +
    `"${args.mode}" is not usable under both.`
  );
}

/** Parse `--listen host:port` (`:port`, `host:port`, `[::1]:port`). */
export function parseListenAddress(value: string | undefined): {
  host: string;
  port: number;
} {
  if (value === undefined) return { host: "127.0.0.1", port: 0 };
  const trimmed = value.trim();
  const match = /^(?:\[([^\]]+)\]|([^:]*)):(\d{1,5})$/.exec(trimmed);
  if (!match) {
    throw usageError(`--listen must be host:port (got "${value}").`);
  }
  const host = match[1] ?? (match[2] || "127.0.0.1");
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw usageError(`--listen port must be 0–65535 (got ${match[3]}).`);
  }
  return { host, port };
}

/** Positive number of seconds (fractions allowed) → milliseconds. */
export function parseDurationSeconds(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw usageError("--duration must be a positive number of seconds.");
  }
  return Math.round(parsed * 1000);
}
