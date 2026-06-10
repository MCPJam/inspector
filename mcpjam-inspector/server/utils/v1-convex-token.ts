/**
 * Convex bearer resolution for the public /api/v1 surface.
 *
 * Convex client auth (`ConvexHttpClient.setAuth`) and several Convex HTTP
 * routes are JWT-only, but /api/v1 callers authenticate with WorkOS API keys
 * (`sk_…`). For those requests the Inspector exchanges its service-token
 * delegation (the same `x-mcpjam-acting-as` / `x-mcpjam-acting-in-org` trust
 * model used by `authorizeBatch`) for a short-lived org-scoped JWT minted by
 * the backend's `POST /web/delegated-token`. JWT callers pass through
 * untouched.
 *
 * The minted token is an internal credential: it is held in this process
 * (request flow + background eval task closures) and is never returned to
 * the API caller.
 */
import type { Context } from "hono";
import {
  ErrorCode,
  WebRouteError,
  assertBearerToken,
  parseErrorMessage,
} from "../routes/web/errors.js";

const MINT_TIMEOUT_MS = 10_000;
// Re-mint when the cached token is within this window of expiry. Generous
// because background eval runs capture the token at POST time and keep using
// it for the duration of the run.
const EXPIRY_SLACK_MS = 10 * 60 * 1000;

type CachedToken = { token: string; expiresAt: number };

// Keyed by `${workosUserId}:${organizationId}` — the only inputs to the mint.
// Tokens live ~2h server-side, so steady-state v1 traffic pays the extra
// Convex round-trip roughly once per user+org per token lifetime.
const mintedTokenCache = new Map<string, CachedToken>();
const inflightMints = new Map<string, Promise<CachedToken>>();

function delegationContext(c: Context): {
  workosUserId: string;
  organizationId: string;
} {
  const workosUserId = c.get("workosUserId");
  const organizationId = c.get("mcpjamOrganizationId");
  if (!workosUserId || !organizationId) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Missing WorkOS delegation context for Convex token exchange"
    );
  }
  return { workosUserId, organizationId };
}

async function mintDelegatedToken(
  workosUserId: string,
  organizationId: string
): Promise<CachedToken> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!serviceToken) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing INSPECTOR_SERVICE_TOKEN for WorkOS API key auth"
    );
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MINT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${convexUrl}/web/delegated-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceToken}`,
        "x-mcpjam-acting-as": workosUserId,
        "x-mcpjam-acting-in-org": organizationId,
      },
      signal: controller.signal,
    });
  } catch (error) {
    const isAbort =
      error instanceof Error &&
      (error.name === "AbortError" ||
        (error as { code?: string }).code === "ABORT_ERR");
    throw new WebRouteError(
      isAbort ? 504 : 502,
      ErrorCode.SERVER_UNREACHABLE,
      isAbort
        ? `Delegated token exchange timed out after ${MINT_TIMEOUT_MS}ms`
        : `Failed to reach delegated token exchange: ${parseErrorMessage(error)}`
    );
  } finally {
    clearTimeout(timeoutId);
  }

  type MintResponse = { ok?: boolean; token?: string; expiresAt?: number };
  let body: MintResponse | null = null;
  try {
    body = (await response.json()) as MintResponse;
  } catch {
    // handled below
  }
  if (!response.ok || !body?.ok || typeof body.token !== "string") {
    throw new WebRouteError(
      response.status === 403 ? 403 : 502,
      response.status === 403
        ? ErrorCode.FORBIDDEN
        : ErrorCode.INTERNAL_ERROR,
      `Delegated token exchange failed (${response.status})`
    );
  }
  return {
    token: body.token,
    expiresAt:
      typeof body.expiresAt === "number"
        ? body.expiresAt
        : Date.now() + EXPIRY_SLACK_MS,
  };
}

/**
 * Resolve the bearer to use against Convex for this request:
 *   - JWT callers (WorkOS session, guest): the original bearer, verbatim.
 *   - WorkOS API-key callers: a cached short-lived delegated JWT.
 *
 * Background tasks that outlive the request (async eval runs) should call
 * this once during the request and capture the returned string — the token's
 * TTL (hours) comfortably covers a capped eval run.
 */
export async function getConvexBearerForRequest(c: Context): Promise<string> {
  if (c.get("authMethod") !== "workos_api_key") {
    return assertBearerToken(c);
  }
  const { workosUserId, organizationId } = delegationContext(c);
  const cacheKey = `${workosUserId}:${organizationId}`;

  const cached = mintedTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > EXPIRY_SLACK_MS) {
    return cached.token;
  }

  const inflight = inflightMints.get(cacheKey);
  if (inflight) {
    return (await inflight).token;
  }

  const mintPromise = mintDelegatedToken(workosUserId, organizationId)
    .then((minted) => {
      mintedTokenCache.set(cacheKey, minted);
      return minted;
    })
    .finally(() => {
      inflightMints.delete(cacheKey);
    });
  inflightMints.set(cacheKey, mintPromise);
  return (await mintPromise).token;
}
