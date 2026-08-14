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
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`
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
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}`
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
      }
    );
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      runId: RUN,
      projectId: PROJECT,
      status: "pending",
    });
    expect(mutationMock).toHaveBeenCalledWith(
      "serverQuality:requestServerQuality",
      { suiteRunId: RUN, force: true }
    );
  });

  it("404s across projects before requesting anything", async () => {
    vi.clearAllMocks();
    answerQueries({ getTestSuiteRun: { ...RUN_ROW, projectId: "proj_b" } });
    const res = await makeApp(evals).request(
      `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`,
      { method: "POST" }
    );
    expect(res.status).toBe(404);
    expect(mutationMock).not.toHaveBeenCalled();
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
      `/api/v1/projects/${PROJECT}/journey-runs/${RUN}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body.insights as Record<string, unknown>).runHealth).toEqual({
      targets: [],
    });
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
        `/api/v1/projects/${PROJECT}/eval-runs/${RUN}/insights`
      )
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "GET",
        `/api/v1/projects/${PROJECT}/user-testing/scenarios/cb_1`
      )
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "POST",
        `/api/v1/projects/${PROJECT}/user-testing/scenarios/cb_1/insights`
      )
    ).toBe(false);
    expect(
      isGuestAllowedV1Request(
        "GET",
        `/api/v1/projects/${PROJECT}/journey-runs/${RUN}`
      )
    ).toBe(false);
  });
});
