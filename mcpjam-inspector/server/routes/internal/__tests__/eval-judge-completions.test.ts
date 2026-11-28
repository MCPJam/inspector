/**
 * The judge doorbell, and what stands in front of the second pass.
 *
 * THE MODE CHECK LIVES IN THE PASS, NOT THE ROUTE. `saveGoalCompletion` rings
 * this doorbell on every judge save without consulting the grading-engine
 * mode, and the route cannot see the run's snapshot. It therefore starts the
 * pass for every run, whatever this process's environment says, and the pass
 * settles a no-op fanout when the run it reads is `off` or `shadow`.
 *
 * The auth assertions mirror `server-connections.test.ts` and the real mount
 * order (session auth on `*` first), because the carve-out that lets a
 * token-bearing backend reach the router must not also let a browser session
 * reach it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const worker = vi.hoisted(() => ({
  runJudgeSecondPass: vi.fn(),
}));

const errorReport = vi.hoisted(() => ({
  reportRouteFailure: vi.fn(),
}));

vi.mock("../../../services/evals/judge-second-pass.js", () => worker);

vi.mock("../../../utils/route-error-report.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/route-error-report.js")
  >("../../../utils/route-error-report.js");
  return { ...actual, ...errorReport };
});

const { sessionAuthMiddleware } = await import(
  "../../../middleware/session-auth.js"
);
const { default: internalEvalJudgeCompletions } = await import(
  "../eval-judge-completions.js"
);

const SERVICE_TOKEN = "test-inspector-service-token";
const authed = { "x-inspector-service-token": SERVICE_TOKEN };

/** The entrypoint wiring, in the order `app.ts` and `index.ts` apply it. */
function createApp(): Hono {
  const app = new Hono();
  app.use("*", sessionAuthMiddleware);
  app.route("/api/internal/evals", internalEvalJudgeCompletions);
  return app;
}

function ring(
  app: Hono,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return app.request("/api/internal/evals/judge-completed", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", SERVICE_TOKEN);
  worker.runJudgeSecondPass.mockResolvedValue({ graded: 0 });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authorization", () => {
  it("lets a token-bearing backend through session auth to the route", async () => {
    const res = await ring(createApp(), { runId: "run1" }, authed);

    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toEqual({ ok: true, accepted: true });
    expect(worker.runJudgeSecondPass).toHaveBeenCalledWith("run1");
  });

  it("refuses a token-less call from the route's own guard", async () => {
    const res = await ring(createApp(), { runId: "run1" });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      ok: false,
      error: "unauthorized",
    });
    expect(worker.runJudgeSecondPass).not.toHaveBeenCalled();
  });

  it("refuses a wrong service token", async () => {
    const res = await ring(createApp(), { runId: "run1" }, {
      "x-inspector-service-token": "not-the-token",
    });

    expect(res.status).toBe(401);
    expect(worker.runJudgeSecondPass).not.toHaveBeenCalled();
  });

  it("refuses everything when the deployment configured no token", async () => {
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");

    const res = await ring(createApp(), { runId: "run1" }, authed);

    expect(res.status).toBe(401);
    expect(worker.runJudgeSecondPass).not.toHaveBeenCalled();
  });

  it("does not accept a session token in place of the service token", async () => {
    const res = await ring(createApp(), { runId: "run1" }, {
      "X-MCP-Session-Auth": "Bearer whatever",
    });

    expect(res.status).toBe(401);
    expect(worker.runJudgeSecondPass).not.toHaveBeenCalled();
  });
});

describe("the mode check", () => {
  it.each(["off", "shadow", "enforce", ""])(
    "starts the pass with the retired MCPJAM_GRADING_ENGINE_MODE at %j, so a no-op fanout can settle",
    async (value) => {
      // The route cannot see the run's snapshot, so the mode check lives in the
      // pass, which reads the run's own stamp. Entering it is correct whatever
      // this process's environment holds; writing is not the route's call.
      vi.stubEnv("MCPJAM_GRADING_ENGINE_MODE", value);

      const res = await ring(createApp(), { runId: "run1" }, authed);

      expect(res.status).toBe(202);
      await expect(res.json()).resolves.toEqual({
        ok: true,
        accepted: true,
      });
      expect(worker.runJudgeSecondPass).toHaveBeenCalledWith("run1");
    }
  );
});

describe("body handling", () => {
  it("rejects malformed JSON", async () => {
    const res = await ring(createApp(), "{not json", authed);
    expect(res.status).toBe(400);
    expect(worker.runJudgeSecondPass).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", {}],
    ["empty", { runId: "" }],
    ["non-string", { runId: 42 }],
  ])("rejects a %s runId", async (_label, body) => {
    const res = await ring(createApp(), body, authed);
    expect(res.status).toBe(400);
    expect(worker.runJudgeSecondPass).not.toHaveBeenCalled();
  });
});

describe("doorbell semantics", () => {
  it("answers 202 without waiting for the pass", async () => {
    let finish: (() => void) | undefined;
    worker.runJudgeSecondPass.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );

    const res = await ring(createApp(), { runId: "run1" }, authed);

    expect(res.status).toBe(202);
    finish?.();
  });

  it("still answers 202 when the pass rejects, and reports only the runId", async () => {
    worker.runJudgeSecondPass.mockRejectedValue(new Error("derivation blew up"));

    const res = await ring(createApp(), { runId: "run1" }, authed);

    expect(res.status).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));

    // Everything else the pass touches is customer evidence, so the run id is
    // the only field this report may carry.
    expect(errorReport.reportRouteFailure).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Error),
      expect.objectContaining({
        hop: "mcpjam_internal",
        context: { runId: "run1" },
      })
    );
  });
});
