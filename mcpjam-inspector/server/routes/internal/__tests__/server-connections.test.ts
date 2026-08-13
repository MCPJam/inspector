/**
 * The backend's doorbell, and the two gates in front of it.
 *
 * THE FIRST ASSERTION IS THE ONE THAT SHIPPED BROKEN. Both entrypoints mount
 * `sessionAuthMiddleware` on `*` BEFORE they mount this router, and that
 * middleware 401s any `/api/*` path it does not recognize. The backend has no
 * browser session to present — it sends `x-inspector-service-token` and nothing
 * else — so until `/api/internal/server-connections` was carved out, a correctly
 * authenticated dispatch was rejected by a gate that was never meant to judge
 * it, and no connection request could be advanced at all.
 *
 * The carve-out decides WHICH gate answers, never whether one does, so the
 * paired assertion matters just as much: a token-less POST must still be
 * refused, and refused by `internalServiceAuthMiddleware`. These tests mirror
 * the real mount order rather than testing the router in isolation, because
 * ordering is precisely what was wrong.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const worker = vi.hoisted(() => ({
  runConnectionJob: vi.fn(),
}));

const errorReport = vi.hoisted(() => ({
  reportRouteFailure: vi.fn(),
}));

vi.mock("../../../services/server-connection-worker.js", () => worker);

vi.mock("../../../utils/route-error-report.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/route-error-report.js")
  >("../../../utils/route-error-report.js");
  return { ...actual, ...errorReport };
});

const { sessionAuthMiddleware } = await import(
  "../../../middleware/session-auth.js"
);
const { default: internalServerConnections } = await import("../server-connections.js");

const SERVICE_TOKEN = "test-inspector-service-token";

/** The entrypoint wiring, in the order `app.ts` and `index.ts` apply it. */
function createApp(): Hono {
  const app = new Hono();
  app.use("*", sessionAuthMiddleware);
  app.route("/api/internal/server-connections", internalServerConnections);
  return app;
}

function dispatch(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return app.request("/api/internal/server-connections/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const authed = { "x-inspector-service-token": SERVICE_TOKEN };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  worker.runConnectionJob.mockResolvedValue({ requestId: "scr_x", ran: true });
});

describe("dispatch reachability", () => {
  it("lets an authenticated backend call through session auth to the route", async () => {
    const res = await dispatch(createApp(), { requestId: "scr_x" }, authed);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: true });
    expect(worker.runConnectionJob).toHaveBeenCalledWith("scr_x");
  });

  it("refuses a token-less call from the route's own guard, not from session auth", async () => {
    const res = await dispatch(createApp(), { requestId: "scr_x" });

    expect(res.status).toBe(401);
    // `internalServiceAuthMiddleware` answers `{ ok: false, error: "unauthorized" }`.
    // Session auth would have answered `{ error: "Unauthorized", message:
    // "Session token required." }` — asserting the body is what proves the
    // carve-out moved the decision rather than removing it.
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });

  it("refuses a wrong service token", async () => {
    const res = await dispatch(createApp(), { requestId: "scr_x" }, {
      "x-inspector-service-token": "not-the-token",
    });

    expect(res.status).toBe(401);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });

  it("refuses everything when the deployment configured no token", async () => {
    // Fail closed: "unconfigured" must never read as "unguarded".
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    const res = await dispatch(createApp(), { requestId: "scr_x" }, authed);

    expect(res.status).toBe(401);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });

  it("does not accept a session token in place of the service token", async () => {
    // The carve-out is not a downgrade to "any authenticated caller".
    const res = await dispatch(createApp(), { requestId: "scr_x" }, {
      "X-MCP-Session-Auth": "Bearer whatever",
    });

    expect(res.status).toBe(401);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });
});

describe("dispatch body handling", () => {
  it("rejects malformed JSON", async () => {
    const res = await dispatch(createApp(), "{not json", authed);

    expect(res.status).toBe(400);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });

  it("rejects a missing requestId", async () => {
    const res = await dispatch(createApp(), {}, authed);

    expect(res.status).toBe(400);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });

  it("rejects an empty requestId", async () => {
    const res = await dispatch(createApp(), { requestId: "" }, authed);

    expect(res.status).toBe(400);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });

  it("rejects a non-string requestId", async () => {
    const res = await dispatch(createApp(), { requestId: 42 }, authed);

    expect(res.status).toBe(400);
    expect(worker.runConnectionJob).not.toHaveBeenCalled();
  });
});

describe("doorbell semantics", () => {
  it("answers 202 without waiting for the job", async () => {
    let finish: (() => void) | undefined;
    worker.runConnectionJob.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );

    // The backend's push has a five-second timeout and does not care about the
    // result; holding it open would make a slow third-party server look like a
    // backend failure.
    const res = await dispatch(createApp(), { requestId: "scr_x" }, authed);

    expect(res.status).toBe(202);
    finish?.();
  });

  it("still answers 202 when the job rejects, and reports the failure", async () => {
    worker.runConnectionJob.mockRejectedValue(new Error("probe exploded"));

    const res = await dispatch(createApp(), { requestId: "scr_x" }, authed);

    expect(res.status).toBe(202);
    // Let the rejection settle so the handler's catch runs before we assert.
    await new Promise((resolve) => setImmediate(resolve));

    // The 202 already went out, so this report is the only record the failure
    // will ever have. `user_server_hop` keeps a third-party server's outage off
    // the on-call pager, and `requestId` is the only field safe to carry — the
    // job's context holds a decrypted access token.
    expect(errorReport.reportRouteFailure).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({
        hop: "user_server_hop",
        context: { requestId: "scr_x" },
      })
    );
  });
});
