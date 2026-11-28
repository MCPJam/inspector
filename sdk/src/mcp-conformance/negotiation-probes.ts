import {
  discoveryErrorMessage,
  discoveryFieldProblems,
} from "../discovery-result.js";
import { MCP_ERROR_CODES } from "../mcp-client-manager/mcp-error-codes.js";
import type { RawExchange } from "./raw-capture.js";
import { jsonRpcError, jsonRpcResult, type RawHttpResult } from "./raw-http.js";
import type { MCPCheckEra } from "./types.js";
import type { WireObservationRecorder } from "./wire-observations.js";

/**
 * An unpinned (Auto) run's client opens with a `server/discover` probe to ask
 * for the 2026-07-28 revision, and falls back to `initialize` when the server
 * does not speak it. A 2025-era server never gets that request from a client
 * of its own revision, so grading its reply against the 2025 schema would fail
 * the server for answering a question from another revision.
 *
 * The probe's exchanges are held until the run knows its era: recorded for
 * the modern era, where `server/discover` is part of the protocol, and dropped
 * otherwise. A pinned run holds nothing.
 */
export interface NegotiationProbeHold {
  /** The most recent discovery reply, including during a pinned connection. */
  readonly discovery?: RawHttpResult;
  /** True when the exchange was held instead of recorded. */
  hold(exchange: RawExchange): boolean;
  /** Record or drop what was held, then stop holding. */
  settle(era: MCPCheckEra): void;
}

export function createNegotiationProbeHold(
  recorder: WireObservationRecorder,
  autoNegotiated: boolean
): NegotiationProbeHold {
  let active = autoNegotiated;
  let held: RawExchange[] = [];
  let discovery: RawHttpResult | undefined;
  return {
    get discovery() {
      return discovery;
    },
    hold(exchange) {
      if (requestMethod(exchange) !== "server/discover") return false;
      discovery = { ...exchange.response, exchange };
      if (!active) return false;
      held.push(exchange);
      return true;
    },
    settle(era) {
      if (era === "modern") {
        for (const exchange of held) recorder.recordExchange(exchange);
      }
      held = [];
      active = false;
    },
  };
}

/** A pinned client can report a failed discovery probe as a version refusal. */
export function pinnedDiscoveryFailure(
  reply: RawHttpResult | undefined,
): string | undefined {
  if (reply?.status !== 200) return undefined;
  const rpcError = jsonRpcError(reply);
  if (rpcError) {
    return rpcError.code === MCP_ERROR_CODES.InternalError
      ? discoveryErrorMessage(reply.status, rpcError)
      : undefined;
  }
  const result = jsonRpcResult(reply);
  if (!result) return undefined;
  const problems = discoveryFieldProblems(result);
  return problems.length
    ? `server/discover result is incomplete: ${problems.join("; ")}`
    : undefined;
}

function requestMethod(exchange: RawExchange): string | undefined {
  const json = exchange.request.json;
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const method = (json as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}
