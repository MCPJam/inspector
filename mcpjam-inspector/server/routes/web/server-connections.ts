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
  ensureDefaultProject,
  fetchHandoffState,
  selectProject,
  ServerConnectionBackendError,
} from "../../services/server-connections-backend.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "./errors.js";
import { readCookie, setCookie, clearCookie } from "./shared/cookies.js";
import { resolveOptionalActor } from "../../middleware/optional-actor.js";
import { serverConnectionClaimRateLimitMiddleware } from "../../middleware/server-connection-claim-rate-limit.js";

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
 * Reject a cross-site POST.
 *
 * These routes authenticate with a `SameSite=Lax` cookie, which is NOT sent on
 * a cross-site POST — so this is belt-and-braces rather than the only defence.
 * It is here because the cost is one header comparison and the failure it
 * guards against (a page on another origin advancing someone's connection
 * request) is silent.
 */
function assertSameOrigin(c: {
  req: { header: (name: string) => string | undefined; url: string };
}): void {
  const origin = c.req.header("origin");
  if (!origin) return; // Same-origin fetches may omit it entirely.
  try {
    if (new URL(origin).origin !== new URL(c.req.url).origin) {
      throw new WebRouteError(
        403,
        ErrorCode.FORBIDDEN,
        "Cross-origin requests are not allowed here."
      );
    }
  } catch (error) {
    if (error instanceof WebRouteError) throw error;
    throw new WebRouteError(403, ErrorCode.FORBIDDEN, "Invalid origin.");
  }
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
      return new WebRouteError(404, ErrorCode.NOT_FOUND, error.message);
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
      return new WebRouteError(403, ErrorCode.FORBIDDEN, error.message);
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

// POST /api/web/server-connections/claim
serverConnections.post("/claim", async (c) => {
  assertSameOrigin(c);
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
  assertSameOrigin(c);
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
  assertSameOrigin(c);
  const token = requireContinuation(c);
  try {
    const result = await ensureDefaultProject(token);
    return c.json(result, 200, { "cache-control": "no-store" });
  } catch (error) {
    throw translate(error);
  }
});

// POST /api/web/server-connections/cancel
serverConnections.post("/cancel", async (c) => {
  assertSameOrigin(c);
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
