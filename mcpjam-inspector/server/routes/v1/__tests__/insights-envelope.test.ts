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
const actionMock = vi.fn();

vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    setAuth() {}
    query(...args: unknown[]) {
      return queryMock(...args);
    }
    mutation(...args: unknown[]) {
      return mutationMock(...args);
    }
    action(...args: unknown[]) {
      return actionMock(...args);
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

// Id-SHAPED, like `RUN` below, and for the same reason the run/suite fixtures
// were reshaped: `proj_a` is a value production cannot produce, and fixtures
// that cannot be produced are how a suite ends up never exercising the shape
// its routes actually receive — which is why an unparseable id reached Convex
// in the first place. No route in THIS file gates `projectId` today (it is
// gated at the three sites that forward it to a `v.id('projects')` argument,
// none of which these routes reach), so this is realism, not a fix.
const PROJECT = "proj1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
const RUN = "run1xxxxxxxxxxxxxxxxxxxxxxxxxxxx";

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
  suiteId: "suite1xxxxxxxxxxxxxxxxxxxxxxxxxx",
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
    answerQueries({
      getTestSuiteRun: {
        ...RUN_ROW,
        projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
    });
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
          score: 0.9,
          passed: true,
          reason: "named the right tool",
          rubricHits: ["cites the id"],
        },
      ],
    });
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
    answerQueries({
      getTestSuiteRun: {
        ...RUN_ROW,
        projectId: "proj2xxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
    });
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

/**
 * The incident: a model polling a grouped launch concatenated the run ids it
 * had been handed and sent them as ONE path segment, `%20`-joined. Convex
 * rejected the argument before its handler ran, the route could not classify
 * the rejection, and every retry became a 500 tagged `origin=mcpjam` — Sentry
 * `CONVEX-1N8`, 21 events, and a paging Axiom monitor. The user cost was a
 * stall; the cost that mattered was the page.
 */
describe("a malformed run id is not an incident", () => {
  // Verbatim from the production access log, 2026-08-25T01:59:45Z: five run
  // ids in one segment. Hono has already decoded the `%20` by the time the
  // handler reads the param, so the fixture is the decoded form.
  const MULTI_ID = [
    "mh78djdyf2dqbmxky71sz9y6x58d5p2c",
    "mh7ck9qd0hzc7a2ckd3546ebq58d4yd3",
    "mh7d5c3ngvsx6mywf6m1nrv3a98d4p98",
    "mh708byqn84ke7556kh3gpy7j58d5jqf",
    "mh7f8dhfnnaazq58p9cmk3a0t98d556e",
  ].join(" ");

  it("404s the joined id WITHOUT calling Convex", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${encodeURIComponent(MULTI_ID)}`,
    );

    expect(res.status).toBe(404);
    // The assertion that pins the fix to the BOUNDARY. Every rejected
    // alternative — a smarter error translator, a tolerant Convex validator —
    // passes the status check above and fails this one, because they all let
    // the bad id become an outbound call and an exception first.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("does not leak the upstream text back to the caller", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${encodeURIComponent(MULTI_ID)}`,
    );
    const body = await res.text();

    expect(body).not.toContain("ArgumentValidationError");
    expect(body).not.toContain("Request ID");
    // The same sentence a genuinely missing run gets: a distinguishable answer
    // here would be an existence oracle.
    expect(JSON.parse(body).message).toBe("Eval run not found");
  });

  it("still reaches Convex for a well-formed id", async () => {
    // The regression guard for an over-tight gate. `looksLikeConvexId` accepts
    // 30-36 lowercase alphanumerics, and narrowing it would 404 every caller.
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`,
    );

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalled();
  });
});

/**
 * The gate's boundary conditions, which the shape check alone gets wrong.
 *
 * A shape gate has two failure directions, and the incident only motivated
 * one of them. Rejecting a malformed id is the fix; rejecting a value that was
 * never an id in the first place is a new bug wearing the fix's clothes.
 */
describe("the id gate must not reject an ABSENT optional id", () => {
  const DIFF = { cases: [], scorers: [] };

  it("treats ?baseRunId= as no baseline, not as a malformed one", async () => {
    // `?baseRunId=` is how a caller that always writes the key serializes an
    // unset value — `sdk/src/platform/client.ts` drops only `undefined` from a
    // query object, and a CI script interpolating an empty variable produces
    // exactly this. Every consumer of `baseRunId` in the handler is
    // truthiness-based, so the empty string has always MEANT "pick the previous
    // completed run". Gating on `!== undefined` alone turned that into a 404.
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });
    actionMock.mockResolvedValue({
      status: "ok",
      diff: DIFF,
      baseline: { policy: "previous_completed", baseRunId: "other" },
    });

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/compare?baseRunId=`,
    );

    expect(res.status).toBe(200);
    // The assertion that separates "absent" from "rejected": the action ran,
    // and it ran WITHOUT a baseRunId argument.
    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(actionMock.mock.calls[0]?.[1]).not.toHaveProperty("baseRunId");
  });

  it("still rejects a malformed baseRunId before the action", async () => {
    // The other direction, so the fix above cannot be "stop gating it".
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: RUN_ROW });

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/compare?baseRunId=${encodeURIComponent(
        `${RUN} ${RUN}`,
      )}`,
    );

    expect(res.status).toBe(404);
    expect(actionMock).not.toHaveBeenCalled();
  });
});

/**
 * The steps route's evidence read is documented as best-effort. It was not,
 * in production: the only refusal shapes it swallowed were the UNREDACTED
 * ones, and production Convex redacts the refusal this call actually produces
 * ("Iteration not found or unauthorized", a plain Error) to the same
 * "[Request ID: …] Server Error" a crash produces. So the degradation path
 * worked in dev and answered 500 — captured, paging — in prod.
 */
describe("iteration steps degrade to verdicts-only on a REDACTED refusal", () => {
  const ITERATION = "iter1xxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const ITERATION_ROW = {
    _id: ITERATION,
    suiteRunId: RUN,
    testCaseSnapshot: { steps: [] },
    metadata: { stepResults: [] },
  };

  it("returns 200 when the blob action fails with production's redacted text", async () => {
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: RUN_ROW,
      getTestIteration: ITERATION_ROW,
    });
    actionMock.mockRejectedValue(
      new Error("[Request ID: 182db601667cf972] Server Error"),
    );

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/iterations/${ITERATION}/steps`,
    );

    // Not 500. The two reads above already established that this caller may
    // see this iteration, so there is nothing left to refuse and nothing to
    // leak — and the response is otherwise complete.
    expect(res.status).toBe(200);
  });

  it("still fails on a TRANSPORT failure, which is a real outage", async () => {
    // The line that keeps the swallow honest: `fetch failed` classifies
    // `upstream`, never `redacted`, so a genuine outage does not get reported
    // as "this run has no evidence".
    vi.clearAllMocks();
    answerQueries({
      getTestSuiteRun: RUN_ROW,
      getTestIteration: ITERATION_ROW,
    });
    actionMock.mockRejectedValue(new Error("fetch failed"));

    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/iterations/${ITERATION}/steps`,
    );

    expect(res.status).toBeGreaterThanOrEqual(500);
  });
});
