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
// Assumed TTL when the mint response omits `expiresAt`. Must comfortably
// exceed EXPIRY_SLACK_MS — a fallback of exactly the slack window would put
// the token inside the re-mint window the moment it's cached, turning the
// cache into a per-request mint. Tokens live ~2h server-side; 1h is safe.
const FALLBACK_TTL_MS = 60 * 60 * 1000;

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
        : `Failed to reach delegated token exchange: ${parseErrorMessage(
            error
          )}`
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
      response.status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.INTERNAL_ERROR,
      `Delegated token exchange failed (${response.status})`
    );
  }
  return {
    token: body.token,
    expiresAt:
      typeof body.expiresAt === "number"
        ? body.expiresAt
        : Date.now() + FALLBACK_TTL_MS,
  };
}

/**
 * The auth methods whose caller has NO Convex-verifiable bearer of their own,
 * so the gateway mints a delegated org-scoped JWT for them.
 *
 * One set, two consumers. `getConvexBearerForRequest` and
 * `getConvexBearerThunkForRequest` used to spell this out separately, once
 * positively and once negatively — and the drift is silent in the direction
 * that matters: add a fourth service credential to only one, and that caller
 * still gets a bearer, it just stops REFRESHING partway through a multi-hour
 * run. Tested on the LABEL rather than on the presence of the identity vars,
 * because a JWT caller can carry those vars too and minting for them would
 * swap a user's own bearer for a delegated one.
 */
const DELEGATED_AUTH_METHODS = new Set([
  "workos_api_key",
  "slack_service",
  "discord_service",
]);

function usesDelegatedToken(c: Context): boolean {
  const authMethod = c.get("authMethod");
  return typeof authMethod === "string" && DELEGATED_AUTH_METHODS.has(authMethod);
}

/**
 * The organization this request is CONFINED TO, or `undefined` for a caller
 * who is confined to nothing.
 *
 * The backend applies this itself for everything reached through a delegated
 * JWT — the token is minted for one org and Convex re-checks membership in it.
 * What the backend cannot clamp is a query that is not org-scoped at all:
 * `organizations:getMyOrganizations` answers "every org this HUMAN belongs to",
 * which for an `sk_` key bound to one org is strictly more than the key may
 * see. A route serving such a query must intersect the result with this.
 *
 * Read the AUTH METHOD, not the presence of `mcpjamOrganizationId`: a session
 * JWT caller can carry the var too (it is the org their UI is looking at), and
 * clamping them to it would hide the other orgs they legitimately belong to —
 * the exact list this endpoint exists to return.
 */
export function getDelegatedOrganizationId(c: Context): string | undefined {
  if (!usesDelegatedToken(c)) return undefined;
  const organizationId = c.get("mcpjamOrganizationId");
  return typeof organizationId === "string" && organizationId.length > 0
    ? organizationId
    : undefined;
}

/**
 * Resolve the bearer to use against Convex for this request:
 *   - JWT callers (WorkOS session, guest): the original bearer, verbatim.
 *   - WorkOS API-key callers: a cached short-lived delegated JWT.
 *   - Slack service callers: the same, for the LINKED user the request names.
 *     The `slk_` token itself is never exchanged — it identifies the bot, not
 *     a person, and the delegated token is minted for the human behind the
 *     Slack identity. The backend re-verifies that user's org membership on
 *     every mint, so an unlinked or removed user cannot be delegated for.
 *
 * Background tasks that outlive the request (async eval runs) should call
 * this once during the request and capture the returned string — the token's
 * TTL (hours) comfortably covers a capped eval run.
 */
export async function getConvexBearerForRequest(c: Context): Promise<string> {
  // Both non-JWT auth methods need a minted token. Dispatching on
  // `authMethod` rather than on the presence of the delegation context vars
  // is deliberate: a JWT caller can carry those vars too, and minting for
  // them would swap a user's own bearer for a delegated one.
  if (!usesDelegatedToken(c)) {
    return assertBearerToken(c);
  }
  const { workosUserId, organizationId } = delegationContext(c);
  return getConvexBearerForDelegation(workosUserId, organizationId);
}

/**
 * A RE-RESOLVING bearer for work that outlives the request.
 *
 * `getConvexBearerForRequest` hands back a string, which is right for anything
 * that finishes inside the request. A swarm run does not: it detaches after a
 * 202 and can fan out for hours, while a delegated JWT lives ~2h. A captured
 * string simply stops working partway through, and every later call — attempt
 * claims, terminal reports, transcript persists — fails on a run that looks
 * half-finished.
 *
 * Call this WHILE THE CONTEXT IS LIVE: it reads the delegation identity now
 * and closes over the ids, so the returned thunk never touches `c`. Each call
 * re-mints (or returns the cached token, which `getConvexBearerForDelegation`
 * already refreshes near expiry).
 *
 * For a session/guest JWT caller there is nothing to re-mint — the token's
 * lifetime is the browser session's and we cannot extend it — so the thunk is
 * constant. That is not a gap this can close; a run whose launching tab closed
 * is what the backend's stale-run sweep is for.
 */
export function getConvexBearerThunkForRequest(
  c: Context
): () => Promise<string> {
  if (usesDelegatedToken(c)) {
    const { workosUserId, organizationId } = delegationContext(c);
    return () => getConvexBearerForDelegation(workosUserId, organizationId);
  }
  const bearer = assertBearerToken(c);
  return async () => bearer;
}

/**
 * Delegation-direct variant for background callers with no request at all
 * (the scheduled-evals worker): mint (or reuse) a short-lived org-scoped
 * JWT for the given WorkOS user id + organization. Same cache + in-flight
 * dedupe as the request path; membership is re-verified by the backend on
 * every actual mint.
 */
export async function getConvexBearerForDelegation(
  workosUserId: string,
  organizationId: string
): Promise<string> {
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
