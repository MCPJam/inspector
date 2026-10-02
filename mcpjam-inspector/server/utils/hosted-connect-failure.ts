/**
 * What a hosted response may say about a failed connection to the caller's MCP
 * server, or a failed operation on it (MJ-001).
 *
 * A failure's own text can quote whatever the server answered — a response
 * body, a content type, a JSON-RPC error message. A hosted response reports
 * the status line instead: the HTTP status and a bounded reason phrase
 * of the answer, or the uniform transport message when nothing answered. The
 * egress guard's refusal keeps its own wording, since it names only the host
 * the caller configured.
 *
 * Pure and mode-agnostic, like its siblings. Callers decide when it applies.
 */

import type { NormalizedError } from "@mcpjam/sdk";
import { BlockedEgressTargetError } from "./hosted-egress-guard.js";
import {
  HOSTED_TRANSPORT_FAILURE_DETAIL,
  redactHostedTransportFailureText,
} from "./hosted-doctor-redaction.js";
import {
  formatStatusLine,
  isPlainRecord,
  jsonRpcErrorMessage,
  parseHttpStatus,
  parseJsonRpcCode,
  parseProtocolVersion,
  projectHostedLogEnvelope,
  projectScopeChallenge,
} from "./hosted-upstream-projection.js";

export type HostedConnectFailure = {
  /** The sentence a hosted response carries in place of the failure's text. */
  message: string;
  /** The egress guard refused a hop, which is the caller's to fix (400). */
  blockedTarget: boolean;
};

/** How far the cause chain is followed before giving up. */
const MAX_CHAIN_NODES = 16;

