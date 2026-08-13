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
import {
  agentAttributionCacheKey,
  agentAttributionHeaders,
  stableAgentAttribution,
  volatileAgentAttribution,
  type AgentAttribution,
} from "./agent-attribution.js";

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

// Keyed by `${workosUserId}:${organizationId}:${surface}:${apiKeyId}` — the
// inputs BAKED INTO the minted token. Attribution is part of the key because a
// token carries it: sharing one across surfaces would label a CLI write as
// Slack, and a wrong attribution is worse than none because it gets believed.
// Only the stable half of an attribution is ever cached (see
// `agentAttributionCacheKey`), so this still costs roughly one mint per
// user+org+surface per ~2h token lifetime.
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
  organizationId: string,
  attribution?: AgentAttribution
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
        // Which agent channel drove this. Sent on the MINT, alongside the
        // existing delegation headers and under the same trust rule: only a
        // holder of the service token can reach this endpoint, so the backend
        // can stamp these claims on the token knowing an API caller could not
        // have forged them. See ./agent-attribution.ts.
        ...agentAttributionHeaders(attribution),
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
  return (
    typeof authMethod === "string" && DELEGATED_AUTH_METHODS.has(authMethod)
  );
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
  return getConvexBearerForDelegation(
    workosUserId,
    organizationId,
    stableAgentAttribution(c)
  );
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
    // Read the attribution now, while the context is live — the thunk runs
    // long after this request is gone and must never touch `c`.
    const attribution = stableAgentAttribution(c);
    return () =>
      getConvexBearerForDelegation(workosUserId, organizationId, attribution);
  }
  const bearer = assertBearerToken(c);
  return async () => bearer;
}

/**
 * The bearer for EXECUTING AN APPROVED PROPOSAL, minted fresh rather than
 * cached.
 *
 * This is the one path that carries the volatile half of an attribution — the
 * proposal's action id, and the request id of the execution — because it is
 * the one path where they are the point: they are the join between "a human
 * pressed Run it in Slack" and the row that changed. A cached token cannot
 * carry them (it would stamp one request's ids on every later request sharing
 * the cache key), so this deliberately pays a mint.
 *
 * The cost is proportionate. Execution already re-verifies membership,
 * self-dispatches a whole operation and spends; one extra token exchange is
 * noise against that, and unlike the read path it does not repeat per poll.
 *
 * A JWT caller has nothing to mint, so they get their own bearer verbatim and
 * no attribution — which is correct: they are not a delegated agent.
 */
export async function getConvexBearerForApprovedAction(
  c: Context,
  agentActionId: string
): Promise<string> {
  if (!usesDelegatedToken(c)) {
    return assertBearerToken(c);
  }
  const { workosUserId, organizationId } = delegationContext(c);
  const minted = await mintDelegatedToken(
    workosUserId,
    organizationId,
    volatileAgentAttribution(c, agentActionId)
  );
  return minted.token;
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
  organizationId: string,
  attribution?: AgentAttribution
): Promise<string> {
  const cacheKey = `${workosUserId}:${organizationId}:${agentAttributionCacheKey(
    attribution
  )}`;

  const cached = mintedTokenCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > EXPIRY_SLACK_MS) {
    return cached.token;
  }

  const inflight = inflightMints.get(cacheKey);
  if (inflight) {
    return (await inflight).token;
  }

  const mintPromise = mintDelegatedToken(
    workosUserId,
    organizationId,
    attribution
  )
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
