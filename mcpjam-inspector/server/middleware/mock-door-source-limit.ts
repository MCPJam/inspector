import type { Context, Next } from "hono";
import { HOSTED_MODE } from "../config.js";
import { getAttestedClientIp } from "../utils/client-ip.js";
import { mockRefusalResponse } from "../services/mock/refusal.js";
import { createFixedWindowMap } from "./passthrough-rate-limit.js";

/**
 * The mock door's per-source limit, in front of bearer auth so a flood from
 * one address is refused before any key or backend is asked about it. The
 * per-key limit (`mcpOperationRateLimit("mock-mcp")`) sits behind auth.
 *
 * Same shape as `passthroughRateLimitMiddleware`'s address window: an attested
 * address gets its own window, and every request without one shares one pooled
 * window, so a caller cannot dodge the limit by writing a forwarding header.
 * The count is per replica, like every limiter in this directory. Local mode is
 * exempt: one person dials their own Inspector.
 */
const SOURCE_LIMIT_PER_MINUTE = 600;
const WINDOW_MS = 60_000;
/** Many callers share the pool, so it holds a multiple of one source's limit. */
const POOLED_LIMIT_PER_MINUTE = 4 * SOURCE_LIMIT_PER_MINUTE;
const POOLED_KEY = "ip:_unattested";

const sourceWindows = createFixedWindowMap(SOURCE_LIMIT_PER_MINUTE, WINDOW_MS);
const pooledWindows = createFixedWindowMap(POOLED_LIMIT_PER_MINUTE, WINDOW_MS);

export async function mockDoorSourceLimit(c: Context, next: Next): Promise<Response | void> {
  if (!HOSTED_MODE) return next();
  const ip = getAttestedClientIp(c);
  const waitMs = ip ? sourceWindows.charge(`ip:${ip}`) : pooledWindows.charge(POOLED_KEY);
  if (waitMs !== null) {
    return mockRefusalResponse("rate_limited", { retryAfterSeconds: waitMs / 1000 });
  }
  return next();
}

export const MOCK_DOOR_SOURCE_LIMIT = SOURCE_LIMIT_PER_MINUTE;

export function resetMockDoorSourceLimitForTests(): void {
  sourceWindows.clear();
  pooledWindows.clear();
}
