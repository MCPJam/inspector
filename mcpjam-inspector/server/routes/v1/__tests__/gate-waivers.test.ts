/**
 * The v1 gate-waiver surface (Evals v2, Lane E / step E5b).
 *
 * Three properties carry the weight here, and each of them is a way this
 * endpoint could look correct while being wrong:
 *
 *   1. THE REFUSALS KEEP THEIR OWN COPY. Five distinct `gate_waiver_*` codes
 *      arrive as structured ConvexErrors, and every one carries a message the
 *      backend wrote for the caller — the unscoped-suite one names a remedy
 *      nobody would guess. An unrecognized code falls past every branch in
 *      `translateConvexWriteError` into a 500 with the message stripped, so
 *      "it returns 400" is not enough: the message has to survive.
 *
 *   2. 403 AND 404 ARE DIFFERENT ANSWERS. A caller who resolved membership but
 *      lacks the manage tier has already established the suite exists; telling
 *      them "not found" sends a legitimate member hunting for a run in front of
 *      them. A caller who cannot see the scope at all still gets 404.
 *
 *   3. THE BODY IS STRICT. A non-strict v1 body strips unknown keys and answers
 *      200 for a request that did something other than what was written — a
 *      known bug class in this router, and a bad one on the endpoint whose
 *      entire purpose is to be an auditable record.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { validateGuestTokenMock, convexQueryMock, convexMutationMock } =
  vi.hoisted(() => ({
    validateGuestTokenMock: vi.fn(),
    convexQueryMock: vi.fn(),
    convexMutationMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
    mutation: convexMutationMock,
    action: vi.fn(),
  })),
}));

import v1Routes from "../index.js";

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return Promise.resolve(
    app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer tok",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

const NOW = 1_700_000_000_000;
const BASE = "/api/v1/projects/p1/eval-runs/run_1/gate-waivers";

const WAIVER_ROW = {
  id: "wv_1",
  suiteId: "suite_1",
  runId: "run_1",
  reason: "hotfix ships today; tracked in ENG-1",
  expiresAt: NOW + 86_400_000,
  createdAt: NOW - 3_600_000,
  createdBy: "usr_1",
  createdByEmail: "alice@example.com",
  revokedAt: null,
  revokedBy: null,
  active: true,
  policySnapshot: { minimumPassRate: 100 },
};

const RUN_DOC = {
  _id: "run_1",
  suiteId: "suite_1",
  projectId: "p1",
  status: "completed",
  result: "failed",
  summary: { total: 10, passed: 5, failed: 5 },
  source: "api",
  createdAt: NOW - 7_200_000,
  completedAt: NOW - 3_600_000,
  gateWaiver: null,
};

/** A structured refusal, in the exact shape a Convex mutation raises. */
function convexError(data: Record<string, unknown>): Error {
  const error = new Error(JSON.stringify(data));
  (error as Error & { data: unknown }).data = data;
  return error;
}

const originalEnv = {
  CONVEX_URL: process.env.CONVEX_URL,
  CONVEX_HTTP_URL: process.env.CONVEX_HTTP_URL,
};

