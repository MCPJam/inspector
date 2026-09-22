/**
 * The chat-session chain doorbell, and the gates in front of the pass.
 *
 * The auth assertions mirror `eval-judge-completions.test.ts` and the real
 * mount order (session auth on `*` first), because the carve-out that lets a
 * token-bearing backend reach the router must not also let a browser session
 * reach it.
 *
 * THE BODY CARRIES NO SELECTOR, and that is the assertion worth having. A
 * session id in the body would look like it named the work, and something
 * would eventually trust it. The pass claims from the backend's own queue, so
 * what gets derived is decided by the backend's lifecycle — a ring is a
 * wake-up, not an instruction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const pass = vi.hoisted(() => ({
  runChatSessionStagePass: vi.fn(),
}));

const errorReport = vi.hoisted(() => ({
  reportRouteFailure: vi.fn(),
}));

vi.mock("../../../services/chat-stage/chat-session-stage-pass.js", () => pass);

vi.mock("../../../utils/route-error-report.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/route-error-report.js")
  >("../../../utils/route-error-report.js");
  return { ...actual, ...errorReport };
});

const { sessionAuthMiddleware } = await import(
  "../../../middleware/session-auth.js"
);
const { default: internalChatStageDerivations } = await import(
  "../chat-stage-derivations.js"
);

const SERVICE_TOKEN = "test-inspector-service-token";
const authed = { "x-inspector-service-token": SERVICE_TOKEN };

/** The entrypoint wiring, in the order `app.ts` and `index.ts` apply it. */
function createApp(): Hono {
  const app = new Hono();
  app.use("*", sessionAuthMiddleware);
  app.route("/api/internal/chat-stage", internalChatStageDerivations);
  return app;
}

function ring(
  app: Hono,
  body: unknown = {},
  headers: Record<string, string> = {}
) {
  return app.request("/api/internal/chat-stage/derivation-requested", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  pass.runChatSessionStagePass.mockResolvedValue({ noop: true, claimed: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authorization", () => {
  it("lets a token-bearing backend through session auth to the route", async () => {
    const res = await ring(createApp(), {}, authed);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: true });
    expect(pass.runChatSessionStagePass).toHaveBeenCalledTimes(1);
  });

  it("refuses a token-less call from the route's own guard", async () => {
    const res = await ring(createApp());

    expect(res.status).toBe(401);
    expect(pass.runChatSessionStagePass).not.toHaveBeenCalled();
  });

  it("refuses a wrong service token", async () => {
    const res = await ring(
      createApp(),
      {},
      {
        "x-inspector-service-token": "not-the-token",
      }
    );

    expect(res.status).toBe(401);
    expect(pass.runChatSessionStagePass).not.toHaveBeenCalled();
  });

  it("refuses everything when the deployment configured no token", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    expect((await ring(createApp(), {}, authed)).status).toBe(401);
    expect(pass.runChatSessionStagePass).not.toHaveBeenCalled();
  });

  it("does not accept a session token in place of the service token", async () => {
    const res = await ring(
      createApp(),
      {},
      {
        "X-MCP-Session-Auth": "Bearer whatever",
      }
    );

    expect(res.status).toBe(401);
    expect(pass.runChatSessionStagePass).not.toHaveBeenCalled();
  });
});

describe("doorbell semantics", () => {
  it("nothing in the body reaches the pass — the ring names no work", async () => {
    await ring(
      createApp(),
      { sessionDocId: "someone-elses-session", generation: 99 },
      authed
    );

    expect(pass.runChatSessionStagePass).toHaveBeenCalledWith();
  });

  it("accepts a malformed body — there is nothing in it to be malformed", async () => {
    const res = await ring(createApp(), "not json at all", authed);

    expect(res.status).toBe(202);
    expect(pass.runChatSessionStagePass).toHaveBeenCalledTimes(1);
  });

  it("answers before the work finishes", async () => {
    let settle: () => void = () => {};
    pass.runChatSessionStagePass.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      })
    );

    const res = await ring(createApp(), {}, authed);

    expect(res.status).toBe(202);
    settle();
  });

  it("a failing pass is reported, never thrown at the caller", async () => {
    pass.runChatSessionStagePass.mockRejectedValue(new Error("boom"));

    const res = await ring(createApp(), {}, authed);
    expect(res.status).toBe(202);

    await vi.waitFor(() => {
      expect(errorReport.reportRouteFailure).toHaveBeenCalledTimes(1);
    });
    const [, , context] = errorReport.reportRouteFailure.mock.calls[0];
    // Nothing session-specific is recorded: everything the pass touches is
    // customer evidence.
    expect(context).toEqual({
      source: "chat-stage-derivations.derivation-requested",
      hop: "mcpjam_internal",
    });
  });
});
