/**
 * Minting the guest token an anonymous `/mcp` request runs as, and saying why
 * it failed when it does.
 *
 * A failed mint used to collapse to `undefined`, which the tool layer reported
 * as "No bearer token on the request." That read like a client bug and hid the
 * cause: a rejected service token, a rate limit and an unreachable Inspector
 * all looked the same. Each failure now carries a reason the tool error can
 * act on, and the operator-side detail goes to the worker log.
 */

export type GuestMintFailureReason =
  | "not_configured"
  | "rejected"
  | "rate_limited"
  | "unavailable"
  | "invalid_response";

export type GuestMintFailure = {
  reason: GuestMintFailureReason;
  /** The mint route's HTTP status, when it answered at all. */
  status?: number;
};

export type GuestMintResult =
  | { ok: true; token: string; expiresAt: number }
  | { ok: false; failure: GuestMintFailure };

/** The stable code a tool error carries in `structuredContent.error.code`. */
export const GUEST_SESSION_UNAVAILABLE = "GUEST_SESSION_UNAVAILABLE";

// Re-mint fallback for a mint response with no usable expiry: short, so the
// next call re-mints instead of caching a token forever.
const FALLBACK_TTL_MS = 60_000;

const MINT_TIMEOUT_MS = 10_000;

/**
 * Mint a fresh guest token via the inspector's service-token-gated route
 * (`MCPJAM_GUEST_MINT_URL`). The route mints through the same Convex authority
 * that publishes the guest JWKS the worker verifies against, so the token is
 * accepted on the way back in. The client IP is forwarded in a custom header
 * (cf-connecting-ip would be overwritten by Cloudflare on the worker→inspector
 * hop) so the route can rate-limit per client. Never throws: every failure
 * comes back as a reason, logged once per attempt with the operator detail.
 */
export async function mintGuestToken(
  env: Env,
  clientIp: string | undefined
): Promise<GuestMintResult> {
  const url = env.MCPJAM_GUEST_MINT_URL;
  const serviceToken = env.MCPJAM_INSPECTOR_SERVICE_TOKEN;
  if (!url || !serviceToken) {
    return fail(
      { reason: "not_configured" },
      "MCPJAM_GUEST_MINT_URL or MCPJAM_INSPECTOR_SERVICE_TOKEN is not set."
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-inspector-service-token": serviceToken,
  };
  if (clientIp) headers["x-mcpjam-client-ip"] = clientIp;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: "{}",
      signal: AbortSignal.timeout(MINT_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(
      { reason: "unavailable" },
      `could not reach ${url}: ${errorText(error)}`
    );
  }

  if (!response.ok) {
    return fail(
      failureForStatus(response.status),
      statusDetail(url, response.status)
    );
  }

  let data: { token?: unknown; expiresAt?: unknown };
  try {
    data = (await response.json()) as typeof data;
  } catch (error) {
    return fail(
      { reason: "invalid_response", status: response.status },
      `${url} returned a body that is not JSON: ${errorText(error)}`
    );
  }
  if (typeof data.token !== "string" || data.token.length === 0) {
    return fail(
      { reason: "invalid_response", status: response.status },
      `${url} returned no token.`
    );
  }
  return {
    ok: true,
    token: data.token,
    expiresAt: normalizeExpiry(data.expiresAt),
  };
}

/** The tool error text for a failed mint: what failed and what to do next. */
export function describeGuestMintFailure(failure: GuestMintFailure): string {
  switch (failure.reason) {
    case "not_configured":
      return "This MCPJam server is not set up for guest access. Sign in to MCPJam to use this tool.";
    case "rejected":
      return "Could not start a guest session because MCPJam rejected this server's guest credentials. Sign in to MCPJam to use this tool, or ask the server operator to check its guest configuration.";
    case "rate_limited":
      return "Too many guest sessions were started from your network. Wait a minute and try again, or sign in to MCPJam.";
    case "unavailable":
      return "Could not start a guest session because the MCPJam guest service did not respond. Try again shortly, or sign in to MCPJam.";
    case "invalid_response":
      return "Could not start a guest session because the MCPJam guest service sent an unreadable reply. Try again shortly, or sign in to MCPJam.";
  }
}

/** The `structuredContent` for a failed mint, in the shape other tool errors use. */
export function guestMintErrorContent(
  failure: GuestMintFailure
): Record<string, unknown> {
  return {
    error: {
      code: GUEST_SESSION_UNAVAILABLE,
      reason: failure.reason,
      ...(failure.status !== undefined ? { status: failure.status } : {}),
      message: describeGuestMintFailure(failure),
    },
  };
}

function failureForStatus(status: number): GuestMintFailure {
  if (status === 401 || status === 403) return { reason: "rejected", status };
  if (status === 429) return { reason: "rate_limited", status };
  return { reason: "unavailable", status };
}

function statusDetail(url: string, status: number): string {
  if (status === 401 || status === 403) {
    // The one failure only configuration fixes, so the log names both sides.
    return `${url} refused the service token (${status}). MCPJAM_INSPECTOR_SERVICE_TOKEN must match that Inspector's INSPECTOR_SERVICE_TOKEN; a local Inspector accepts the dev sentinel only with ALLOW_LOCAL_DEV_SERVICE_TOKEN=true (set by \`npm run dev:server\`).`;
  }
  return `${url} answered ${status}.`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(failure: GuestMintFailure, detail: string): GuestMintResult {
  console.error(`[mcp] guest mint failed (${failure.reason}): ${detail}`);
  return { ok: false, failure };
}

/**
 * Normalize a mint `expiresAt` to ms epoch. The mint contract is ms (matches
 * `issueGuestToken`), but tolerate a seconds value defensively. A missing or
 * non-positive value falls back to a short TTL so the next call re-mints
 * rather than caching a never-expiring token forever.
 */
function normalizeExpiry(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return Date.now() + FALLBACK_TTL_MS;
  }
  // Seconds-epoch timestamps are < 1e12; ms-epoch are ~1.7e12 today.
  return raw < 1e12 ? raw * 1000 : raw;
}