/** A property read that cannot throw: error classes expose getters. */
function read(node: object, key: string): unknown {
  try {
    return (node as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** SDK-local errors, whose `data` the SDK wrote rather than a server. */
const SDK_ERROR_NAMES: ReadonlySet<string> = new Set([
  "SdkError",
  "SdkHttpError",
]);

/**
 * Breadth-first over an error and the errors it carries: `cause`, the
 * Streamable HTTP attempt kept beside an SSE fallback's failure, and the
 * wrapped cause of a protocol-negotiation error.
 */
function* errorChain(error: unknown): Generator<object> {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length > 0 && seen.size < MAX_CHAIN_NODES) {
    const current = queue.shift();
    if (typeof current !== "object" || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    yield current;
    queue.push(read(current, "cause"), read(current, "streamableCause"));
    const data = read(current, "data");
    if (
      SDK_ERROR_NAMES.has(String(read(current, "name"))) &&
      isPlainRecord(data)
    ) {
      queue.push(data.cause);
    }
  }
}

type StatusLine = { status: number; statusText?: unknown };

/**
 * The transport errors that keep an HTTP status in `code`. They set no
 * `name`, so they are known by class. On any other error `code` is not an
 * HTTP status.
 */
const HTTP_CODE_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "StreamableHTTPError",
  "SseError",
]);

function className(node: object): string | undefined {
  const constructor = read(node, "constructor");
  return typeof constructor === "function" ? constructor.name : undefined;
}

function httpStatusOf(node: object): number | undefined {
  return (
    parseHttpStatus(read(node, "statusCode")) ??
    parseHttpStatus(read(node, "status")) ??
    (HTTP_CODE_ERROR_CLASSES.has(className(node) ?? "")
      ? parseHttpStatus(read(node, "code"))
      : undefined)
  );
}

/**
 * Whether `node` is one of the MCP transport errors that raise on an HTTP
 * answer: the Streamable HTTP and SSE transports' own classes, or the SDK's
 * `SdkHttpError`.
 */
function isTransportHttpError(node: object): boolean {
  return (
    read(node, "name") === "SdkHttpError" ||
    HTTP_CODE_ERROR_CLASSES.has(className(node) ?? "")
  );
}

/**
 * The HTTP status the MCP server answered with, when an MCP transport error in
 * the chain carries one. Only those errors count: any other object with a
 * `status` (this server's own `WebRouteError`, a backend response) is not
 * evidence of what the MCP server said.
 */
export function upstreamTransportStatus(error: unknown): number | undefined {
  return transportStatusLine(error)?.status;
}

/** The status line an MCP transport error in the chain carries, if any. */
function transportStatusLine(error: unknown): StatusLine | undefined {
  for (const node of errorChain(error)) {
    if (!isTransportHttpError(node)) continue;
    const status = httpStatusOf(node);
    if (status === undefined) continue;
    const statusText = read(node, "statusText");
    return {
      status,
      statusText: typeof statusText === "string" ? statusText : undefined,
    };
  }
  return undefined;
}

/**
 * Whether a combined connect failure's only HTTP answer came from the SSE
 * fallback: the Streamable HTTP attempt it carries (`streamableCause`) got no
 * HTTP status at all — it timed out or never connected. A modern-only server
 * answers the fallback GET with 405, so that status is not why it failed.
 */
export function onlyFallbackAnswered(error: unknown): boolean {
  const attempts = combinedAttempts(error);
  return (
    attempts !== undefined &&
    upstreamTransportStatus(attempts.streamable) === undefined
  );
}

/**
 * A combined connect failure's two attempts: the Streamable HTTP request
 * (`streamableCause`) and the SSE fallback (`cause`) beside it.
 */
function combinedAttempts(
  error: unknown,
): { streamable: unknown; fallback: unknown } | undefined {
  for (const node of errorChain(error)) {
    const streamable = read(node, "streamableCause");
    if (streamable === undefined) continue;
    return { streamable, fallback: read(node, "cause") };
  }
  return undefined;
}

function statusLineFromChain(error: unknown): StatusLine | undefined {
  for (const node of errorChain(error)) {
    const name = read(node, "name");
    // An auth failure's status is derived from its cause, which the walk
    // reaches next.
    if (name === "MCPAuthError") continue;
    const status = httpStatusOf(node);
    if (status !== undefined) {
      const statusText = read(node, "statusText");
      return {
        status,
        statusText: typeof statusText === "string" ? statusText : undefined,
      };
    }
    if (name === "UnauthorizedError") return { status: 401 };
  }
  return undefined;
}

/**
 * The last HTTP answer recorded in a hosted `_httpLogs` envelope — the last
 * one with `status`, when given.
 */
function statusLineFromLogs(
  logs: Record<string, unknown> | undefined,
  status?: number,
): StatusLine | undefined {
  const events = Array.isArray(logs?._httpLogs) ? logs._httpLogs : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const exchange = isPlainRecord(event) ? event.exchange : undefined;
    if (!isPlainRecord(exchange)) continue;
    const response = isPlainRecord(exchange.response)
      ? exchange.response
      : undefined;
    if (!response) {
      // The last exchange never got an answer (rejected fetch — the SDK logs
      // it without a response). An EARLIER answer's status must not be
      // attributed to this failure; the caller reports the uniform transport
      // message instead. Completing a reason phrase for a status the error
      // itself carries may keep scanning back.
      if (status === undefined) return undefined;
      continue;
    }
    const logged = parseHttpStatus(response.status);
    if (logged !== undefined && (status === undefined || logged === status)) {
      return { status: logged, statusText: response.statusText };
    }
  }
  return undefined;
}

/**
 * The status line the error carries, completed from the logs when the error
 * has the status but not its reason phrase; otherwise the last logged answer.
 */
function findStatusLine(
  error: unknown,
  logs: Record<string, unknown> | undefined,
): StatusLine | undefined {
  const fromChain = statusLineFromChain(error);
  if (!fromChain) return statusLineFromLogs(logs);
  return completeStatusLine(fromChain, logs);
}

/** A status line with its reason phrase filled in from the logs if missing. */
function completeStatusLine(
  line: StatusLine,
  logs: Record<string, unknown> | undefined,
): StatusLine {
  if (typeof line.statusText === "string") return line;
  return statusLineFromLogs(logs, line.status) ?? line;
}

