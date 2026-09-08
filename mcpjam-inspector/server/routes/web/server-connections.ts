/**
 * The handoff page's back end.
 *
 * `/connect/server/<token>` is a page the user opens from a CLI, a Slack
 * message, or a Discord button. These routes are what it talks to, and the
 * shape is deliberate: THE BROWSER NEVER HOLDS A TOKEN.
 *
 * The claim call trades the single-use handoff token for a continuation token
 * that goes straight into an HttpOnly cookie. Every step after it — reading
 * state, choosing a project, cancelling — authenticates with that cookie, so
 * page JavaScript never sees a credential, a `document.cookie` read finds
 * nothing, and an XSS on this origin cannot lift the capability.
 *
 * The Inspector holds the service token and forwards only the continuation
 * DIGEST to the backend, so the raw value never leaves this process either.
 *
 * WHY POST FOR THE CLAIM. A GET would be claimed by anything that follows
 * links: a link preview crawler in the channel the handoff was posted to, a
 * prefetching browser, a corporate mail scanner. The claim is single-use, so
 * one of those consuming it would leave the real user with a dead link and no
 * explanation. Requiring a POST from the page's own script means only a real
 * visit claims it.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  cancelFromHandoff,
  claimHandoff,
  completeAuthorizationAttempt,
  ensureDefaultProject,
  fetchAuthorizationContext,
  fetchHandoffState,
  selectProject,
  ServerConnectionBackendError,
  startAuthorizationAttempt,
} from "../../services/server-connections-backend.js";
import {
  AuthorizationPrepareError,
  prepareAuthorization,
} from "../../services/server-connection-authorize.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "./errors.js";
import { readCookie, setCookie, clearCookie } from "./shared/cookies.js";
import { resolveOptionalActor } from "../../middleware/optional-actor.js";
import {
  serverConnectionAuthorizeRateLimitMiddleware,
  serverConnectionClaimRateLimitMiddleware,
  serverConnectionStateRateLimitMiddleware,
} from "../../middleware/server-connection-claim-rate-limit.js";
import { isAllowedRequestOrigin } from "../../middleware/origin-validation.js";
import { getClientIp } from "../../utils/client-ip.js";
import { claimRefusalReason } from "../../../shared/server-connection-claim-refusal.js";

const serverConnections = new Hono();

/**
 * `__Host-` prefixed: it pins the cookie to this exact origin with `Path=/` and
 * forbids a subdomain from setting it, which is the property that matters for
 * something that authorizes a state change.
 */
const CONTINUATION_COOKIE = "__Host-mcpjam_server_connection";

/** Matches the request TTL. A cookie that outlived the request would be a
 * credential for something that no longer exists. */
const CONTINUATION_MAX_AGE_S = 60 * 60;

const claimSchema = z.strictObject({
  handoffToken: z.string().trim().min(1),
});

const selectProjectSchema = z.strictObject({
  projectId: z.string().trim().min(1),
});

/**
 * Reject a cross-site POST, and return the page's real origin.
 *
 * These routes authenticate with a `SameSite=Lax` cookie, which is NOT sent on
 * a cross-site POST — so the rejection is belt-and-braces rather than the only
 * defence. The check is against the deployment's origin ALLOWLIST, not against
 * `c.req.url`: behind the hosted TLS edge `c.req.url`'s scheme is the plain
 * `http` of the internal socket, and behind the dev proxy its host is the
 * server's port rather than the page's — comparing against either would 403
 * every legitimate POST. The allowlist is the same one the global origin
 * middleware enforces, so a value that passes here is one the deployment
 * already vouches for.
 *
 * The header is REQUIRED, not optional. Every route in this family is
 * browser-only — the page's own `fetch` calls — and a browser attaches
 * `Origin` to every POST, same-origin included. The only senders that omit it
 * are non-browser clients, which have no business on a cookie-authenticated
 * route. (The local-PTY WebSocket takes the same absent-means-reject posture.)
 *
 * The returned value doubles as the page's public origin — the exact origin
 * the `__Host-` continuation cookie lives on — which is what the OAuth
 * redirect URI must be built from.
 */
