/**
 * Wire-boundary guards for MCP Events payloads. Every guard validates against
 * the vendored zod mirrors in `events-ext-schemas.ts` — untrusted server input
 * is never merely sniffed.
 *
 * Mirrors `skills-ext-guards.ts` in structure (a dedicated error type carrying
 * a truncated, control-character-free issue list) for the same reason: the
 * caller is a debugger, and "invalid result" without the field that failed is
 * not a diagnosis.
 *
 * The error-code classification at the bottom of this file is PINNED to the
 * events methods (C1): `-32011`…`-32015` mean NotFound…CallbackEndpointError
 * only on an `events/*` request. The same numbers on an unrelated method are
 * that method's business, and reading them as events errors would mislabel a
 * server's own implementation-defined codes.
 */

import type { z } from "zod";
import {
  eventOccurrenceSchema,
  eventsListResultSchema,
  eventsPollResultSchema,
  eventsSubscribeResultSchema,
  eventsUnsubscribeResultSchema,
  gapEnvelopeSchema,
  terminatedEnvelopeSchema,
  verificationEnvelopeSchema,
  type EventOccurrenceWire,
  type EventsListResultWire,
  type EventsPollResultWire,
  type EventsSubscribeResultWire,
  type GapEnvelopeWire,
  type TerminatedEnvelopeWire,
  type VerificationEnvelopeWire,
} from "./events-ext-schemas.js";

const MAX_SUMMARY_ISSUES = 5;
const MAX_SUMMARY_LENGTH = 500;

function safeText(value: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ");
  return cleaned.length > maxLength
    ? `${cleaned.slice(0, maxLength)}…`
    : cleaned;
}

/**
 * Thrown when a server (or a webhook sender) produces an events payload that
 * fails validation. An INVALID-PAYLOAD condition, distinct from "this server
 * does not declare events" ({@link MCPEventsWireError}).
 */
export class InvalidEventsPayloadError extends TypeError {
  readonly issues: string[];
  readonly method?: string;
  readonly summary: string;

  constructor(
    context: string,
    issues: string[],
    options?: { method?: string }
  ) {
    const summary = safeText(
      issues.slice(0, MAX_SUMMARY_ISSUES).join("; "),
      MAX_SUMMARY_LENGTH
    );
    super(`${context} is not a valid MCP events payload: ${summary}`);
    this.name = "InvalidEventsPayloadError";
    this.issues = issues;
    if (options?.method !== undefined) this.method = options.method;
    this.summary = summary;
  }
}

export function isInvalidEventsPayloadError(
  error: unknown
): error is InvalidEventsPayloadError {
  return error instanceof InvalidEventsPayloadError;
}

/**
 * Raised when an `events/*` call is attempted on a connection whose server did
 * not declare `capabilities.events` in its raw handshake.
 *
 * Advertise = enforce, exactly like skills: a server that never declared the
 * capability is not probed with undeclared methods. Conformance probes that
 * deliberately test an undeclared server opt out explicitly.
 */
export class MCPEventsWireError extends Error {
  readonly method: string;
  readonly serverId: string;
  /** Whether the raw handshake was observed at all (false ⇒ "unknown"). */
  readonly handshakeObserved: boolean;

  constructor(args: {
    method: string;
    serverId: string;
    handshakeObserved: boolean;
  }) {
    const reason = args.handshakeObserved
      ? "the server did not declare capabilities.events"
      : "the server's handshake was not observed on this connection, so its events capability is unknown";
    super(`Cannot send ${args.method} to "${args.serverId}": ${reason}.`);
    this.name = "MCPEventsWireError";
    this.method = args.method;
    this.serverId = args.serverId;
    this.handshakeObserved = args.handshakeObserved;
  }
}

export function isMCPEventsWireError(
  error: unknown
): error is MCPEventsWireError {
  return error instanceof MCPEventsWireError;
}

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `${safeText(path, 120)}: ${safeText(issue.message, 200)}`;
  });
}

function parseOrThrow<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: string,
  method?: string
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidEventsPayloadError(context, issuesOf(parsed.error), {
      method,
    });
  }
  return parsed.data;
}

export function assertEventsListResult(value: unknown): EventsListResultWire {
  return parseOrThrow(
    eventsListResultSchema,
    value,
    "events/list result",
    "events/list"
  );
}

export function assertEventsPollResult(value: unknown): EventsPollResultWire {
  return parseOrThrow(
    eventsPollResultSchema,
    value,
    "events/poll result",
    "events/poll"
  );
}

/**
 * `events/subscribe` result, including the draft's "always present" rule for
 * `refreshBefore` — see the schema's note on why absence is refused here
 * rather than read as "no expiry".
 */
export function assertEventsSubscribeResult(
  value: unknown
): EventsSubscribeResultWire {
  const parsed = parseOrThrow(
    eventsSubscribeResultSchema,
    value,
    "events/subscribe result",
    "events/subscribe"
  );
  if (!("refreshBefore" in (value as Record<string, unknown>))) {
    throw new InvalidEventsPayloadError(
      "events/subscribe result",
      ["refreshBefore: required (null means no expiry; absence is not a grant)"],
      { method: "events/subscribe" }
    );
  }
  return parsed;
}