/**
 * Both answers of a combined connect failure whose two attempts failed with
 * DIFFERENT HTTP error statuses — a Streamable HTTP 500, then the SSE
 * fallback's 405. Reporting one status would let the fallback's hide the real
 * request's. Only statuses the attempts themselves carry count, never the logs'
 * last answer.
 */
function bothAttemptStatusLines(
  error: unknown,
  logs: Record<string, unknown> | undefined,
): { streamable: StatusLine; fallback: StatusLine } | undefined {
  const attempts = combinedAttempts(error);
  if (!attempts) return undefined;
  // Only a status an MCP transport error carries, as `upstreamTransportStatus`
  // reads it: anything else in either attempt's chain is not the server's
  // answer.
  const streamable = transportStatusLine(attempts.streamable);
  const fallback = transportStatusLine(attempts.fallback);
  if (
    !streamable ||
    !fallback ||
    streamable.status < 400 ||
    fallback.status < 400 ||
    streamable.status === fallback.status
  ) {
    return undefined;
  }
  return {
    streamable: completeStatusLine(streamable, logs),
    fallback: completeStatusLine(fallback, logs),
  };
}

function findEgressRefusal(error: unknown): string | undefined {
  for (const node of errorChain(error)) {
    const message = read(node, "message");
    if (
      (node instanceof BlockedEgressTargetError ||
        read(node, "name") === "BlockedEgressTargetError") &&
      typeof message === "string"
    ) {
      return message;
    }
  }
  return undefined;
}

const REFUSED_HOST = '"(?:[a-z0-9.:%_\\[\\]-]+|an unparseable URL)"';

/**
 * The pinned transport's own refusals that are not address verdicts, in their
 * exact wording. Like the address verdicts, they name only a host.
 */
const TRANSPORT_REFUSALS: readonly RegExp[] = [
  new RegExp(
    `^Refusing a plaintext connection to ${REFUSED_HOST}(?:: (?:it is a public host, so )?the target must be served over https)?\\.$`,
    "i",
  ),
  new RegExp(
    `^Refusing a connection to loopback address ${REFUSED_HOST}\\.$`,
    "i",
  ),
  /^Too many redirects \(more than \d+\)\.$/,
];

function describeRefusal(message: string): string {
  return TRANSPORT_REFUSALS.some((pattern) => pattern.test(message))
    ? message
    : redactHostedTransportFailureText(message);
}

/** What a hosted response says when a request to the server timed out. */
export const HOSTED_REQUEST_TIMEOUT_DETAIL =
  "The MCP server did not respond in time.";

/** JSON-RPC's `RequestTimeout`, which the v1 MCP SDK raises locally. */
const JSONRPC_REQUEST_TIMEOUT = -32001;
/** The v2 MCP SDK's own timeout code. */
const SDK_REQUEST_TIMEOUT = "REQUEST_TIMEOUT";
/** The error names a JSON-RPC error answer arrives under. */
const JSONRPC_ERROR_NAMES: ReadonlySet<string> = new Set([
  "McpError",
  "ProtocolError",
]);

/**
 * A request the client gave up waiting on. Recognized by the SDKs' own codes
 * and the platform's `TimeoutError`, never by wording.
 */
function isRequestTimeout(error: unknown): boolean {
  for (const node of errorChain(error)) {
    const name = String(read(node, "name"));
    const code = read(node, "code");
    if (name === "TimeoutError") return true;
    if (JSONRPC_ERROR_NAMES.has(name) && code === JSONRPC_REQUEST_TIMEOUT) {
      return true;
    }
    if (SDK_ERROR_NAMES.has(name) && code === SDK_REQUEST_TIMEOUT) return true;
  }
  return false;
}

/**
 * A JSON-RPC error the server answered an operation with, when it is the
 * failure itself (not a cause under a connection error). Any 32-bit integer
 * code counts, including the ones a server defines for itself. Reported by
 * code, with fixed wording.
 */
