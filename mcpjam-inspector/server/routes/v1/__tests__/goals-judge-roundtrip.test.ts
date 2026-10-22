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
 * A `goal.judge` read can be sent back on PATCH as it was read: the saved
 * choice is `modelSelection` on both sides, a stored legacy selection is
 * accepted, and the read-only `modelSelectionOrigin` marker stays only while
 * the stored selection is sent back unchanged.
 */
describe("goal judge round trip", () => {
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

  it("reads the saved choice under its public name and takes the read back on PATCH", async () => {
    const goalCompletion = {
      enabled: true,
      autoRun: true,
      judgeModel: "anthropic/claude-haiku-4.5",
      judgeSelection: hostedSelection,
      judgeSelectionOrigin: "backfill",
      threshold: 0.8,
    };
    const stored = journeyRow({ judgeConfig: { goalCompletion } });
    queryMock.mockResolvedValue(stored);
    const read = (await (
      await get(`/projects/${PROJECT}/goals/${JOURNEY}`)
    ).json()) as { judge: Record<string, unknown> };
    expect(read.judge).toEqual({
      enabled: true,
      model: "anthropic/claude-haiku-4.5",
      modelSelection: hostedSelection,
      modelSelectionOrigin: "backfill",
      autoRun: true,
      threshold: 0.8,
    });
    expect(read.judge).not.toHaveProperty("judgeSelection");

    mutationMock.mockResolvedValue(stored);
    expect((await patch({ judge: read.judge })).status).toBe(200);
    // Sent back unchanged, so nothing moved — the conversion marker included.
    expect(mutationMock.mock.calls[0][1].judgeConfig).toEqual({
      goalCompletion,
    });
  });

  it("round-trips a stored legacy selection", async () => {
    const legacy = { source: "legacy", modelId: "openai/gpt-4o" };
    const stored = journeyRow({
      judgeConfig: {
        goalCompletion: { judgeModel: "openai/gpt-4o", judgeSelection: legacy },
      },
    });
    queryMock.mockResolvedValue(stored);
    mutationMock.mockResolvedValue(stored);
    const read = (await (
      await get(`/projects/${PROJECT}/goals/${JOURNEY}`)
    ).json()) as { judge: Record<string, unknown> };
    expect(read.judge.modelSelection).toEqual(legacy);
    expect((await patch({ judge: read.judge })).status).toBe(200);
    expect(
      mutationMock.mock.calls[0][1].judgeConfig.goalCompletion.judgeSelection,
    ).toEqual(legacy);
  });

  it("drops the conversion marker when a different selection is sent", async () => {
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
    const withEffort = {
      ...hostedSelection,
      settings: { reasoningEffort: "low" },
    };
    expect(
      (
        await patch({
          judge: {
            modelSelection: withEffort,
            modelSelectionOrigin: "backfill",
          },
        })
      ).status,
    ).toBe(200);
    const written = mutationMock.mock.calls[0][1].judgeConfig.goalCompletion;
    expect(written.judgeSelection).toEqual(withEffort);
    expect(written).not.toHaveProperty("judgeSelectionOrigin");
  });

  it("treats a legacy selection with another provider as a different selection", async () => {
    queryMock.mockResolvedValue(
      journeyRow({
        judgeConfig: {
          goalCompletion: {
            judgeModel: "openai/gpt-4o",
            judgeSelection: {
              source: "legacy",
              modelId: "openai/gpt-4o",
              provider: "openai",
            },
            judgeSelectionOrigin: "backfill",
          },
        },
      }),
    );
    mutationMock.mockResolvedValue(journeyRow());
    const moved = {
      source: "legacy",
      modelId: "openai/gpt-4o",
      provider: "azure",
    };
    expect(
      (
        await patch({
          judge: { modelSelection: moved, modelSelectionOrigin: "backfill" },
        })
      ).status,
    ).toBe(200);
    const written = mutationMock.mock.calls[0][1].judgeConfig.goalCompletion;
    expect(written.judgeSelection).toEqual(moved);
    expect(written).not.toHaveProperty("judgeSelectionOrigin");
  });

  it("refuses a judge that only echoes the read-only marker", async () => {
    queryMock.mockResolvedValue(journeyRow());
    expect(
      (await patch({ judge: { modelSelectionOrigin: "backfill" } })).status,
    ).toBe(400);
    expect(
      (
        await patch({
          judge: { judgeSelection: hostedSelection },
        })
      ).status,
    ).toBe(400);
    expect(mutationMock).not.toHaveBeenCalled();
  });
});