export function assertEventsUnsubscribeResult(value: unknown): void {
  parseOrThrow(
    eventsUnsubscribeResultSchema,
    value,
    "events/unsubscribe result",
    "events/unsubscribe"
  );
}

export function assertEventOccurrence(value: unknown): EventOccurrenceWire {
  return parseOrThrow(eventOccurrenceSchema, value, "event occurrence");
}

/**
 * A classified webhook body. The draft's discriminator is structural: "a body
 * with a top-level `type` field is a control envelope; a body without one is
 * an `EventOccurrence`". An unknown `type` is kept as `unknown-control` rather
 * than parsed as an event, because it is by definition not one.
 */
export type WebhookBody =
  | { kind: "event"; event: EventOccurrenceWire }
  | { kind: "gap"; envelope: GapEnvelopeWire }
  | { kind: "terminated"; envelope: TerminatedEnvelopeWire }
  | { kind: "verification"; envelope: VerificationEnvelopeWire }
  | { kind: "unknown-control"; type: string };

export function classifyWebhookBody(value: unknown): WebhookBody {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InvalidEventsPayloadError("webhook body", [
      "(root): must be a JSON object",
    ]);
  }
  const type = (value as { type?: unknown }).type;
  if (type === undefined) {
    return { kind: "event", event: assertEventOccurrence(value) };
  }
  switch (type) {
    case "gap":
      return {
        kind: "gap",
        envelope: parseOrThrow(gapEnvelopeSchema, value, "gap envelope"),
      };
    case "terminated":
      return {
        kind: "terminated",
        envelope: parseOrThrow(
          terminatedEnvelopeSchema,
          value,
          "terminated envelope"
        ),
      };
    case "verification":
      return {
        kind: "verification",
        envelope: parseOrThrow(
          verificationEnvelopeSchema,
          value,
          "verification envelope"
        ),
      };
    default:
      return {
        kind: "unknown-control",
        type: typeof type === "string" ? safeText(type, 64) : String(type),
      };
  }
}

// ---------------------------------------------------------------------------
// Error codes (pinned to the events profile and methods)
// ---------------------------------------------------------------------------

export const EVENTS_ERROR_CODES = {
  InvalidParams: -32602,
  NotFound: -32011,
  Forbidden: -32012,
  ResourceExhausted: -32013,
  Unsupported: -32014,
  CallbackEndpointError: -32015,
} as const;

export type EventsErrorKind = keyof typeof EVENTS_ERROR_CODES;

const EVENTS_ERROR_KIND_BY_CODE = new Map<number, EventsErrorKind>(
  Object.entries(EVENTS_ERROR_CODES).map(([kind, code]) => [
    code,
    kind as EventsErrorKind,
  ])
);

export type ClassifiedEventsError = {
  kind: EventsErrorKind;
  code: number;
  message: string;
  data?: unknown;
  /**
   * Whether retrying the same request can succeed. Only ResourceExhausted and
   * a transient CallbackEndpointError (connection/timeout/tls/5xx) are; every
   * other code describes a static fact about the request or the principal.
   */
  retryable: boolean;
};

function readJsonRpcError(
  error: unknown
): { code: number; message: string; data?: unknown } | undefined {
  const direct = error as { code?: unknown; message?: unknown; data?: unknown };
  if (typeof direct?.code === "number") {
    return {
      code: direct.code,
      message: typeof direct.message === "string" ? direct.message : "",
      data: direct.data,
    };
  }
  const nested = (error as { error?: unknown } | undefined)?.error as
    | { code?: unknown; message?: unknown; data?: unknown }
    | undefined;
  if (typeof nested?.code === "number") {
    return {
      code: nested.code,
      message: typeof nested.message === "string" ? nested.message : "",
      data: nested.data,
    };
  }
  return undefined;
}

const TRANSIENT_CALLBACK_REASONS = new Set([
  "connection_refused",
  "timeout",
  "tls_error",
  "http_5xx",
]);

/**
 * Classify a JSON-RPC error returned by an `events/*` request.
 *
 * Returns `undefined` for a method outside `events/*` (the pin), and for a
 * code the events profile does not define — those are the base protocol's or
 * the server's own, and are surfaced unclassified.
 */
export function classifyEventsRpcError(
  method: string,
  error: unknown
): ClassifiedEventsError | undefined {
  if (!method.startsWith("events/")) return undefined;
  const rpc = readJsonRpcError(error);
  if (!rpc) return undefined;
  const kind = EVENTS_ERROR_KIND_BY_CODE.get(rpc.code);
  if (!kind) return undefined;
  const reason =
    typeof (rpc.data as { reason?: unknown } | undefined)?.reason === "string"
      ? ((rpc.data as { reason: string }).reason as string)
      : undefined;
  const retryable =
    kind === "ResourceExhausted" ||
    (kind === "CallbackEndpointError" &&
      reason !== undefined &&
      TRANSIENT_CALLBACK_REASONS.has(reason));
  return {
    kind,
    code: rpc.code,
    message: rpc.message,
    ...(rpc.data !== undefined ? { data: rpc.data } : {}),
    retryable,
  };
}
