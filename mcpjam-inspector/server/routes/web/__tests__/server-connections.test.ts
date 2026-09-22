/**
 * The handoff page's back end.
 *
 * THE COOKIE IS THE WHOLE DESIGN, so most of what is pinned here is about it:
 * the claim mints a continuation token server-side and puts it in an HttpOnly
 * cookie, every later step authenticates with that cookie, and the browser
 * never holds a credential it could leak. A change that let the client choose
 * the token, or that dropped `HttpOnly`, would pass a naive "does the flow
 * work" test and quietly undo the reason the flow is shaped this way.
 *
 * The other load-bearing assertion is the ACTOR. The backend refuses a claim on
 * an account-owned request unless the claimer's user id matches, and it has
 * only what the Inspector forwards to compare — so "the Inspector resolves a
 * signed-in user when there is one, and does not invent one when there is not"
 * is the property that makes a leaked link safe. Until the optional-actor
 * middleware existed, the route read a context value nothing ever set and
 * forwarded `undefined` on every single claim.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const backendCalls = vi.hoisted(() => ({
  claimHandoff: vi.fn(),
  fetchHandoffState: vi.fn(),
  selectProject: vi.fn(),
  ensureDefaultProject: vi.fn(),
  cancelFromHandoff: vi.fn(),
  fetchAuthorizationContext: vi.fn(),
  startAuthorizationAttempt: vi.fn(),
  completeAuthorizationAttempt: vi.fn(),
}));

const authorize = vi.hoisted(() => ({ prepareAuthorization: vi.fn() }));

const authkit = vi.hoisted(() => ({ verifyAuthKitToken: vi.fn() }));
const identity = vi.hoisted(() => ({ resolveUserByExternalId: vi.fn() }));

vi.mock("../../../services/server-connections-backend.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/server-connections-backend.js")
  >("../../../services/server-connections-backend.js");
  return { ...actual, ...backendCalls };
});

vi.mock("../../../services/server-connection-authorize.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/server-connection-authorize.js")
  >("../../../services/server-connection-authorize.js");
  return { ...actual, ...authorize };
});

vi.mock("../../../services/authkit-jwt.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/authkit-jwt.js")
  >("../../../services/authkit-jwt.js");
  return { ...actual, ...authkit };
});

vi.mock("../../../services/identity.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/identity.js")
  >("../../../services/identity.js");
  return { ...actual, ...identity };
});

const { ServerConnectionBackendError } = await import(
  "../../../services/server-connections-backend.js"
);
const { AuthKitVerificationError } = await import(
  "../../../services/authkit-jwt.js"
);
const { default: serverConnectionsWeb } = await import(
  "../server-connections.js"
);
const { resetServerConnectionClaimRateLimitForTests } = await import(
  "../../../middleware/server-connection-claim-rate-limit.js"
);
const { AuthorizationPrepareError } = await import(
  "../../../services/server-connection-authorize.js"
);
const { mapRuntimeError, webError } = await import("../errors.js");

const ORIGIN = "https://app.mcpjam.test";
const COOKIE = "__Host-mcpjam_server_connection";

// The routes validate the browser's `Origin` against the deployment allowlist
// — the same one the global origin middleware enforces — rather than against
// `c.req.url`, whose scheme/host are wrong behind the TLS edge and the dev
// proxy. The test origin has to be on that list, exactly as a deployment's
// public origin has to be.
process.env.ALLOWED_ORIGINS = ORIGIN;

/** Mirrors `routes/web/index.ts`: the router plus that file's `onError`, which
 * is what turns a thrown `WebRouteError` into the status the route intended. */