function requireBrowserOrigin(c: {
  req: { header: (name: string) => string | undefined };
}): string {
  const origin = c.req.header("origin");
  if (!origin) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "This endpoint only accepts requests from the connection page."
    );
  }
  let normalized: string;
  try {
    normalized = new URL(origin).origin;
  } catch {
    throw new WebRouteError(403, ErrorCode.FORBIDDEN, "Invalid origin.");
  }
  if (normalized === "null" || !isAllowedRequestOrigin(normalized)) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "Cross-origin requests are not allowed here."
    );
  }
  return normalized;
}

function requireContinuation(c: Parameters<typeof readCookie>[0]): string {
  const token = readCookie(c, CONTINUATION_COOKIE);
  if (!token) {
    throw new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "This authorization session has ended. Open the link again to continue."
    );
  }
  return token;
}

/** Map the backend's refusals onto web errors, preserving the distinction
 * between "gone" and "someone else's". */
function translate(error: unknown): WebRouteError {
  if (error instanceof WebRouteError) return error;
  if (error instanceof ServerConnectionBackendError) {
    if (error.isGone) {
      return new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        error.message,
        error.code ? { reason: error.code } : undefined
      );
    }
    // NO 401 ARM, DELIBERATELY. A continuation token the backend does not
    // recognize — expired, or consumed by a cancel — comes back 404
    // `REQUEST_NOT_FOUND`, which `isGone` already turns into "that link is
    // gone". The only thing that produces a 401 on this channel is
    // `requireInspector` refusing our SERVICE token, which is a deployment
    // misconfiguration affecting everyone. Translating it to "your
    // authorization session has ended" would tell every user their link
    // expired while the real fault sat unreported, so it stays a 500.
    if (error.status === 403) {
      // A refused CLAIM is the one 403 the page acts on rather than just
      // reports, so the backend's reason travels in `details.reason`. The
      // HTTP-level code stays `FORBIDDEN`: `reason` is the finer distinction,
      // matching how the XAA routes already carry theirs.
      //
      // Unrecognized codes fall through to a bare FORBIDDEN deliberately. This
      // deploys against a backend that may not have shipped the split yet, and
      // an older one answers a wrong-account claim with `FORBIDDEN` and prose
      // — which the page still renders. A default-to-mismatch guess would tell
      // signed-out visitors the wrong thing on exactly the deployments the
      // split was written to fix.
      const reason = claimRefusalReason(error.code);
      const ownerHint = error.details?.ownerHint;
      return new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        error.message,
        reason
          ? {
              reason,
              ...(typeof ownerHint === "string" && ownerHint
                ? { ownerHint }
                : {}),
            }
          : undefined
      );
    }
    if (error.status === 409) {
      return new WebRouteError(409, ErrorCode.CONFLICT, error.message);
    }
    if (error.status === 429) {
      return new WebRouteError(429, ErrorCode.RATE_LIMITED, error.message);
    }
  }
  return new WebRouteError(
    500,
    ErrorCode.INTERNAL_ERROR,
    "Could not complete that step."
  );
}

/**
 * Mint the continuation token here rather than taking one from the client.
 *
 * The browser must not choose its own capability value: a client-supplied token
 * could be predictable, reused across users, or replayed from another session.
 */
function mintContinuationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/**
 * The claim's two gates, mounted on the router rather than in `web/index.ts` so
 * they travel with the route instead of depending on a mount order.
 *
 * `resolveOptionalActor` is what makes the ownership check below real: it
 * resolves a VERIFIED signed-in user when there is one and does nothing at all
 * when there is not, which is the combination `bearerAuthMiddleware` cannot
 * offer — it 401s on a missing header, and the signed-out visitor is the normal
 * case here.
 *
 * The rate limiter is because this route is credential-free by design, so
 * nothing else bounds it.
 */
serverConnections.use(
  "/claim",
  serverConnectionClaimRateLimitMiddleware,
  resolveOptionalActor()
);

/** `/state` spends a backend round trip per poll; `/authorize` spends outbound
 * discovery + DCR against the target BEFORE the backend's attempt budget can
 * refuse. Both get their own per-IP window so a loop cannot spend either cost
 * freely; the backend budgets remain the durable cap. */
