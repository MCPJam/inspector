import type { Context, Next } from "hono";
import { HOSTED_MODE } from "../config";

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, RateLimitBucket>();

function getNumericEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function getWindowMs(): number {
  return getNumericEnv("MCPJAM_RATE_LIMIT_WINDOW_MS", 60_000);
}

function getLimitForPath(path: string): number {
  if (path.startsWith("/api/mcp/connect")) {
    return getNumericEnv("MCPJAM_RATE_LIMIT_CONNECT_PER_WINDOW", 30);
  }
  if (path.startsWith("/api/mcp/servers/reconnect")) {
    return getNumericEnv("MCPJAM_RATE_LIMIT_RECONNECT_PER_WINDOW", 30);
  }
  if (path.startsWith("/api/mcp/tools/execute")) {
    return getNumericEnv("MCPJAM_RATE_LIMIT_EXECUTE_PER_WINDOW", 180);
  }
  return getNumericEnv("MCPJAM_RATE_LIMIT_PER_WINDOW", 600);
}

function keyForRequest(c: Context): string {
  const tenantId = c.tenantId || "unknown-tenant";
  const path = c.req.path;
  return `${tenantId}:${path}`;
}

function getRetryAfterSeconds(resetAt: number): number {
  const remainingMs = Math.max(0, resetAt - Date.now());
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

function touchBucket(key: string, windowMs: number, now = Date.now()) {
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    const created: RateLimitBucket = {
      count: 1,
      resetAt: now + windowMs,
    };
    buckets.set(key, created);
    return created;
  }

  existing.count += 1;
  return existing;
}

/**
 * Hosted mode MCP rate limiter (in-memory per process).
 * Keeps tenant request volume bounded until distributed limits are configured.
 */
export async function hostedRateLimitMiddleware(
  c: Context,
  next: Next,
): Promise<Response | void> {
  if (!HOSTED_MODE) {
    return next();
  }

  if (!c.req.path.startsWith("/api/mcp/")) {
    return next();
  }

  if (c.req.path === "/api/mcp/health") {
    return next();
  }

  const windowMs = getWindowMs();
  const limit = getLimitForPath(c.req.path);
  const bucket = touchBucket(keyForRequest(c), windowMs);

  if (bucket.count > limit) {
    const retryAfter = getRetryAfterSeconds(bucket.resetAt);
    return c.json(
      {
        error: "Too Many Requests",
        message: "Rate limit exceeded for hosted MCP API.",
      },
      429,
      {
        "Retry-After": String(retryAfter),
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.floor(bucket.resetAt / 1000)),
      },
    );
  }

  return next();
}

export function resetHostedRateLimitBucketsForTests(): void {
  buckets.clear();
}