describe("v1 gate waivers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
    convexQueryMock.mockImplementation((name: string) => {
      if (name === "testSuites:getTestSuiteRun") return RUN_DOC;
      if (name === "gateWaivers:getActiveWaiverForRun") return WAIVER_ROW;
      return null;
    });
    convexMutationMock.mockImplementation(() => ({
      status: "created",
      republishedChecks: 2,
      waiver: WAIVER_ROW,
    }));
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
  });

  // ── Create ────────────────────────────────────────────────────────────────

  it("grants a waiver and returns 201 with who, why and until when", async () => {
    const response = await request("POST", BASE, {
      reason: "hotfix ships today; tracked in ENG-1",
      expiresAt: NOW + 86_400_000,
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.status).toBe("created");
    expect(body.republishedChecks).toBe(2);
    expect(body.waiver).toMatchObject({
      id: "wv_1",
      createdByEmail: "alice@example.com",
      reason: "hotfix ships today; tracked in ENG-1",
      expiresAt: NOW + 86_400_000,
      active: true,
      policySnapshot: { minimumPassRate: 100 },
    });
  });

  it("reports an existing waiver as 409, not as a second grant", async () => {
    convexMutationMock.mockResolvedValue({
      status: "conflict",
      republishedChecks: 0,
      waiver: { ...WAIVER_ROW, reason: "somebody else's reason" },
    });
    const response = await request("POST", BASE, {
      reason: "mine",
      expiresAt: NOW + 1000,
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    // The body carries the waiver IN FORCE, so a caller can read whose it is
    // rather than believing their own reason is on the check.
    expect(body.status).toBe("conflict");
    expect(body.waiver.reason).toBe("somebody else's reason");
  });

  it("rejects an unknown body key rather than silently ignoring it", async () => {
    const response = await request("POST", BASE, {
      reason: "why",
      expiresAt: NOW + 1000,
      // A non-strict body would strip this and answer 200 for a request that
      // did something other than what the caller wrote.
      suiteWide: true,
    });
    expect(response.status).toBe(400);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  it("404s a run that belongs to another project", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuiteRun"
        ? { ...RUN_DOC, projectId: "other" }
        : null,
    );
    const response = await request("POST", BASE, {
      reason: "why",
      expiresAt: NOW + 1000,
    });
    expect(response.status).toBe(404);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });

  // ── The five refusals ─────────────────────────────────────────────────────

  const REFUSALS = [
    ["gate_waiver_unscoped_suite", "This suite does not belong to an organization, so a gate waiver cannot be recorded against it. A waiver is an organization-scoped, audited override; attach the suite to a project or workspace that belongs to an organization and try again."],
    ["gate_waiver_reason_empty", "A gate waiver requires a reason. Say why this gate is being overridden — the reason is the record."],
    ["gate_waiver_reason_too_long", "A gate waiver reason may be at most 500 characters."],
    ["gate_waiver_expiry_not_future", "A gate waiver must expire in the future. An expiry at or before now would be a waiver that never applies."],
    ["gate_waiver_expiry_too_far", "A gate waiver may not last longer than 30 days. Waive for as long as the fix actually needs, and re-waive if it needs longer."],
  ] as const;

  for (const [code, message] of REFUSALS) {
    it(`answers 400 for ${code} and forwards the platform's own message`, async () => {
      convexMutationMock.mockRejectedValue(
        convexError({ kind: "gate_waiver_refused", code, message }),
      );
      const response = await request("POST", BASE, {
        reason: "x",
        expiresAt: NOW + 1000,
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as any;
      // VERBATIM. Without an explicit branch these fall past every coded case
      // into the terminal 500, which strips the message entirely — so
      // asserting the status alone would pass on a translator that lost the
      // one sentence telling the caller what to do.
      expect(body.message).toBe(message);
    });
  }

  // ── Authorization: 403 and 404 are different answers ─────────────────────

  it("answers 403 when the caller can see the suite but lacks the manage tier", async () => {
    // `EvalAccessDeniedError` arrives as `kind: 'forbidden'` with NO `code`
    // field, so it matches none of the coded branches and none of the prose
    // patterns. Before this step it reached the terminal 500 — a deliberate
    // refusal reported as our own bug and paged for.
    convexMutationMock.mockRejectedValue(
      convexError({
        kind: "forbidden",
        action: "gate.waive",
        message: "Insufficient permissions for gate.waive: requires manage",
      }),
    );
    const response = await request("POST", BASE, {
      reason: "x",
      expiresAt: NOW + 1000,
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.message).toContain("Insufficient permissions");
  });

  it("answers 404 when the caller cannot see the scope at all", async () => {
    // The backend collapses these into its own not-found string precisely so
    // this endpoint cannot become an existence oracle over run ids.
    convexMutationMock.mockRejectedValue(new Error("Suite run not found"));
    const response = await request("POST", BASE, {
      reason: "x",
      expiresAt: NOW + 1000,
    });
    expect(response.status).toBe(404);
  });

  // ── Read ──────────────────────────────────────────────────────────────────

  it("serves the active waiver to anyone who can view the run", async () => {
    const response = await request("GET", BASE);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.waiver.id).toBe("wv_1");
  });

  it("answers null — not 404 — when no waiver is in force", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuiteRun" ? RUN_DOC : null,
    );
    const response = await request("GET", BASE);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.waiver).toBeNull();
  });

  // ── Revoke ────────────────────────────────────────────────────────────────

  it("revokes and reports the republished checks", async () => {
    convexMutationMock.mockResolvedValue({
      status: "revoked",
      republishedChecks: 1,
      waiver: { ...WAIVER_ROW, active: false, revokedAt: NOW, revokedBy: "usr_2" },
    });
    const response = await request("DELETE", `${BASE}/wv_1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.status).toBe("revoked");
    expect(body.waiver.revokedBy).toBe("usr_2");
  });

  it("treats a second revoke as a SUCCESS, not an error", async () => {
    // `already_revoked` reports the ORIGINAL revocation rather than restamping
    // it. Turning it into an error would push callers into the retry loop that
    // record has to survive.
    convexMutationMock.mockResolvedValue({
      status: "already_revoked",
      republishedChecks: 0,
      waiver: { ...WAIVER_ROW, active: false, revokedAt: NOW - 60_000, revokedBy: "usr_2" },
    });
    const response = await request("DELETE", `${BASE}/wv_1`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.status).toBe("already_revoked");
  });

  it("refuses a waiver addressed through the wrong run BEFORE revoking it", async () => {
    // The mutation authorizes against the WAIVER's suite, so without this a
    // waiver reached through another run's URL would be revoked and then
    // reported as not-found — performing the destructive act it refuses.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuiteRun"
        ? { ...RUN_DOC, gateWaiver: { ...WAIVER_ROW, id: "wv_other" } }
        : null,
    );
    const response = await request("DELETE", `${BASE}/wv_1`);
    expect(response.status).toBe(404);
    expect(convexMutationMock).not.toHaveBeenCalled();
  });
});

// ── The run projection ──────────────────────────────────────────────────────

describe("the run projection carries the waiver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_URL = "https://convex.example.com";
    process.env.CONVEX_HTTP_URL = "https://convex-http.example.com";
    validateGuestTokenMock.mockResolvedValue({ valid: false });
  });

  it("puts `gateWaiver` on GET /eval-runs/:runId, so a gate needs no second call", async () => {
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuiteRun"
        ? { ...RUN_DOC, gateWaiver: WAIVER_ROW }
        : null,
    );
    const response = await request("GET", "/api/v1/projects/p1/eval-runs/run_1");
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.gateWaiver).toMatchObject({
      id: "wv_1",
      createdByEmail: "alice@example.com",
      active: true,
    });
    // The run keeps its HONEST verdict. Nothing about a waiver touches this.
    expect(body.result).toBe("failed");
  });

  it("is `null`, not absent, when there is no waiver", async () => {
    // `null` lets a caller tell "no waiver" from "a deployment that does not
    // report one"; omitting it collapses those into one answer.
    convexQueryMock.mockImplementation((name: string) =>
      name === "testSuites:getTestSuiteRun" ? RUN_DOC : null,
    );
    const response = await request("GET", "/api/v1/projects/p1/eval-runs/run_1");
    const body = (await response.json()) as any;
    expect(body).toHaveProperty("gateWaiver");
    expect(body.gateWaiver).toBeNull();
  });
});
