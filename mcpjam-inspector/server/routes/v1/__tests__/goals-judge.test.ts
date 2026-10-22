import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const { queryMock, mutationMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  mutationMock: vi.fn(),
}));

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
  getBackgroundRunBearerForRequest: async () => async () => "convex-jwt",
}));

vi.mock("../../../services/xaa-mint.js", () => ({
  resolveXaaIssuer: () => "https://issuer.test",
}));

vi.mock("../../web/auth.js", () => ({
  callerContextFromHono: () => ({}),
}));

vi.mock("../../../services/sessionSimulation/launch-journey-run.js", () => ({
  launchJourneyRun: vi.fn(),
}));

import goals from "../goals.js";
import { v1OnError } from "../envelope.js";

const PROJECT = "projaxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const JOURNEY = "jrn_1";

function makeApp() {
  const app = new Hono();
  app.onError(v1OnError);
  app.route("/api/v1", goals);
  return app;
}

function get(path: string) {
  return makeApp().request(`/api/v1${path}`);
}

const journeyRow = (overrides: Record<string, unknown> = {}) => ({
  _id: JOURNEY,
  projectId: PROJECT,
  personaRefId: "persona_1",
  swarmRefId: null,
  name: "Checkout flow",
  goal: "Buy something",
  serverAttachmentId: null,
  environmentIds: ["env_1"],
  config: { sessionsPerTarget: 3, maxTurns: 12 },
  createdAt: 1,
  updatedAt: 2,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CONVEX_URL", "https://convex.test");
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

/**
 * The goal-completion judge on the authoring routes. What these pin: the
 * public judge vocabulary is the suite settings one (`model`,
 * `modelSelection`, `autoRun`…), the write lands in the Convex
 * `judgeConfig.goalCompletion` envelope with a hosted `mcpjam/` id rewritten
 * the way the suite path rewrites it, a PATCH merges onto the stored slot and
 * `null` clears it, and the read is the resolved judge a run would grade with.
 */
describe("goal judge", () => {
  const post = (body: Record<string, unknown>, path = "goals") =>
    makeApp().request(`/api/v1/projects/${PROJECT}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personaId: "persona_1",
        goal: "Test",
        maxTurns: 6,
        ...body,
      }),
    });
  const patch = (body: Record<string, unknown>) =>
    makeApp().request(`/api/v1/projects/${PROJECT}/goals/${JOURNEY}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const hostedSelection = {
    modelId: "anthropic/claude-haiku-4.5",
    source: "hosted",
    fallback: { provider: "none", model: "none" },
  };

  it("creates with a judge, rewriting the hosted spelling of its model", async () => {
    queryMock.mockResolvedValue([{ _id: "persona_1", projectId: PROJECT }]);
    mutationMock.mockResolvedValue(
      journeyRow({
        judgeConfig: {
          goalCompletion: {
            enabled: true,
            autoRun: false,
            judgeModel: "anthropic/claude-haiku-4.5",
            threshold: 0.9,
          },
        },
      }),
    );
    const res = await post({
      iterations: 1,
      judge: {
        autoRun: false,
        model: "mcpjam/anthropic/claude-haiku-4.5",
        threshold: 0.9,
      },
    });
    expect(res.status).toBe(201);
    expect(mutationMock.mock.calls[0][1].judgeConfig).toEqual({
      goalCompletion: {
        autoRun: false,
        judgeModel: "anthropic/claude-haiku-4.5",
        threshold: 0.9,
      },
    });
    expect(await res.json()).toMatchObject({
      judge: {
        enabled: true,
        autoRun: false,
        model: "anthropic/claude-haiku-4.5",
        threshold: 0.9,
      },
    });
  });

  it("stores the selection beside the model it names", async () => {
    queryMock.mockResolvedValue([{ _id: "persona_1", projectId: PROJECT }]);
    mutationMock.mockResolvedValue(journeyRow());
    const res = await post({
      iterations: 1,
      judge: { modelSelection: hostedSelection },
    });
    expect(res.status).toBe(201);
    expect(mutationMock.mock.calls[0][1].judgeConfig).toEqual({
      goalCompletion: {
        judgeModel: "anthropic/claude-haiku-4.5",
        judgeSelection: hostedSelection,
      },
    });
  });

  it("omits judgeConfig when no judge was sent, so the backend applies its defaults", async () => {
    queryMock.mockResolvedValue([{ _id: "persona_1", projectId: PROJECT }]);
    mutationMock.mockResolvedValue(journeyRow());
    expect((await post({ iterations: 1 })).status).toBe(201);
    expect(mutationMock.mock.calls[0][1]).not.toHaveProperty("judgeConfig");
  });

  it("reads the resolved judge — managed defaults for a goal that never set one", async () => {
    queryMock.mockResolvedValue(journeyRow());
    const res = await get(`/projects/${PROJECT}/goals/${JOURNEY}`);
    expect(await res.json()).toMatchObject({
      judge: {
        enabled: true,
        model: "openai/gpt-5.4-mini",
        autoRun: true,
        threshold: 0.7,
      },
    });
  });

  it("merges a partial PATCH onto the stored slot instead of replacing it", async () => {
    queryMock.mockResolvedValue(
      journeyRow({
        judgeConfig: {
          goalCompletion: {
            enabled: true,
            judgeModel: "anthropic/claude-haiku-4.5",
            judgeSelection: hostedSelection,
            judgeSelectionOrigin: "backfill",
            threshold: 0.8,
          },
        },
      }),
    );
    mutationMock.mockResolvedValue(journeyRow());
    const res = await patch({ judge: { autoRun: false } });
    expect(res.status).toBe(200);
    expect(mutationMock.mock.calls[0][1].judgeConfig).toEqual({
      goalCompletion: {
        enabled: true,
        judgeModel: "anthropic/claude-haiku-4.5",
        judgeSelection: hostedSelection,
        judgeSelectionOrigin: "backfill",
        threshold: 0.8,
        autoRun: false,
      },
    });
  });

  it("drops a stored selection when the model moves away from it", async () => {
    queryMock.mockResolvedValue(
      journeyRow({
        judgeConfig: {
          goalCompletion: {
            judgeModel: "anthropic/claude-haiku-4.5",
            judgeSelection: hostedSelection,
            judgeSelectionOrigin: "backfill",
          },
        },
      }),
    );
    mutationMock.mockResolvedValue(journeyRow());
    expect((await patch({ judge: { model: "openai/gpt-5" } })).status).toBe(
      200,
    );
    expect(mutationMock.mock.calls[0][1].judgeConfig).toEqual({
      goalCompletion: { judgeModel: "openai/gpt-5" },
    });
  });

  it("clears the judge with null, forwarded verbatim", async () => {
    queryMock.mockResolvedValue(journeyRow());
    mutationMock.mockResolvedValue(journeyRow());
    expect((await patch({ judge: null })).status).toBe(200);
    expect(mutationMock.mock.calls[0][1]).toMatchObject({ judgeConfig: null });
  });

  it("400s a selection that names a different model than `model`", async () => {
    queryMock.mockResolvedValue(journeyRow());
    const res = await patch({
      judge: { model: "openai/gpt-5", modelSelection: hostedSelection },
    });
    expect(res.status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("refuses the storage spelling and a mixed vocabulary alike", async () => {
    queryMock.mockResolvedValue([{ _id: "persona_1", projectId: PROJECT }]);
    // `judgeConfig` is Convex's name, not the API's.
    expect(
      (
        await post({
          iterations: 1,
          judgeConfig: { goalCompletion: { autoRun: false } },
        })
      ).status,
    ).toBe(400);
    // Inside `judge`, likewise: `judgeModel` is storage's spelling.
    expect(
      (
        await post({
          iterations: 1,
          judge: { judgeModel: "openai/gpt-5" },
        })
      ).status,
    ).toBe(400);
    // A judge does not loosen the surface's own strictness.
    expect(
      (
        await post({
          sessionsPerTarget: 1,
          judge: { autoRun: false },
        })
      ).status,
    ).toBe(400);
    expect((await patch({ judge: {} })).status).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });

  it("takes the same judge on the deprecated alias", async () => {
    queryMock.mockResolvedValue([{ _id: "persona_1", projectId: PROJECT }]);
    mutationMock.mockResolvedValue(journeyRow());
    const res = await post(
      { sessionsPerTarget: 1, judge: { autoRun: false } },
      "journeys",
    );
    expect(res.status).toBe(201);
    expect(mutationMock.mock.calls[0][1].judgeConfig).toEqual({
      goalCompletion: { autoRun: false },
    });
  });
});
