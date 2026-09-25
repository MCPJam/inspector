/**
 * What a hosted response may say about a failed connection to the caller's MCP
 * server (MJ-001).
 *
 * A connection failure's own text can quote whatever the server answered — a
 * response body, a content type, a JSON-RPC error message. A hosted response
 * reports the status line instead: the HTTP status and a bounded reason phrase
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
  parseHttpStatus,
  projectHostedLogEnvelope,
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
    if (isPlainRecord(data)) queue.push(data.cause);
  }
}

type StatusLine = { status: number; statusText?: unknown };

function statusLineFromChain(error: unknown): StatusLine | undefined {
  for (const node of errorChain(error)) {
    const status =
      parseHttpStatus(read(node, "statusCode")) ??
      parseHttpStatus(read(node, "status")) ??
      parseHttpStatus(read(node, "code"));
    if (status !== undefined) {
      const statusText = read(node, "statusText");
      const data = read(node, "data");
      return {
        status,
        statusText:
          typeof statusText === "string"
            ? statusText
            : isPlainRecord(data)
              ? data.statusText
              : undefined,
      };
    }
    if (read(node, "name") === "UnauthorizedError") return { status: 401 };
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
    const response = isPlainRecord(exchange) ? exchange.response : undefined;
    if (!isPlainRecord(response)) continue;
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
  if (typeof fromChain.statusText === "string") return fromChain;
  return statusLineFromLogs(logs, fromChain.status) ?? fromChain;
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

/**
 * The status-line-only account of a failed connection. `logs` is the hosted
 * log envelope of the same request, consulted when the error itself carries
 * no status — a 200 answer that was not MCP, for instance.
 */
export function describeHostedConnectFailure(
  error: unknown,
  logs?: Record<string, unknown>,
): HostedConnectFailure {
  const refusal = findEgressRefusal(error);
  if (refusal !== undefined) {
    return { message: describeRefusal(refusal), blockedTarget: true };
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

/**
 * The log envelope of a hosted connection — failed or successful — reduced
 * like a probe answer: allowlisted headers, bounded status text, received frames without
 * their content, and transport errors as {@link describeHostedConnectFailure}
 * words them.
 */
export function projectHostedConnectFailureLogs(
  logs: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return projectHostedLogEnvelope(logs, redactHostedTransportFailureText);
}
