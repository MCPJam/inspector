/**
 * The common insights envelope on the v1 surface: detail embeds, the eval
 * retry, and — security-critical — the guest boundary. Share-link guests must
 * never reach insight evidence: the new routes are absent from the guest
 * allowlist (default-deny), and the detail embeds fail CLOSED (envelope
 * omitted) when the backend authorization refuses the caller.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

beforeEach(() => {
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});

const queryMock = vi.fn();
const mutationMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
  },
}));

vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "convex-jwt",
  getConvexBearerThunkForRequest: async () => async () => "convex-jwt",
}));

import evals from "../evals.js";
import journeys from "../journeys.js";
import { v1OnError } from "../envelope.js";
import { isGuestAllowedV1Request } from "../guest-allowed-paths.js";

const PROJECT = "proj_a";
const RUN = "run_1";

function makeApp(router: Parameters<Hono["route"]>[1]) {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", router);
  return app;
}

function answerQueries(answers: Record<string, unknown>) {
  queryMock.mockImplementation((name: string) => {
    const fn = String(name).split(":").pop() ?? "";
    if (Object.prototype.hasOwnProperty.call(answers, fn)) {
      return Promise.resolve(answers[fn]);
    }
    return Promise.reject(new Error(`unexpected query ${String(name)}`));
  });
}

const RUN_ROW = {
  _id: RUN,
  suiteId: "suite_1",
  projectId: PROJECT,
  status: "completed",
  result: "failed",
  source: "api",
  createdAt: 1,
};

const ENVELOPE = {
  schemaVersion: 1,
  scope: { kind: "eval_run", id: RUN },
  status: "completed",
  reasonCode: null,
  retryable: false,
  error: null,
  generatedAt: 5,
  updatedAt: 5,
  summary: "create_event misleads the model.",
  coverage: {
    unit: "iterations",
    analyzed: 10,
    total: 10,
    gradedCount: 10,
    truncated: false,
    lowConfidence: false,
  },
  findings: [],
  truncation: {
    truncated: false,
    omittedFindings: 0,
    omittedEvidence: 0,
    contractTruncated: false,
  },
};

describe("eval-run detail — insights embed", () => {
  it("embeds the envelope on the detail response", async () => {
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: RUN_ROW,
      getEvalRunInsightsEnvelope: ENVELOPE,
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.insights).toEqual(ENVELOPE);
  });

  it("omits the envelope — never fails the read — when its query refuses", async () => {
    // A caller (e.g. a share-link guest actor) may see the run but not its
    // insights: the backend query throws, the field is simply absent.
    vi.clearAllMocks();
    queryMock.mockImplementation((name: string) => {
      const fn = String(name).split(":").pop() ?? "";
      if (fn === "getTestSuiteRun") return Promise.resolve(RUN_ROW);
      return Promise.reject(new Error("Not a member"));
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.insights).toBeUndefined();
  });
});

describe("eval-run insights retry", () => {
  it("202s with a pending receipt and forwards force", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    mutationMock.mockResolvedValue(null);
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      {
        method: "POST",
        body: JSON.stringify({ force: true }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      status: "pending",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "serverQuality:requestServerQuality",
      { suiteRunId: RUN, force: true },
    );
  });

  it("404s across projects before requesting anything", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: { ...RUN_ROW, projectId: "proj_b" } });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("eval-run insights retry — body validation (it SPENDS)", () => {
  it("400s on malformed JSON instead of billing for an empty body", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      {
        method: "POST",
        body: "{not json",
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("refuses a truthy non-boolean force rather than paying for it", async () => {
    // `{"force":"false"}` is a truthy STRING — coercing it would charge for a
    // regeneration the caller was trying to decline.
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      {
        method: "POST",
        body: JSON.stringify({ force: "false" }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it.each([
    ["null", JSON.stringify({ force: null })],
    ["whitespace-only body", "   "],
  ])("rejects %s rather than billing for it", async (_label, payload) => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      {
        method: "POST",
        body: payload,
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("accepts force: false without forwarding force", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    mutationMock.mockResolvedValue(null);
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      {
        method: "POST",
        body: JSON.stringify({ force: false }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(202);
    expect(mutationMock).toHaveBeenCalledWith(
      "serverQuality:requestServerQuality",
      { suiteRunId: RUN },
    );
  });

  it("accepts a bodyless POST", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    mutationMock.mockResolvedValue(null);
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      { method: "POST" },
    );
    expect(res.status).toBe(202);
  });
});

describe("journey-run detail — insights embed", () => {
  it("embeds the envelope beside the run DTO", async () => {
    vi.clearAllMocks();
    answerQueries({
      getJourneyRun: {
        _id: RUN,
        projectId: PROJECT,
        journeyRefId: "j_1",
        status: "completed",
        createdAt: 1,
        snapshot: { hosts: [], personaSnapshot: { name: "P" }, goal: "g" },
      },
      getJourneyRunInsightsEnvelope: {
        ...ENVELOPE,
        scope: { kind: "swarm_wave", id: "wave_1", runId: RUN },
        runHealth: { targets: [] },
      },
    });
    const res = await makeApp(journeys).request(
      `/api/v1/projects/${PROJECT}/journey-runs/${RUN}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.insights as Record<string, unknown>).runHealth).toEqual({
      targets: [],
    });
  });
});

describe("journey-run detail — envelope failure degrades", () => {
  it("returns the run without insights when the envelope query rejects", async () => {
    vi.clearAllMocks();
    queryMock.mockImplementation((name: string) => {
      const fn = String(name).split(":").pop() ?? "";
      if (fn === "getJourneyRun") {
        return Promise.resolve({
          _id: RUN,
          projectId: PROJECT,
          journeyRefId: "j_1",
          status: "completed",
          createdAt: 1,
          snapshot: { hosts: [], personaSnapshot: { name: "P" }, goal: "g" },
        });
      }
      return Promise.reject(new Error("Server Error"));
    });
    const res = await makeApp(journeys).request(
      `/api/v1/projects/${PROJECT}/journey-runs/${RUN}`,
    );
    expect(res.status).toBe(200);
    expect((await res.json()).insights).toBeUndefined();
  });
});

describe("eval-run detail — judges envelope", () => {
  const GRADED_RUN = {
    ...RUN_ROW,
    goalCompletionStatus: "completed",
    goalCompletion: {
      summary: "Two of three answers hit the goal.",
      generatedAt: 9,
      modelUsed: "openai/gpt-5.4-mini",
      threshold: 0.7,
      cases: [
        {
          caseKey: "ui_abc",
          iterationId: "it_1",
          score: 0.9,
          passed: true,
          reason: "named the right tool",
          rubricHits: ["cites the id"],
        },
      ],
    },
  };

  it("projects the persisted goal-completion result", async () => {
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: GRADED_RUN,
      getEvalRunInsightsEnvelope: ENVELOPE,
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.judges.goalCompletion).toEqual({
      status: "completed",
      errorCode: null,
      summary: "Two of three answers hit the goal.",
      generatedAt: 9,
      modelUsed: "openai/gpt-5.4-mini",
      threshold: 0.7,
      cases: [
        {
          // The persisted AUTHORED-case identity, kept under its own name so
          // nobody joins it against a case row id.
          caseKey: "ui_abc",
          // The join key. Without it a caller can only pair a judge case with
          // its iteration by array POSITION.
          iterationId: "it_1",
          score: 0.9,
          passed: true,
          reason: "named the right tool",
          rubricHits: ["cites the id"],
        },
      ],
    });
  });

  it("omits iterationId on a judge result persisted without one", async () => {
    // Rows written before the join key was projected must not grow a key
    // whose value would be a guess.
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: {
        ...GRADED_RUN,
        goalCompletion: {
          ...GRADED_RUN.goalCompletion,
          cases: [
            {
              caseKey: "ui_legacy",
              score: 0.4,
              passed: false,
              reason: "missed the goal",
              rubricHits: [],
            },
          ],
        },
      },
      getEvalRunInsightsEnvelope: ENVELOPE,
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    const body = (await res.json()) as any;
    expect(body.judges.goalCompletion.cases[0]).not.toHaveProperty(
      "iterationId",
    );
    expect(body.judges.goalCompletion.cases[0].caseKey).toBe("ui_legacy");
  });

  it("reports a never-requested judge as status null, not as an absent field", async () => {
    // A caller must be able to read `judges.goalCompletion.status` without
    // first proving the field exists, and `null` has to be distinguishable
    // from "ran and graded nothing".
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: RUN_ROW,
      getEvalRunInsightsEnvelope: ENVELOPE,
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    const body = (await res.json()) as any;
    expect(body.judges.goalCompletion.status).toBeNull();
    expect(body.judges.goalCompletion.cases).toEqual([]);
    expect(body.judges.groundedness.status).toBeNull();
  });

  it("carries no cases for a pending or failed judge, and names the error code", async () => {
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: {
        ...GRADED_RUN,
        goalCompletionStatus: "failed",
        goalCompletionErrorCode: "spend_cap_exceeded",
      },
      getEvalRunInsightsEnvelope: ENVELOPE,
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    const body = (await res.json()) as any;
    expect(body.judges.goalCompletion.status).toBe("failed");
    expect(body.judges.goalCompletion.errorCode).toBe("spend_cap_exceeded");
    expect(body.judges.goalCompletion.cases).toEqual([]);
  });

  it("projects groundedness with its own per-case evidence field", async () => {
    // Same envelope, NOT the same case shape: groundedness grades support from
    // the trajectory, so it reports unsupportedClaims where goal completion
    // reports rubricHits.
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: {
        ...RUN_ROW,
        groundednessStatus: "completed",
        groundedness: {
          summary: "One answer overreached.",
          generatedAt: 11,
          modelUsed: "openai/gpt-5.4-mini",
          threshold: 0.6,
          cases: [
            {
              caseKey: "ui_abc",
              score: 0.2,
              passed: false,
              reason: "invented a total",
              unsupportedClaims: ["the 42 figure"],
            },
          ],
        },
      },
      getEvalRunInsightsEnvelope: ENVELOPE,
    });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );
    const body = (await res.json()) as any;
    expect(body.judges.groundedness.cases).toEqual([
      {
        caseKey: "ui_abc",
        score: 0.2,
        passed: false,
        reason: "invented a total",
        unsupportedClaims: ["the 42 figure"],
      },
    ]);
  });
});

describe("eval-run judge request", () => {
  it("202s with a pending receipt and forwards the per-run override", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    mutationMock.mockResolvedValue(null);
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/judge`,
      {
        method: "POST",
        body: JSON.stringify({
          force: true,
          enable: true,
          model: "openai/gpt-5",
          threshold: 0.8,
        }),
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      status: "pending",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "goalCompletion:requestGoalCompletion",
      {
        suiteRunId: RUN,
        force: true,
        runOverride: {
          enabled: true,
          judgeModel: "openai/gpt-5",
          threshold: 0.8,
        },
      },
    );
  });

  it("sends NO override when the caller stated none", async () => {
    // The mutation clears a previously persisted override when the arg is
    // absent, so re-grading without restating one returns to suite-config
    // grading. Sending an empty object would defeat that.
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    mutationMock.mockResolvedValue(null);
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/judge`,
      { method: "POST" },
    );
    expect(res.status).toBe(202);
    expect(mutationMock).toHaveBeenCalledWith(
      "goalCompletion:requestGoalCompletion",
      { suiteRunId: RUN },
    );
  });

  it("404s across projects before requesting anything", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: { ...RUN_ROW, projectId: "proj_b" } });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/judge`,
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("surfaces a refused request instead of a false pending receipt", async () => {
    // `202 pending` is a PROMISE that grading was scheduled. Reporting it for
    // a mutation that never landed sends the caller to poll a judge that will
    // never move off `null`.
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    mutationMock.mockRejectedValue(new Error("Suite not found or unauthorized"));
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/judge`,
      { method: "POST" },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).not.toBe("pending");
    expect(body.code).toBeTruthy();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["a truthy non-boolean force", JSON.stringify({ force: "false" })],
    ["an out-of-range threshold", JSON.stringify({ threshold: 80 })],
    ["an unknown key", JSON.stringify({ autoRun: true })],
  ])("400s on %s rather than billing for it", async (_label, payload) => {
    // This endpoint SPENDS, so the body is validated, not coerced.
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/judge`,
      {
        method: "POST",
        body: payload,
        headers: { "content-type": "application/json" },
      },
    );
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});

describe("guest boundary (default-deny allowlist)", () => {
  it("keeps every insights surface guest-closed", () => {
    // Method-specific: the guest-readable eval-run DETAIL path stays open
    // (its envelope fails closed at the backend), but nothing that reaches
    // insight evidence directly, and no retry write, is guest-reachable.
    expect(
      isGuestAllowedV1Request(
        "POST",
        `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      ),
    ).toBe(false);
    // Grading spends the ORG's budget; a share-link guest must not be able to
    // start it. Closed by default-deny, asserted so an allowlist edit has to
    // break this test to reach it.
    expect(
      isGuestAllowedV1Request(
        "POST",
        `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/judge`,
      ),
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "GET",
        `/api/v1/projects/${PROJECT}/user-testing/scenarios/cb_1`,
      ),
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "POST",
        `/api/v1/projects/${PROJECT}/user-testing/scenarios/cb_1/insights`,
      ),
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "GET",
        `/api/v1/projects/${PROJECT}/journey-runs/${RUN}`,
      ),
    ).toBe(false);
  });
});
