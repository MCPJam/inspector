/**
 * One classification of MCP Events failures for both route families (local
 * `/api/mcp/events/*` and hosted `/api/web/events/*`), onto the codes of
 * `EventsRouteErrorCode` in `shared/events-api.ts`:
 *
 *   - `EVENTS_UNDECLARED` (400)      — the server did not declare
 *                                      `capabilities.events`; nothing was sent.
 *   - `EVENTS_INVALID_PAYLOAD` (502) — the server answered with a payload that
 *                                      is not a valid events result.
 *   - `EVENTS_RPC_ERROR` (400 / 502) — a JSON-RPC error the events profile
 *                                      defines (-32602, -32011…-32015),
 *                                      carried with its classified `kind`;
 *                                      502 when retrying could succeed.
 *
 * Messages that came from the SERVER pass through the webhook-secret redactor
 * first: a server rejecting a bad secret is exactly the one likely to quote it
 * back (C8).
 */

import {
  classifyEventsRpcError,
  isInvalidEventsPayloadError,
  isMCPEventsWireError,
  redactRpcMessageForLog,
} from "@mcpjam/sdk/events";
import type { EventsRouteErrorCode } from "@/shared/events-api";

export interface ClassifiedEventsRouteError {
  status: 400 | 404 | 502;
  code: EventsRouteErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

function redactText(text: string): string {
  const redacted = redactRpcMessageForLog({ error: { message: text } }) as {
    error: { message: string };
  };
  return redacted.error.message;
}

export function classifyEventsRouteError(
  method: string,
  error: unknown,
): ClassifiedEventsRouteError | undefined {
  if (isMCPEventsWireError(error)) {
    return {
      status: 400,
      code: "EVENTS_UNDECLARED",
      message: error.message,
      details: { handshakeObserved: error.handshakeObserved },
    };
  }
  if (isInvalidEventsPayloadError(error)) {
    return {
      status: 502,
      code: "EVENTS_INVALID_PAYLOAD",
      message: redactText(error.message),
      details: { issues: error.issues.slice(0, 10).map(redactText) },
    };
  }
  const classified = classifyEventsRpcError(method, error);
  if (classified) {
    const safe = redactRpcMessageForLog({
      error: {
        message: classified.message,
        ...(classified.data !== undefined ? { data: classified.data } : {}),
      },
    }) as { error: { message: string; data?: unknown } };
    return {
      status: classified.retryable ? 502 : 400,
      code: "EVENTS_RPC_ERROR",
      message: safe.error.message || classified.kind,
      details: {
        kind: classified.kind,
        rpcCode: classified.code,
        retryable: classified.retryable,
        ...(safe.error.data !== undefined ? { data: safe.error.data } : {}),
      },
    };
  }
  return undefined;
}