function operationJsonRpcError(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (!JSONRPC_ERROR_NAMES.has(String(read(error, "name")))) return undefined;
  return parseJsonRpcCode(read(error, "code"));
}

/** Errors raised by the MCP client, its transports, or its auth flow. */
const MCP_CLIENT_ERROR_NAMES: ReadonlySet<string> = new Set([
  ...JSONRPC_ERROR_NAMES,
  ...SDK_ERROR_NAMES,
  "UnauthorizedError",
  "MCPAuthError",
  "ProtocolVersionPinUnsupported",
  "BlockedEgressTargetError",
]);

/** Socket and fetch failure codes: Node's `E…` system codes and undici's. */
const NETWORK_ERROR_CODE = /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+)$/;

/**
 * Whether anything in the error or its causes shows it came from talking to
 * an MCP server: an HTTP status, an error the MCP client, its transports or
 * `fetch` raise, a network failure code, an aborted or timed-out request, or
 * the egress guard's refusal. A failure without any of this is this server's
 * own work failing, like a headless render.
 */
export function hasUpstreamFailureEvidence(error: unknown): boolean {
  for (const node of errorChain(error)) {
    if (node instanceof BlockedEgressTargetError) return true;
    const name = String(read(node, "name"));
    if (MCP_CLIENT_ERROR_NAMES.has(name)) return true;
    if (HTTP_CODE_ERROR_CLASSES.has(className(node) ?? "")) return true;
    if (httpStatusOf(node) !== undefined) return true;
    const code = read(node, "code");
    if (typeof code === "string" && NETWORK_ERROR_CODE.test(code)) return true;
    if (name === "TypeError" && read(node, "message") === "fetch failed") {
      return true;
    }
    if (
      typeof DOMException !== "undefined" &&
      node instanceof DOMException &&
      (name === "AbortError" || name === "TimeoutError")
    ) {
      return true;
    }
  }
  return false;
}

const MAX_OFFERED_VERSIONS = 8;

/**
 * A connection pinned to a protocol version the server does not offer. The
 * pinned version is this client's setting; the versions the server offered
 * are kept only when each is a well-formed version string.
 */
function describeVersionPinRefusal(error: unknown): string | undefined {
  for (const node of errorChain(error)) {
    if (read(node, "name") !== "ProtocolVersionPinUnsupported") continue;
    const pinned = parseProtocolVersion(read(node, "protocolVersion"));
    if (pinned === undefined) return undefined;
    const offered = read(node, "supportedVersions");
    const versions = Array.isArray(offered)
      ? offered
          .slice(0, MAX_OFFERED_VERSIONS)
          .map(parseProtocolVersion)
          .filter((version): version is string => version !== undefined)
      : [];
    return `The MCP server doesn't support MCP protocol version ${pinned}, which this client is pinned to.${
      versions.length > 0 ? ` It offers ${versions.join(", ")}.` : ""
    }`;
  }
  return undefined;
}

/**
 * The status-line-only account of a failed connection or operation. `logs` is
 * the hosted log envelope of the same request, consulted when the error itself
 * carries no status — a 200 answer that was not MCP, for instance.
 *
 * Without an HTTP status on the error, three failures are worded from what
 * this client knows rather than from the logs: a version pin the server does
 * not offer, a request that timed out, and a JSON-RPC error answering the
 * operation, which is reported by its code.
 */
