/**
 * The swarm's half of a launch, through the real engine: planning, ordering,
 * funding, what each goal's run is launched with, and the replies in swarm
 * names. The engine's own rules are tested once, in `run-group-launch/`.
 */
import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import {
  isSwarmLaunchRefusal,
  launchSwarmRun,
  planSwarmRun,
  resumeSwarmRun,
  type SwarmLaunchResult,
} from "../launch-swarm-run.js";
import {
  NOW,
  REQUEST_BEARER,
  RUN_BEARER,
  UNSUPPORTED,
  createSwarmFakes,
  planOf,
  previewOf,
  recordOf,
  refusals,
  type SwarmFakeOptions,
} from "./swarm-fakes.js";

const GOALS = ["g1", "g2", "g3"];

const input = (request: Record<string, unknown> = {}) => ({
  projectId: "project-1",
  request: { swarmRun: "sr_source", idempotencyKey: "key-1", ...request },
});

async function launch(options: SwarmFakeOptions = {}, request = {}) {
  const fakes = createSwarmFakes(options);
  const result = await launchSwarmRun(input(request), fakes.deps, fakes.ports);
  await fakes.settle();
  return { fakes, result };
}

function refusalOf(result: SwarmLaunchResult) {
  if (!isSwarmLaunchRefusal(result)) throw new Error("expected a refusal");
  return result;
}

const params = (goalId: string, extra = {}) => ({
  kind: "swarm",
  goalId,
  ...extra,
});

describe("a swarm launch", () => {
  it("plans with the request bearer, prices the goals in plan order and begins one item per goal", async () => {
    const { fakes, result } = await launch(
      { preview: previewOf([0, 0, 0]) },
      { iterations: 3, environmentIds: ["env-1"] },
    );
    expect(fakes.callsTo("plan")[0]).toMatchObject({
      bearer: REQUEST_BEARER,
      args: {
        projectId: "project-1",
        source: { kind: "swarmRun", swarmRunId: "sr_source" },
        sessionsPerTarget: 3,
        environmentIds: ["env-1"],
      },
    });
    expect(fakes.callsTo("preview")[0]?.args).toEqual({
      projectId: "project-1",
      runs: GOALS.map((journeyRefId) => ({
        journeyRefId,
        kind: "swarm",
        environmentIds: ["env-1"],
        sessionsPerTarget: 3,
      })),
    });
    const overrides = { sessionsPerTarget: 3, environmentIds: ["env-1"] };
    expect(fakes.callsTo("begin")[0]?.args).toEqual({
      kind: "swarm",
      projectId: "project-1",
      swarmId: "swarm-1",
      sourceRunGroupId: "sr_source",
      idempotencyKey: "key-1",
      request: {
        source: { kind: "swarmRun", swarmRunId: "sr_source" },
        ...overrides,
      },
      items: GOALS.map((goalId) => ({
        itemKey: goalId,
        params: params(goalId, overrides),
      })),
    });
    expect(result).toMatchObject({
      status: 202,
      body: {
        swarmRunId: "sr_new",
        launch: {
          swarmRunId: "sr_new",
          swarmId: "swarm-1",
          sourceSwarmRunId: "sr_source",
          goals: [
            {
              goalId: "g1",
              launchKey: "swarm-launch:g1",
              status: "started",
              runId: "run-g1",
              ...overrides,
            },
            { goalId: "g2", status: "pending" },
            { goalId: "g3", status: "pending" },
          ],
        },
        plan: {
          sessionTotal: 6,
          goals: [{ goalId: "g1", name: "Goal g1", sessionCount: 2 }, {}, {}],
        },
        funding: { supported: true, sponsored: 0, credits: 6 },
      },
    });
  });

  it("launches each goal as a run of the swarm run, admitted once, with the local-harness inputs from the request", async () => {
    const fakes = createSwarmFakes();
    const localHarness = { eligibleHarnessIds: ["claude-code" as const] };
    vi.mocked(fakes.ports.resolveLocalHarness).mockResolvedValue(localHarness);
    await launchSwarmRun(input({ iterations: 2 }), fakes.deps, fakes.ports);
    await fakes.settle();
    expect(fakes.ports.resolveLocalHarness).toHaveBeenCalledWith(
      REQUEST_BEARER,
      "project-1",
    );
    expect(fakes.inputs()[1]).toEqual({
      projectId: "project-1",
      journeyRefId: "g2",
      launchKey: "swarm-launch:g2",
      waveId: "sr_new",
      sessionsPerTarget: 2,
    });
    const calls = vi.mocked(fakes.ports.launchGoal).mock.calls;
    expect(calls.map(([deps]) => deps.bearerToken)).toEqual([
      REQUEST_BEARER,
      RUN_BEARER,
      RUN_BEARER,
    ]);
    for (const [deps] of calls) {
      expect(deps).toMatchObject({
        admitted: true,
        localHarness,
        getRunBearer: fakes.deps.getRunBearer,
        xaaIssuer: "https://issuer.test/api/web/xaa",
      });
    }
  });

  it("stops on a 401 mid-launch as AUTH_EXPIRED", async () => {
    const { fakes } = await launch({ outcomes: { g2: [refusals.expired()] } });
    expect(fakes.lastFinish()).toMatchObject({
      state: "stopped",
      stopReason: { status: 401, code: "AUTH_EXPIRED" },
    });
  });

  it("answers a launch-wide refusal of the first goal as the call's error, in swarm names", async () => {
    const { fakes, result } = await launch({
      outcomes: { g1: [refusals.dailyRunLimit()] },
    });
    expect(refusalOf(result)).toMatchObject({
      status: 429,
      headers: { "Retry-After": "40000" },
      body: {
        error: {
          code: "RATE_LIMITED",
          message: "Your plan's daily swarm runs are used up.",
          details: { code: "billing_limit_reached" },
        },
        launch: {
          swarmRunId: "sr_new",
          state: "stopped",
          goals: [{ goalId: "g1", status: "not_started" }, {}, {}],
        },
      },
    });
    expect(fakes.lastFinish()).toMatchObject({
      retryAfterAt: NOW + 40_000_000,
    });
  });
});

