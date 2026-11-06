import type { NegotiationOutcomeLogger } from "@mcpjam/sdk";
import { logger } from "./logger.js";

export type McpSetupTiming = (
  stage:
    | "authorization-start"
    | "authorization-end"
    | "connect-start"
    | "connect-end",
  outcome?: "connected" | "failed",
) => void;

/** Record only durations and the generated request ID in development QA. */
export function createMcpSetupTiming(
  requestId: string | undefined,
): McpSetupTiming | undefined {
  if (
    process.env.ENVIRONMENT !== "dev" ||
    process.env.HARN24_BENCHMARK_TIMINGS !== "1"
  )
    return undefined;
  let authorizationAt = 0,
    authorizedAt = 0,
    connectingAt = 0;
  return (stage, outcome) => {
    const now = performance.now();
    let label, duration;
    if (stage === "authorization-start") {
      authorizationAt = now;
      return;
    }
    if (stage === "authorization-end") {
      authorizedAt = now;
      label = "serverAuthorization";
      duration = now - authorizationAt;
    } else if (stage === "connect-start") {
      connectingAt = now;
      label = "transportPreparation";
      duration = now - authorizedAt;
    } else {
      label = "mcpConnect";
      duration = now - connectingAt;
    }
    try {
      logger.info(
        `[harness][mcp-timing] stage=${label} durationMs=${Math.round(duration)} outcome=${outcome ?? "completed"} requestId=${requestId ?? "none"}`,
      );
    } catch {
      // Optional development measurement must never change connection behavior.
    }
  };
}

/** The SDK invokes the existing callback after connection settles, across eras. */
export function withNegotiationTiming(
  log: NegotiationOutcomeLogger,
  timing?: McpSetupTiming,
): NegotiationOutcomeLogger {
  if (!timing) return log;
  timing("connect-start");
  const seen = new Set<string>();
  return (event) => {
    log(event);
    if (!seen.has(event.serverId)) {
      seen.add(event.serverId);
      timing("connect-end", event.outcome);
    }
  };
}