export function describeHostedConnectFailure(
  error: unknown,
  logs?: Record<string, unknown>,
): HostedConnectFailure {
  const refusal = findEgressRefusal(error);
  if (refusal !== undefined) {
    return { message: describeRefusal(refusal), blockedTarget: true };
  }
  const pinRefusal = describeVersionPinRefusal(error);
  if (pinRefusal !== undefined) {
    return { message: pinRefusal, blockedTarget: false };
  }
  if (statusLineFromChain(error) === undefined) {
    if (isRequestTimeout(error)) {
      return { message: HOSTED_REQUEST_TIMEOUT_DETAIL, blockedTarget: false };
    }
    const code = operationJsonRpcError(error);
    if (code !== undefined) {
      return {
        message: `The MCP server answered with JSON-RPC error ${code} (${jsonRpcErrorMessage(code)}).`,
        blockedTarget: false,
      };
    }
  }
  const both = bothAttemptStatusLines(error, logs);
  if (both) {
    return {
      message: `The MCP server responded with ${formatStatusLine(
        both.streamable.status,
        both.streamable.statusText,
      )}, then with ${formatStatusLine(
        both.fallback.status,
        both.fallback.statusText,
      )} to the SSE fallback.`,
      blockedTarget: false,
    };
  }
  const answer = findStatusLine(error, logs);
  if (!answer) {
    return { message: HOSTED_TRANSPORT_FAILURE_DETAIL, blockedTarget: false };
  }
  const line = formatStatusLine(answer.status, answer.statusText);
  return {
    message:
      answer.status >= 200 && answer.status < 300
        ? `The MCP server responded with ${line}, but not with a valid MCP response.`
        : `The MCP server responded with ${line}.`,
    blockedTarget: false,
  };
}

const RAW_CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * A `NormalizedError` that says `message` where it carried the failure's own
 * text. The catalog entry — slug, title, causes, next steps — is fixed copy
 * and stays; `rawMessage` becomes `message`, a one-line promoted from the raw
 * text does too, and `cause` is dropped.
 */
export function redactNormalizedError(
  normalized: NormalizedError,
  message: string,
): NormalizedError {
  const rawCode = normalized.rawCode;
  return {
    slug: normalized.slug,
    title: normalized.title,
    oneLine:
      normalized.slug === "internal/unknown" ? message : normalized.oneLine,
    likelyCauses: normalized.likelyCauses,
    nextSteps: normalized.nextSteps,
    docsAnchor: normalized.docsAnchor,
    severity: normalized.severity,
    ...(normalized.origin !== undefined ? { origin: normalized.origin } : {}),
    rawMessage: message,
    ...(typeof rawCode === "number" ||
    (typeof rawCode === "string" && RAW_CODE_PATTERN.test(rawCode))
      ? { rawCode }
      : {}),
  };
}

/** Flags this server sets on a mapped failure; they carry no answer text. */
const FAILURE_DETAIL_FLAGS = ["upstreamAuthRequired", "oauthRequired"] as const;

/**
 * The details a hosted connection failure may carry: the flags above, and a
 * scope challenge through its projection. Anything else is dropped.
 */
export function projectHostedConnectFailureDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const projected: Record<string, unknown> = {};
  for (const flag of FAILURE_DETAIL_FLAGS) {
    if (details[flag] === true) projected[flag] = true;
  }
  const insufficientScope = projectScopeChallenge(details.insufficientScope);
  if (insufficientScope) projected.insufficientScope = insufficientScope;
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/**
 * The log envelope of a hosted connection — failed or successful — reduced
 * like a probe answer: allowlisted headers, bounded status text, frames
 * without their content, and transport errors as
 * {@link describeHostedConnectFailure} words them.
 */
export function projectHostedConnectFailureLogs(
  logs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return projectHostedLogEnvelope(logs, redactHostedTransportFailureText);
}

/**
 * The log envelope of a SUCCESSFUL hosted operation: its HTTP exchanges
 * reduced as {@link projectHostedConnectFailureLogs} reduces them — allowlisted
 * response headers, request header values only for protocol headers — and its
 * JSON-RPC frames as they are, since they are the operation's own result.
 */
export function projectHostedSuccessLogs(
  logs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!logs || !Array.isArray(logs._httpLogs)) return logs;
  const { _httpLogs, _httpLogsOmitted: _omitted, ...rest } = logs;
  return {
    ...rest,
    ...projectHostedLogEnvelope(
      { _httpLogs },
      redactHostedTransportFailureText,
    ),
  };
}
