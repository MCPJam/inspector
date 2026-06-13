import { Hono } from "hono";
import { timingSafeEqual } from "crypto";
import {
  fetchConvexGuestSession,
  fetchRemoteGuestSession,
} from "../../utils/guest-session-source.js";
import { ErrorCode, webError } from "./errors.js";

/**
 * POST /api/web/guest-token
 *
 * Service-token-gated guest minting for the platform MCP worker. When an
 * external MCP client connects to mcp.mcpjam.com/mcp with NO bearer, the
 * worker calls this route (lazily, on first platform-tool execution) to mint a
 * fresh guest token, then uses it to drive the Platform API on the caller's
 * behalf.
 *
 * Why this route (not /api/web/guest-session): that endpoint is the public,
 * browser-facing minter (sets cookies, IP-limited on the *connection* IP). A
 * worker calling it would bucket every anonymous mint under the worker's
 * egress IP. This route is gated by the shared `INSPECTOR_SERVICE_TOKEN`
 * (`x-inspector-service-token`), trusts the worker-forwarded client IP
 * (`x-mcpjam-client-ip` — cf-connecting-ip is rewritten by Cloudflare on the
 * worker→inspector hop), and rate-limits per *client* IP.
 *
 * Keypair correctness: minting goes through the same Convex-backed guest path
 * (`fetchConvexGuestSession` / `fetchRemoteGuestSession`) that the public
 * guest-session route uses, so the token is signed by the same authority whose
 * JWKS the worker verifies against (`/api/web/guest-jwks`). It must NOT use the
 * inspector-local `issueGuestToken()`, whose keypair may differ.
 */
const guestToken = new Hono();

// Per-IP sliding window: 10 req/min per forwarded client IP. Mirrors the
// /api/web/guest-session limiter. Worker-side limiting is unreliable
// (Cloudflare isolates don't share state), so this backend limit is the real
// guard.
const ipWindows = new Map<string, { count: number; windowStart: number }>();
const IP_RATE_LIMIT = 10;
const IP_WINDOW_MS = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of ipWindows) {
    if (now - entry.windowStart > IP_WINDOW_MS * 2) {
      ipWindows.delete(ip);
    }
  }
}, 5 * 60_000).unref();

function allowMint(ip: string): boolean {
  const now = Date.now();
  const entry = ipWindows.get(ip);
  if (!entry) {
    ipWindows.set(ip, { count: 1, windowStart: now });
    return true;
  }
  if (now - entry.windowStart >= IP_WINDOW_MS) {
    entry.count = 1;
    entry.windowStart = now;
    return true;
  }
  if (entry.count >= IP_RATE_LIMIT) {
    return false;
  }
  entry.count++;
  return true;
}

function serviceTokenMatches(provided: string | undefined): boolean {
  const expected = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Hosted web + local dev mint through Convex directly; local production
// runtimes relay through the hosted Inspector. Mirrors
// `shouldFetchGuestSessionFromConvex` in guest-session.ts.
function shouldUseConvex(): boolean {
  if (process.env.VITE_MCPJAM_HOSTED_MODE === "true") return true;
  return process.env.NODE_ENV !== "production";
}

guestToken.post("/", async (c) => {
  if (!serviceTokenMatches(c.req.header("x-inspector-service-token"))) {
    return webError(c, 401, ErrorCode.UNAUTHORIZED, "Invalid service token");
  }

  if (process.env.MCPJAM_NONPROD_LOCKDOWN === "true") {
    return webError(
      c,
      403,
      ErrorCode.FORBIDDEN,
      "Guest access is disabled in this environment."
    );
  }

  const ip = c.req.header("x-mcpjam-client-ip")?.trim() || "unknown";
  if (!allowMint(ip)) {
    return webError(
      c,
      429,
      ErrorCode.RATE_LIMITED,
      "Guest mint rate limit exceeded. Try again later."
    );
  }

  // No browser context → no cookie → always mints a fresh guest.
  const result = shouldUseConvex()
    ? await fetchConvexGuestSession()
    : await fetchRemoteGuestSession();

  if (result.kind !== "session") {
    return webError(c, 503, ErrorCode.INTERNAL_ERROR, "Guest token unavailable");
  }

  return c.json({
    token: result.session.token,
    expiresAt: result.session.expiresAt,
  });
});

export default guestToken;