serverConnections.use("/state", serverConnectionStateRateLimitMiddleware);
serverConnections.use(
  "/authorize",
  serverConnectionAuthorizeRateLimitMiddleware
);

// POST /api/web/server-connections/claim
serverConnections.post("/claim", async (c) => {
  requireBrowserOrigin(c);
  const body = parseWithSchema(
    claimSchema,
    await c.req.json().catch(() => {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body"
      );
    })
  );

  const continuationToken = mintContinuationToken();
  try {
    const result = await claimHandoff({
      handoffToken: body.handoffToken,
      continuationToken,
      // The signed-in user, when there is one. The backend requires this to
      // match for an account-owned request, so a link that leaked into a
      // channel cannot be adopted by a different account. A guest-owned
      // request has no account to compare, and possession of the unguessable
      // single-use token is the capability — which is exactly why the chat
      // adapters never put that URL in a shared channel.
      actorUserId: c.get("mcpjamUserId") ?? undefined,
      // For the backend's own per-IP claim budget. This process is the
      // service-token-authenticated caller, so unlike the public create path
      // the backend can trust the attribution.
      clientIpKey: getClientIp(c) ?? undefined,
    });

    setCookie(c, CONTINUATION_COOKIE, continuationToken, {
      maxAgeSeconds: CONTINUATION_MAX_AGE_S,
      // Lax, not Strict: the OAuth provider sends the user back here with a
      // top-level GET navigation, and Strict would withhold the cookie on
      // exactly that hop, stranding the flow at the last step.
      sameSite: "Lax",
    });

    return c.json(
      {
        requestId: result.requestId,
        status: result.status,
        // The clean URL to continue on, with no token in it.
        next: `/connect/server/request/${result.requestId}`,
      },
      200,
      { "cache-control": "no-store" }
    );
  } catch (error) {
    throw translate(error);
  }
});

// GET /api/web/server-connections/state
serverConnections.get("/state", async (c) => {
  const token = requireContinuation(c);
  try {
    const state = await fetchHandoffState(token);
    return c.json(state, 200, { "cache-control": "no-store" });
  } catch (error) {
    throw translate(error);
  }
});

// POST /api/web/server-connections/select-project
serverConnections.post("/select-project", async (c) => {
  requireBrowserOrigin(c);
  const token = requireContinuation(c);
  const body = parseWithSchema(
    selectProjectSchema,
    await c.req.json().catch(() => {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body"
      );
    })
  );
  try {
    const result = await selectProject(token, body.projectId);
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    throw translate(error);
  }
});

/**
 * POST /api/web/server-connections/create-project
 *
 * Its own endpoint, reached only by an explicit button press. Project creation
 * never happens during request creation, discovery, or page load — a user must
 * be able to open a handoff link and look at it without silently acquiring a
 * project.
 */
serverConnections.post("/create-project", async (c) => {
  requireBrowserOrigin(c);
  const token = requireContinuation(c);
  try {
    const result = await ensureDefaultProject(token);
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    throw translate(error);
  }
});

/**
 * The redirect URI this deployment hands to an authorization server.
 *
 * Derived from the page's own `Origin` header rather than from configuration
 * or from `c.req.url`, and that is load-bearing twice over: the callback has
 * to land somewhere the `__Host-` continuation cookie will be sent, and
 * `__Host-` pins the cookie to exactly one origin — which is precisely the
 * origin the browser names in the header. `c.req.url` would NOT do: behind the
 * hosted TLS edge its scheme is the internal socket's `http`, which registers
 * a cleartext redirect URI, and behind the dev proxy its host is the server's
 * port, which strands the callback on an origin the cookie never lived on. The
 * header is allowlist-checked before use, so it cannot point at an attacker's
 * host.
 */
function callbackUriFor(origin: string): string {
  return new URL("/oauth/callback", origin).toString();
}

/**
 * The callback's fields.
 *
 * `error_description` is accepted alongside `errorDescription` because the
 * former is what an authorization server actually puts in the query string,
 * and the obvious way to call this route is to forward the callback's own
 * parameters. Rejecting the spec's spelling as an unknown key would turn every
 * declined consent into a 400 — a user pressing "no" would get an error page
 * instead of the offer to try again. Strictness is kept for everything else:
 * the point of it is that `continuationToken` cannot be smuggled in through
 * the body.
 */