describe("refusals before anything is written", () => {
  it("refuses a request out of bounds without asking the backend", async () => {
    const { fakes, result } = await launch({}, { swarm: "swarm-1" });
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: {
        error: {
          code: "VALIDATION_ERROR",
          message: "Send swarmRun or swarm, not both.",
        },
      },
    });
    expect(fakes.calls).toEqual([]);
  });

  it("refuses a plan with problems, with the per-goal list", async () => {
    const plan = planOf(["g1", "g2"]);
    plan.problems = [
      {
        goalId: "g2",
        code: "archived",
        message: "Goal g2 was archived. Restore it, or launch without it.",
      },
      {
        goalId: "g1",
        code: "model_policy",
        message: "Goal g1 uses a model this organization blocks.",
      },
    ];
    const { fakes, result } = await launch({ plan });
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: {
        error: {
          message:
            "Goal g2 was archived. Restore it, or launch without it. 1 more problem blocks this launch.",
          details: { problems: plan.problems },
        },
      },
    });
    expect(fakes.callsTo("begin")).toEqual([]);
  });

  it("answers a swarm run the project does not have as 404", async () => {
    const { result } = await launch({
      plan: new ConvexError({
        code: "not_found",
        message: "No swarm run sr_x in this project.",
      }),
    });
    expect(refusalOf(result)).toMatchObject({
      status: 404,
      body: {
        error: {
          code: "NOT_FOUND",
          message: "No swarm run sr_x in this project.",
        },
      },
    });
  });
});

describe("funding", () => {
  it("refuses 409 swarm_funding_changed when fewer conversations are sponsored than expected", async () => {
    const { fakes, result } = await launch(
      { preview: previewOf([1, 1, 0]) },
      { expectedSponsored: 3 },
    );
    expect(refusalOf(result)).toMatchObject({
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          details: {
            code: "swarm_funding_changed",
            expectedSponsored: 3,
            actualSponsored: 2,
            totalConversations: 6,
          },
        },
      },
    });
    expect(fakes.callsTo("begin")).toEqual([]);
  });

  it.each([
    ["the preview fails", new Error("preview down")],
    ["sponsorship no longer applies", UNSUPPORTED],
    ["the preview answers for other runs", previewOf([1])],
  ])(
    "refuses an expected split it cannot check when %s",
    async (_n, preview) => {
      const { fakes, result } = await launch(
        { preview },
        { expectedSponsored: 1 },
      );
      expect(refusalOf(result)).toMatchObject({
        status: 409,
        body: {
          error: {
            details: { code: "swarm_funding_changed", expectedSponsored: 1 },
          },
        },
      });
      expect(fakes.callsTo("begin")).toEqual([]);
    },
  );

  it("holds each run to its previewed count when the caller expected a split, more sponsored being fine", async () => {
    const { fakes } = await launch(
      { preview: previewOf([1, 1, 0]) },
      { expectedSponsored: 1 },
    );
    const items = fakes.callsTo("begin")[0]?.args.items as Array<{
      params: { expectedSponsored?: number };
    }>;
    expect(items.map((item) => item.params.expectedSponsored)).toEqual([
      1, 1, 0,
    ]);
    expect(fakes.inputs().map((i) => i.expectedSponsored)).toEqual([1, 1, 0]);
  });

  it("holds a caller that expected nothing to no counts, so its runs cannot stop another launch", async () => {
    const { fakes } = await launch({ preview: previewOf([1, 0, 0]) });
    expect(fakes.inputs().every((i) => !("expectedSponsored" in i))).toBe(true);
  });

  it("starts goals one at a time when any conversation is sponsored, four otherwise", async () => {
    const ids = ["g1", "g2", "g3", "g4", "g5", "g6"];
    for (const [preview, parallel] of [
      [previewOf([0, 0, 0, 0, 0, 1]), 1],
      [previewOf([0, 0, 0, 0, 0, 0]), 4],
    ] as const) {
      const fakes = createSwarmFakes({ plan: planOf(ids), preview });
      ids.slice(1).forEach((id) => fakes.launcher.hold(id));
      await launchSwarmRun(input(), fakes.deps, fakes.ports);
      await vi.waitFor(() =>
        expect(fakes.launcher.launches).toHaveLength(1 + parallel),
      );
      for (const id of ids.slice(1)) {
        fakes.launcher.release(id);
        await vi.waitFor(() => expect(fakes.recorded("started")).toContain(id));
      }
      await fakes.settle();
      expect(fakes.launcher.maxInFlight()).toBe(parallel);
      expect(fakes.launcher.keys()).toEqual(ids);
    }
  });

  it("launches unpriced, with no funding in the reply, when the preview fails and nothing was expected", async () => {
    const { fakes, result } = await launch({
      preview: new Error("preview down"),
    });
    expect(result.status).toBe(202);
    expect(result.body).not.toHaveProperty("funding");
    expect(fakes.launcher.keys()).toEqual(GOALS);
  });
});