function createApp(): Hono {
  const app = new Hono();
  app.route("/api/web/server-connections", serverConnectionsWeb);
  app.onError((error, c) => {
    const routeError = mapRuntimeError(error);
    return webError(
      c,
      routeError.status,
      routeError.code,
      routeError.message,
      routeError.details
    );
  });
  return app;
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return createApp().request(`${ORIGIN}/api/web/server-connections${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return createApp().request(`${ORIGIN}/api/web/server-connections${path}`, {
    headers,
  });
}

const withCookie = { cookie: `${COOKIE}=continuation-abc` };

beforeEach(() => {
  vi.clearAllMocks();
  resetServerConnectionClaimRateLimitForTests();
  backendCalls.claimHandoff.mockResolvedValue({
    requestId: "scr_1",
    status: "awaiting_project",
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("claim", () => {
  it("mints the continuation token itself and never takes one from the client", async () => {
    const res = await post("/claim", {
      handoffToken: "handoff-1",
      // A client-chosen capability could be predictable, reused across users,
      // or replayed. The schema is strict, so offering one is a 400 rather
      // than something silently ignored.
      continuationToken: "attacker-chosen",
    });

    expect(res.status).toBe(400);
    expect(backendCalls.claimHandoff).not.toHaveBeenCalled();
  });

  it("puts the continuation token in an HttpOnly cookie and the request id in the body", async () => {
    const res = await post("/claim", { handoffToken: "handoff-1" });
    const rawBody = await res.clone().text();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      requestId: "scr_1",
      status: "awaiting_project",
      next: "/connect/server/request/scr_1",
    });

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // Lax, not Strict: the OAuth provider returns the user with a top-level GET
    // navigation, and Strict would withhold the cookie on exactly that hop.
    expect(setCookie).toContain("SameSite=Lax");

    // The minted token goes to the backend and to the cookie — never to the body.
    const sent = backendCalls.claimHandoff.mock.calls[0][0];
    expect(sent.continuationToken).toEqual(expect.any(String));
    expect(rawBody).not.toContain(sent.continuationToken);
  });

  it("forwards no actor for a signed-out visitor", async () => {
    const res = await post("/claim", { handoffToken: "handoff-1" });

    expect(res.status).toBe(200);
    expect(backendCalls.claimHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: undefined })
    );
    expect(authkit.verifyAuthKitToken).not.toHaveBeenCalled();
  });

  it("forwards the verified user id for a signed-in visitor", async () => {
    authkit.verifyAuthKitToken.mockResolvedValue({ sub: "workos_user_1" });
    identity.resolveUserByExternalId.mockResolvedValue({ _id: "users_1" });

    const res = await post(
      "/claim",
      { handoffToken: "handoff-1" },
      { authorization: "Bearer real-authkit-jwt" }
    );

    expect(res.status).toBe(200);
    expect(backendCalls.claimHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: "users_1" })
    );
  });

  it("forwards no actor when the bearer does not verify", async () => {
    // The identity is ASSERTED to the backend over the service channel, so an
    // unverified bearer must never become an actor — otherwise `Authorization:
    // Bearer anything` plus a stolen link would pass the ownership check.
    authkit.verifyAuthKitToken.mockRejectedValue(
      new AuthKitVerificationError("bad signature")
    );

    const res = await post(
      "/claim",
      { handoffToken: "handoff-1" },
      { authorization: "Bearer forged" }
    );

    // Not a 401: a stale token in a browser must not break the guest flow. The
    // backend fails closed on the other side.
    expect(res.status).toBe(200);
    expect(backendCalls.claimHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: undefined })
    );
    expect(identity.resolveUserByExternalId).not.toHaveBeenCalled();
  });

  it("forwards no actor when the identity service is down", async () => {
    authkit.verifyAuthKitToken.mockResolvedValue({ sub: "workos_user_1" });
    identity.resolveUserByExternalId.mockRejectedValue(
      new Error("convex down")
    );

    const res = await post(
      "/claim",
      { handoffToken: "handoff-1" },
      { authorization: "Bearer real-authkit-jwt" }
    );

    // The degradation is deliberate: a signed-in user is treated as a guest,
    // and the backend answers 403 for an account-owned link rather than
    // admitting anyone. Failing open here is what would be the bug.
    expect(res.status).toBe(200);
    expect(backendCalls.claimHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: undefined })
    );
  });

  it("does not attempt verification for an empty bearer", async () => {
    const res = await post(
      "/claim",
      { handoffToken: "handoff-1" },
      { authorization: "Bearer " }
    );

    expect(res.status).toBe(200);
    // Short-circuits before any JWKS round trip.
    expect(authkit.verifyAuthKitToken).not.toHaveBeenCalled();
  });

  it("surfaces the backend's wrong-account refusal as a 403", async () => {
    backendCalls.claimHandoff.mockRejectedValue(
      new ServerConnectionBackendError(
        "This authorization link belongs to a different account.",
        403,
        "FORBIDDEN"
      )
    );

    const res = await post("/claim", { handoffToken: "handoff-1" });

    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it.each([
    ["REQUEST_NOT_FOUND", 404, "Connection request not found"],
    ["REQUEST_EXPIRED", 410, "That authorization link has expired."],
  ])(
    "passes the backend's gone reason through to the page",
    async (code, status, message) => {
      backendCalls.claimHandoff.mockRejectedValue(
        new ServerConnectionBackendError(message, status, code)
      );

      const res = await post("/claim", { handoffToken: "handoff-1" });
      const body = (await res.json()) as { details?: { reason?: string } };

      expect(res.status).toBe(404);
      expect(body.details?.reason).toBe(code);
    }
  );

  it("passes the refusal reason and masked owner through to the page", async () => {
    // The page renders a different call to action per reason, so the reason has
    // to survive the hop. It travels in `details` rather than as the envelope
    // code, matching how the XAA routes carry theirs.
    backendCalls.claimHandoff.mockRejectedValue(
      new ServerConnectionBackendError(
        "This authorization link was created by a different MCPJam account.",
        403,
        "ACCOUNT_MISMATCH",
        { ownerHint: "m•••@mcpjam.com" }
      )
    );

    const res = await post("/claim", { handoffToken: "handoff-1" });
    const body = (await res.json()) as {
      details?: { reason?: string; ownerHint?: string };
    };

    expect(res.status).toBe(403);
    expect(body.details?.reason).toBe("account-mismatch");
    expect(body.details?.ownerHint).toBe("m•••@mcpjam.com");
  });

  it("distinguishes a signed-out claim from a wrong-account one", async () => {
    // The bug this whole change exists for: these two were one refusal, and
    // the signed-out visitor — the common case — was told the link belonged to
    // someone else.
    backendCalls.claimHandoff.mockRejectedValue(
      new ServerConnectionBackendError(
        "Sign in to finish connecting this server.",
        403,
        "SIGN_IN_REQUIRED"
      )
    );

    const res = await post("/claim", { handoffToken: "handoff-1" });
    const body = (await res.json()) as { details?: { reason?: string } };

    expect(res.status).toBe(403);
    expect(body.details?.reason).toBe("sign-in-required");
  });

  it("carries no reason when the backend predates the split", async () => {
    // A backend that has not deployed the split still answers `FORBIDDEN`.
    // Guessing a reason from the status would show a signed-out visitor the
    // switch-accounts flow, so the page must fall back to plain prose.
    backendCalls.claimHandoff.mockRejectedValue(
      new ServerConnectionBackendError("Refused.", 403, "FORBIDDEN")
    );

    const res = await post("/claim", { handoffToken: "handoff-1" });
    const body = (await res.json()) as { details?: unknown; message?: string };

    expect(res.status).toBe(403);
    expect(body.details).toBeUndefined();
    expect(body.message).toBe("Refused.");
  });

  it("rejects a cross-origin POST", async () => {
    const res = await post(
      "/claim",
      { handoffToken: "handoff-1" },
      { origin: "https://evil.example" }
    );

    expect(res.status).toBe(403);
    expect(backendCalls.claimHandoff).not.toHaveBeenCalled();
  });

  it("rejects a POST with no Origin header at all", async () => {
    // These are browser-only routes and a browser attaches `Origin` to every
    // POST, same-origin included — the only senders that omit it are
    // non-browser clients, which have no business on a cookie-authenticated
    // route. Absent-means-allow would also quietly disable the CSRF check for
    // any client that can strip a header.
    const res = await createApp().request(
      `${ORIGIN}/api/web/server-connections/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffToken: "handoff-1" }),
      }
    );

    expect(res.status).toBe(403);
    expect(backendCalls.claimHandoff).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const res = await createApp().request(
      `${ORIGIN}/api/web/server-connections/claim`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: "{not json",
      }
    );

    expect(res.status).toBe(400);
  });
});

describe("claim rate limiting", () => {
  /**
   * `HOSTED_MODE` is read at config import, so each mode needs a fresh module
   * registry — which means a fresh limiter with its OWN window map. The
   * `beforeEach` at the top of this file resets the instance bound at import
   * time, not this one, so every test here resets what it built.
   */
  async function limiterApp(hosted: boolean) {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", hosted ? "true" : "false");
    vi.resetModules();
    const mod = await import(
      "../../../middleware/server-connection-claim-rate-limit.js"
    );
    mod.resetServerConnectionClaimRateLimitForTests();

    const app = new Hono();
    app.use("*", mod.serverConnectionClaimRateLimitMiddleware);
    app.post("/claim", (c) => c.json({ ok: true }));
    app.get("/claim", (c) => c.json({ ok: true }));
    return { app, limit: mod.SERVER_CONNECTION_CLAIM_RATE_LIMIT, mod };
  }

  const claim = (app: Hono, headers: Record<string, string>, method = "POST") =>
    app.request("/claim", { method, headers });

  it("bounds attempts per address in hosted mode", async () => {
    const { app, limit, mod } = await limiterApp(true);
    const ip = { "x-real-ip": "203.0.113.9" };

    for (let i = 0; i < limit; i += 1) {
      expect((await claim(app, ip)).status).toBe(200);
    }
    expect((await claim(app, ip)).status).toBe(429);

    // A different address keeps its own budget.
    expect((await claim(app, { "x-real-ip": "198.51.100.4" })).status).toBe(
      200
    );

    mod.resetServerConnectionClaimRateLimitForTests();
  });

  it("does not let a GET spend the budget a real claim needs", async () => {
    const { app, limit, mod } = await limiterApp(true);
    const ip = { "x-real-ip": "203.0.113.11" };

    // A cross-site page can issue image GETs that never reach the handler. If
    // those charged the bucket, anyone could deny a visitor their one claim.
    for (let i = 0; i < limit + 5; i += 1) {
      await claim(app, ip, "GET");
    }
    expect((await claim(app, ip)).status).toBe(200);

    mod.resetServerConnectionClaimRateLimitForTests();
  });

  it("never refuses in local mode", async () => {
    const { app, limit, mod } = await limiterApp(false);
    const ip = { "x-real-ip": "127.0.0.1" };

    // One developer, dialling their own server. There is no fleet to protect.
    for (let i = 0; i < limit + 5; i += 1) {
      expect((await claim(app, ip)).status).toBe(200);
    }

    mod.resetServerConnectionClaimRateLimitForTests();
  });

  it("passes through a caller it cannot place", async () => {
    const { app, limit, mod } = await limiterApp(true);

    // No attributable address means no bucket to charge. Collapsing every such
    // caller into one shared bucket would let a single header-stripped request
    // starve the rest.
    for (let i = 0; i < limit + 5; i += 1) {
      expect((await claim(app, {})).status).toBe(200);
    }

    mod.resetServerConnectionClaimRateLimitForTests();
  });
});

describe("the steps after the claim", () => {
  it("refuses every one of them without the cookie", async () => {
    backendCalls.fetchHandoffState.mockResolvedValue({ requestId: "scr_1" });

    expect((await get("/state")).status).toBe(401);
    expect(
      (await post("/select-project", { projectId: "proj_1" })).status
    ).toBe(401);
    expect((await post("/create-project", {})).status).toBe(401);
    expect((await post("/cancel", {})).status).toBe(401);

    expect(backendCalls.fetchHandoffState).not.toHaveBeenCalled();
    expect(backendCalls.selectProject).not.toHaveBeenCalled();
  });

  it("authenticates with the cookie and forwards nothing else", async () => {
    backendCalls.fetchHandoffState.mockResolvedValue({
      requestId: "scr_1",
      status: "awaiting_project",
    });

    const res = await get("/state", {
      // An unrelated cookie on the same origin must not travel to the backend.
      cookie: `session=other-secret; ${COOKIE}=continuation-abc`,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(backendCalls.fetchHandoffState).toHaveBeenCalledWith(
      "continuation-abc"
    );
  });

  it("ignores the de-prefixed cookie name off loopback", async () => {
    // `__Host-` exists so a subdomain cannot set this cookie. Honouring the
    // bare name on a real origin would hand that property straight back.
    const res = await get("/state", {
      cookie: "mcpjam_server_connection=continuation-abc",
    });

    expect(res.status).toBe(401);
    expect(backendCalls.fetchHandoffState).not.toHaveBeenCalled();
  });

  it("accepts the de-prefixed cookie on local http, where the prefix is illegal", async () => {
    backendCalls.fetchHandoffState.mockResolvedValue({ requestId: "scr_1" });

    const res = await createApp().request(
      "http://localhost:3001/api/web/server-connections/state",
      { headers: { cookie: "mcpjam_server_connection=continuation-abc" } }
    );

    expect(res.status).toBe(200);
    expect(backendCalls.fetchHandoffState).toHaveBeenCalledWith(
      "continuation-abc"
    );
  });

  it("clears the cookie on cancel", async () => {
    backendCalls.cancelFromHandoff.mockResolvedValue({ status: "cancelled" });

    const res = await post("/cancel", {}, withCookie);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("reports an expired continuation as gone", async () => {
    // The backend answers 404 REQUEST_NOT_FOUND for a continuation it does not
    // recognize — expired, or consumed by a cancel.
    backendCalls.fetchHandoffState.mockRejectedValue(
      new ServerConnectionBackendError("not found", 404, "REQUEST_NOT_FOUND")
    );

    const res = await get("/state", withCookie);

    expect(res.status).toBe(404);
  });

  it("does not dress a service-token failure up as an expired session", async () => {
    // A 401 on this channel can only be `requireInspector` refusing OUR service
    // token — a deployment misconfiguration affecting every user. Reporting it
    // as "your link expired" would send everyone to re-open a link that works
    // while the real fault went unreported.
    backendCalls.fetchHandoffState.mockRejectedValue(
      new ServerConnectionBackendError("unauthorized", 401)
    );

    const res = await get("/state", withCookie);

    expect(res.status).toBe(500);
  });

  it("preserves the backend's conflict and gone distinctions", async () => {
    backendCalls.selectProject.mockRejectedValue(
      new ServerConnectionBackendError("already chosen", 409)
    );
    expect(
      (await post("/select-project", { projectId: "proj_1" }, withCookie))
        .status
    ).toBe(409);

    backendCalls.selectProject.mockRejectedValue(
      new ServerConnectionBackendError("gone", 410)
    );
    expect(
      (await post("/select-project", { projectId: "proj_1" }, withCookie))
        .status
    ).toBe(404);
  });

  it("creates a project only from its own explicit endpoint", async () => {
    backendCalls.ensureDefaultProject.mockResolvedValue({
      status: "discovering",
      projectId: "proj_new",
    });
    backendCalls.fetchHandoffState.mockResolvedValue({ requestId: "scr_1" });

    // Reading state must never have the side effect of acquiring a project.
    await get("/state", withCookie);
    expect(backendCalls.ensureDefaultProject).not.toHaveBeenCalled();

    const res = await post("/create-project", {}, withCookie);
    expect(res.status).toBe(200);
    expect(backendCalls.ensureDefaultProject).toHaveBeenCalledWith(
      "continuation-abc"
    );
  });
});

/**
 * The authorization step.
 *
 * One assertion here matters more than the rest: what comes back in the
 * response body. The route prepares a PKCE verifier and a client secret and
 * sends them to Convex; if either ever appeared in the JSON the page receives,
 * PKCE would be proving nothing and an XSS on this origin could pair a stolen
 * code with the verifier to redeem it. So the shape of the response is pinned
 * exactly, not merely checked for the field it should contain.
 */
describe("authorize", () => {
  const prepared = {
    authorizationUrl: "https://auth.example.com/authorize?client_id=cid",
    codeVerifier: "verifier-secret",
    state: "state-abc",
    clientId: "cid",
    clientSecret: "client-secret-value",
    issuer: "https://auth.example.com",
    oauthResourceUrl: "https://target.example.com/mcp",
  };

  beforeEach(() => {
    backendCalls.fetchAuthorizationContext.mockResolvedValue({
      requestId: "scr_1",
      serverUrl: "https://target.example.com/mcp?key=secret-query-value",
      serverId: "srv_1",
      projectId: "proj_1",
      authorizationServerUrl: null,
      registrationMode: null,
      requestedName: "Target",
    });
    authorize.prepareAuthorization.mockResolvedValue(prepared);
    backendCalls.startAuthorizationAttempt.mockResolvedValue({
      status: "authorizing",
    });
  });

  it("returns the authorization url and nothing else", async () => {
    const res = await post("/authorize", {}, withCookie);
    const raw = await res.clone().text();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      authorizationUrl: prepared.authorizationUrl,
    });
    // Named individually rather than trusting the deep-equal above, because a
    // future field added to the response would still pass `toEqual` if someone
    // updated the expectation without thinking about what it now carries.
    expect(raw).not.toContain("verifier-secret");
    expect(raw).not.toContain("client-secret-value");
    // The operational URL's query can BE the credential; the page gets
    // `displayUrl` and never this.
    expect(raw).not.toContain("secret-query-value");
  });

  it("hands the verifier to convex, not to the browser", async () => {
    await post("/authorize", {}, withCookie);

    expect(backendCalls.startAuthorizationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        continuationToken: "continuation-abc",
        codeVerifier: "verifier-secret",
        clientSecret: "client-secret-value",
        state: "state-abc",
      })
    );
  });

  it("redirects back to the origin the cookie is pinned to", async () => {
    await post("/authorize", {}, withCookie);

    // `__Host-` pins the continuation cookie to one origin. A redirect URI
    // pointing anywhere else returns the user to a page that cannot read it.
    const redirectUri = `${ORIGIN}/oauth/callback`;
    expect(authorize.prepareAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri })
    );
    expect(backendCalls.startAuthorizationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ redirectUri })
    );
  });

  it("refuses without the continuation cookie", async () => {
    const res = await post("/authorize", {});

    expect(res.status).toBe(401);
    expect(authorize.prepareAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin post", async () => {
    const res = await post(
      "/authorize",
      {},
      {
        ...withCookie,
        origin: "https://evil.example",
      }
    );

    expect(res.status).toBe(403);
    expect(backendCalls.startAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it("reports a blocked target as a refusal, not as an outage", async () => {
    authorize.prepareAuthorization.mockRejectedValue(
      new AuthorizationPrepareError("blocked", "URL_NOT_ALLOWED")
    );

    // 4xx, not 5xx: a blocked address will never work, and a page that offers
    // "try again" on it is lying to the user.
    expect((await post("/authorize", {}, withCookie)).status).toBe(400);

    authorize.prepareAuthorization.mockRejectedValue(
      new AuthorizationPrepareError("unreachable", "UNREACHABLE")
    );
    expect((await post("/authorize", {}, withCookie)).status).toBe(502);
  });

  it("does not spend an attempt when preparation failed", async () => {
    authorize.prepareAuthorization.mockRejectedValue(
      new AuthorizationPrepareError("unreachable", "UNREACHABLE")
    );

    await post("/authorize", {}, withCookie);

    // The attempt counter increments inside `startOAuthAttempt`. Calling it
    // after a failed preparation would burn one of three attempts on a consent
    // screen the user never saw.
    expect(backendCalls.startAuthorizationAttempt).not.toHaveBeenCalled();
  });
});

describe("authorize/complete", () => {
  beforeEach(() => {
    backendCalls.completeAuthorizationAttempt.mockResolvedValue({
      requestId: "scr_1",
      status: "validating",
    });
  });

  it("forwards the callback under the cookie's authority", async () => {
    const res = await post(
      "/authorize/complete",
      {
        state: "state-abc",
        code: "auth-code",
        iss: "https://auth.example.com",
      },
      withCookie
    );

    expect(res.status).toBe(200);
    expect(backendCalls.completeAuthorizationAttempt).toHaveBeenCalledWith({
      continuationToken: "continuation-abc",
      state: "state-abc",
      code: "auth-code",
      iss: "https://auth.example.com",
    });
  });

  it("carries a denial through rather than treating it as a failure", async () => {
    backendCalls.completeAuthorizationAttempt.mockResolvedValue({
      requestId: "scr_1",
      status: "awaiting_authorization",
    });

    const res = await post(
      "/authorize/complete",
      { state: "state-abc", error: "access_denied" },
      withCookie
    );

    // A user who declines consent gets a 200 and a status to render, not an
    // error page: the request is still alive and still has attempts.
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      requestId: "scr_1",
      status: "awaiting_authorization",
    });
  });

  it("refuses a body carrying anything it did not ask for", async () => {
    const res = await post(
      "/authorize/complete",
      { state: "state-abc", code: "auth-code", continuationToken: "attacker" },
      withCookie
    );

    // The cookie is the only source of the continuation token. A body field
    // that silently overrode it would undo the reason the cookie is HttpOnly.
    expect(res.status).toBe(400);
    expect(backendCalls.completeAuthorizationAttempt).not.toHaveBeenCalled();
  });

  it("refuses without the continuation cookie", async () => {
    const res = await post("/authorize/complete", {
      state: "state-abc",
      code: "auth-code",
    });

    expect(res.status).toBe(401);
    expect(backendCalls.completeAuthorizationAttempt).not.toHaveBeenCalled();
  });
});

describe("authorize/complete accepts the callback's own spelling", () => {
  it("takes error_description as the authorization server writes it", async () => {
    backendCalls.completeAuthorizationAttempt.mockResolvedValue({
      requestId: "scr_1",
      status: "awaiting_authorization",
    });

    const res = await post(
      "/authorize/complete",
      { state: "state-abc", error: "access_denied", error_description: "No." },
      withCookie
    );

    // `error_description` is what actually arrives in the query string, and
    // forwarding the callback's own parameters is the obvious way to call this
    // route. Rejecting the spec's spelling as an unknown key would turn every
    // declined consent into a 400 — a user pressing "no" would get an error
    // page instead of the offer to try again.
    expect(res.status).toBe(200);
    expect(backendCalls.completeAuthorizationAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ errorDescription: "No." })
    );
  });

  it("still refuses a body that tries to supply its own continuation token", async () => {
    const res = await post(
      "/authorize/complete",
      { state: "state-abc", code: "c", continuationToken: "attacker" },
      withCookie
    );

    // Widening the schema by one known key must not have widened it generally:
    // the cookie stays the only source of that token.
    expect(res.status).toBe(400);
  });
});