const completeAuthorizationSchema = z
  .strictObject({
    state: z.string().trim().min(1),
    code: z.string().trim().min(1).optional(),
    iss: z.string().trim().min(1).optional(),
    error: z.string().trim().min(1).optional(),
    errorDescription: z.string().trim().min(1).max(300).optional(),
    error_description: z.string().trim().min(1).max(300).optional(),
  })
  .transform(({ error_description: snake, ...rest }) => ({
    ...rest,
    errorDescription: rest.errorDescription ?? snake,
  }));

/** Map a preparation failure onto something the page can say out loud. The
 * distinction that matters is refusal versus outage: a blocked target will
 * never work and a "try again" button would be a lie. */
function translatePrepare(error: unknown): WebRouteError {
  if (error instanceof AuthorizationPrepareError) {
    // A refusal is about the target and will not clear on its own; only an
    // outage earns a 5xx and the "try again" it implies.
    //
    // `NO_AUTHORIZATION_SERVER` is deliberately NOT in this set, though it
    // reads like a verdict. It means the metadata came back unreadable, and the
    // discovery walk cannot tell "this server publishes none" from "we could
    // not fetch it just now" — a 503 on the well-known path produces the same
    // absence. Calling that permanent would deny a retry to a server that is
    // merely having a bad minute.
    if (
      error.code === "URL_NOT_ALLOWED" ||
      error.code === "UNTRUSTWORTHY_METADATA"
    ) {
      return new WebRouteError(400, ErrorCode.VALIDATION_ERROR, error.message);
    }
    return new WebRouteError(502, ErrorCode.SERVER_UNREACHABLE, error.message);
  }
  return translate(error);
}

/**
 * POST /api/web/server-connections/authorize
 *
 * Prepare one authorization and hand the page a URL to open.
 *
 * The response contains the authorization URL and NOTHING ELSE. The PKCE
 * verifier generated alongside it goes straight to Convex — a verifier the
 * browser could read is a verifier an XSS on this origin could pair with a
 * stolen code, which is the whole property PKCE exists to provide.
 */
serverConnections.post("/authorize", async (c) => {
  const origin = requireBrowserOrigin(c);
  const token = requireContinuation(c);
  try {
    const context = await fetchAuthorizationContext(token);
    const redirectUri = callbackUriFor(origin);
    const prepared = await prepareAuthorization({
      serverUrl: context.serverUrl,
      redirectUri,
      requestedName: context.requestedName,
    });

    await startAuthorizationAttempt({
      continuationToken: token,
      clientId: prepared.clientId,
      clientSecret: prepared.clientSecret,
      codeVerifier: prepared.codeVerifier,
      redirectUri,
      state: prepared.state,
      issuer: prepared.issuer,
      oauthResourceUrl: prepared.oauthResourceUrl,
    });

    return c.json({ authorizationUrl: prepared.authorizationUrl }, 200, {
      "cache-control": "no-store",
    });
  } catch (error) {
    throw translatePrepare(error);
  }
});

/**
 * POST /api/web/server-connections/authorize/complete
 *
 * Redeem the callback. The page posts what came back in the query string; the
 * exchange itself happens in Convex, where the verifier and the client secret
 * are, so no token for the target server ever passes through this process.
 */
serverConnections.post("/authorize/complete", async (c) => {
  requireBrowserOrigin(c);
  const token = requireContinuation(c);
  const body = parseWithSchema(
    completeAuthorizationSchema,
    await c.req.json().catch(() => {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Invalid JSON body"
      );
    })
  );
  try {
    const result = await completeAuthorizationAttempt({
      continuationToken: token,
      ...body,
    });
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    throw translate(error);
  }
});

// POST /api/web/server-connections/cancel
serverConnections.post("/cancel", async (c) => {
  requireBrowserOrigin(c);
  const token = requireContinuation(c);
  try {
    const result = await cancelFromHandoff(token);
    // The request is over; the cookie is a credential for nothing now.
    clearCookie(c, CONTINUATION_COOKIE);
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    throw translate(error);
  }
});

export default serverConnections;