describe("replays and resuming", () => {
  const items = GOALS.map((goalId) => ({
    itemKey: goalId,
    params: { kind: "swarm" as const, goalId, expectedSponsored: 1 },
  }));
  const stopped = recordOf(items, { state: "stopped" });
  stopped.items = stopped.items.map((item, index) =>
    index === 0
      ? { ...item, status: "started" as const, runId: "run-g1" }
      : { ...item, status: "not_started" as const },
  );
  const reclaimed = {
    record: {
      ...stopped,
      state: "launching" as const,
      items: stopped.items.map((item) =>
        item.status === "not_started"
          ? { ...item, status: "pending" as const }
          : item,
      ),
    },
    claimed: true,
    generation: 2,
  };

  it("replays a key from its record, without planning or pricing it again", async () => {
    const { fakes, result } = await launch({
      backend: {
        recorded: stopped,
        begin: () => ({ ...reclaimed, replayed: true }),
      },
    });
    expect(fakes.callsTo("plan")).toEqual([]);
    expect(fakes.callsTo("preview")).toEqual([]);
    expect(fakes.callsTo("begin")[0]?.args).toMatchObject({ items });
    expect(
      fakes
        .inputs()
        .map((i) => [i.journeyRefId, i.launchKey, i.expectedSponsored]),
    ).toEqual([
      ["g2", "swarm-launch:g2", 1],
      ["g3", "swarm-launch:g3", 1],
    ]);
    expect(fakes.launcher.maxInFlight()).toBe(1);
    expect(result.status).toBe(202);
    expect(result.body).not.toHaveProperty("plan");
  });

  it("resumes the caller's own launch by its swarm run id", async () => {
    const fakes = createSwarmFakes({ backend: { resume: () => reclaimed } });
    const result = await resumeSwarmRun(
      { projectId: "project-1", swarmRunId: "sr_new" },
      fakes.deps,
      fakes.ports,
    );
    await fakes.settle();
    expect(fakes.callsTo("resume")[0]?.args).toEqual({
      kind: "swarm",
      projectId: "project-1",
      runGroupId: "sr_new",
    });
    expect(fakes.launcher.keys()).toEqual(["g2", "g3"]);
    expect(result).toMatchObject({
      status: 202,
      body: {
        swarmRunId: "sr_new",
        launch: {
          goals: [
            { goalId: "g1", status: "started" },
            { goalId: "g2", status: "started" },
            { goalId: "g3" },
          ],
        },
      },
    });
    expect(fakes.ports.resolveLocalHarness).toHaveBeenCalledWith(
      REQUEST_BEARER,
      "project-1",
    );
  });
});

describe("planSwarmRun", () => {
  it("answers the plan and the funding preview and writes nothing", async () => {
    const plan = planOf(GOALS);
    plan.problems = [
      { goalId: "g3", code: "archived", message: "Goal g3 was archived." },
    ];
    const fakes = createSwarmFakes({ plan, preview: previewOf([1, 0, 0]) });
    const result = await planSwarmRun(input(), fakes.deps, fakes.ports);
    expect(result).toEqual({
      status: 200,
      body: {
        dryRun: true,
        plan,
        funding: { supported: true, sponsored: 1, credits: 5 },
      },
    });
    expect(fakes.calls.map((c) => c.fn)).toEqual(["plan", "preview"]);
  });
});
