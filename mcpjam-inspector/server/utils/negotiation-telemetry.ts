/**
 * Auto-negotiation outcome TELEMETRY wiring.
 *
 * Bridges the SDK's per-connection {@link NegotiationOutcomeLogger} (a local
 * provenance callback the `MCPClientManager` fires once per connect attempt)
 * to the existing Axiom system-event pipeline via `getSystemLogger`. It does
 * NOT invent a parallel pipeline — it forwards the SDK-supplied dimensions
 * (configured mode, negotiated era/version, transport, outcome, failure class)
 * and stamps the `surface` the connection was made from.
 *
 * The SDK guards the callback (it never throws into connect); this layer also
 * swallows its own errors so telemetry can never disturb a connection.
 */

import type { NegotiationOutcomeLogger } from "@mcpjam/sdk";
import { getSystemLogger } from "./request-logger.js";

/**
 * The MCPJam entry point a connection was made from. Stamped onto every
 * negotiation-outcome event so the checklist "surface" dimension is honest
 * per construction site.
 */
export type NegotiationSurface =
  | "local-inspector"
  | "hosted-direct"
  | "hosted-chat"
  | "evals";

const negotiationSystemLogger = getSystemLogger("mcp-negotiation");

/**
 * Build a {@link NegotiationOutcomeLogger} bound to a surface. Wire it into
 * `new MCPClientManager(_, { negotiationOutcomeLogger })` at each construction
 * site. Emits one `mcp.connection.negotiated` Axiom event per attempt.
 */
export function negotiationTelemetryLogger(
  surface: NegotiationSurface
): NegotiationOutcomeLogger {
  return (event) => {
    try {
      negotiationSystemLogger.event("mcp.connection.negotiated", {
        surface,
        serverId: event.serverId,
        transport: event.transport,
        configuredMode: event.configuredMode,
        outcome: event.outcome,
        ...(event.negotiatedEra !== undefined
          ? { negotiatedEra: event.negotiatedEra }
          : {}),
        ...(event.negotiatedProtocolVersion !== undefined
          ? { negotiatedProtocolVersion: event.negotiatedProtocolVersion }
          : {}),
        ...(event.failureClass !== undefined
          ? { failureClass: event.failureClass }
          : {}),
      });
    } catch {
      // Telemetry must never disturb connection control flow.
    }
  };
}
