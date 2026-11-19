import type { RawExchange } from "./raw-capture.js";
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
  return {
    hold(exchange) {
      if (!active || requestMethod(exchange) !== "server/discover") {
        return false;
      }
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

function requestMethod(exchange: RawExchange): string | undefined {
  const json = exchange.request.json;
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const method = (json as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}
