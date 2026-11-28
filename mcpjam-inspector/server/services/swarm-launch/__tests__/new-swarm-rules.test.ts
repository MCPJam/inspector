/**
 * New Swarm's launch rules, re-expressed against the launch module from the
 * create flow's own tests (`SwarmsTab.createFlow.test.tsx`, "sponsored
 * conversations in the launch", and `swarm-funding-plan.test.ts`): the order,
 * the concurrency, the funding check and the stop conditions. New Swarm
 * launches through this module next; these cases keep its rules when it does.
 */
import { describe, expect, it, vi } from "vitest";
import { isSwarmLaunchRefusal, launchSwarmRun } from "../launch-swarm-run.js";
import {
  createSwarmFakes,
  planOf,
  previewOf,
  refusals,
  type SwarmFakeOptions,
} from "./swarm-fakes.js";

/** New Swarm's request: its goals, the swarm they launch for, the split it showed. */
function newSwarmRequest(
  goalIds: string[],
  extra: Record<string, unknown> = {},
) {
  return {
    projectId: "project-1",
    request: {
      swarm: "swarm-1",
      goals: goalIds.map((goalId) => ({ goalId })),
      idempotencyKey: "flow-1:launch",
      ...extra,
    },
  };
}

async function launchNewSwarm(
  goalIds: string[],
  options: SwarmFakeOptions,
  extra: Record<string, unknown> = {},
) {
  const fakes = createSwarmFakes({ plan: planOf(goalIds), ...options });
  const result = await launchSwarmRun(
    newSwarmRequest(goalIds, extra),
    fakes.deps,
    fakes.ports,
  );
  await fakes.settle();
  return { fakes, result, finish: fakes.lastFinish() };
}

describe("New Swarm's launch rules", () => {
  it("asks the preview about exactly the runs it launches, in order, as swarm runs", async () => {
    const goals = ["j-1", "j-2"];
    const fakes = createSwarmFakes({ plan: planOf(goals) });
    await launchSwarmRun(
      {
        projectId: "project-1",
        request: {
          swarm: "swarm-1",
          goals: [
            { goalId: "j-1", iterations: 2, environmentIds: ["env-1"] },
            { goalId: "j-2" },
          ],
          idempotencyKey: "flow-1:launch",
        },
      },
      fakes.deps,
      fakes.ports,
    );
    await fakes.settle();
    expect(fakes.callsTo("preview")[0]?.args).toEqual({
      projectId: "project-1",
      runs: [
        {
          journeyRefId: "j-1",
          kind: "swarm",
          environmentIds: ["env-1"],
          sessionsPerTarget: 2,
        },
        { journeyRefId: "j-2", kind: "swarm" },
      ],
    });
    expect(fakes.inputs()[0]).toMatchObject({
      journeyRefId: "j-1",
      sessionsPerTarget: 2,
      environmentIds: ["env-1"],
    });
  });

  it("launches each run with the sponsored count it was shown, one at a time", async () => {
    const fakes = createSwarmFakes({
      plan: planOf(["j-1", "j-2"]),
      preview: previewOf([1, 0]),
    });
    fakes.launcher.hold("j-2");
    await launchSwarmRun(
      newSwarmRequest(["j-1", "j-2"], { expectedSponsored: 1 }),
      fakes.deps,
      fakes.ports,
    );
    await vi.waitFor(() => expect(fakes.launcher.launches).toHaveLength(2));
    fakes.launcher.release("j-2");
    await fakes.settle();
    expect(
      fakes.inputs().map((i) => [i.journeyRefId, i.expectedSponsored]),
    ).toEqual([
      ["j-1", 1],
      ["j-2", 0],
    ]);
    expect(fakes.launcher.maxInFlight()).toBe(1);
  });

  it("launches four at a time, with no expected counts, when sponsorship does not apply", async () => {
    const goals = ["j-1", "j-2", "j-3", "j-4", "j-5", "j-6"];
    const fakes = createSwarmFakes({ plan: planOf(goals) });
    goals.slice(1).forEach((id) => fakes.launcher.hold(id));
    await launchSwarmRun(newSwarmRequest(goals), fakes.deps, fakes.ports);
    await vi.waitFor(() => expect(fakes.launcher.launches).toHaveLength(5));
    goals.slice(1).forEach((id) => fakes.launcher.release(id));
    await fakes.settle();
    expect(fakes.launcher.maxInFlight()).toBe(4);
    expect(fakes.inputs().every((i) => !("expectedSponsored" in i))).toBe(true);
  });

  it("stops before launching when the split moved since it was shown", async () => {
    const { fakes, result } = await launchNewSwarm(
      ["j-1"],
      { preview: previewOf([0]) },
      { expectedSponsored: 1 },
    );
    expect(result.status).toBe(409);
    expect(fakes.launcher.launches).toEqual([]);
    expect(fakes.callsTo("begin")).toEqual([]);
  });

  it.each([
    ["the final split check fails", new Error("network down")],
    [
      "the final check says sponsorship no longer applies",
      { supported: false, remaining: 0, granted: 0, runs: [] },
    ],
  ])(
    "does not launch unchecked when %s after a sponsored split was shown",
    async (_name, preview) => {
      const { fakes, result } = await launchNewSwarm(
        ["j-1"],
        { preview },
        { expectedSponsored: 1 },
      );
      expect(result.status).toBe(409);
      expect(fakes.launcher.launches).toEqual([]);
    },
  );

  it("launches in one click when more conversations are sponsored than were shown", async () => {
    const { fakes, result } = await launchNewSwarm(
      ["j-1"],
      { preview: previewOf([1]) },
      { expectedSponsored: 0 },
    );
    expect(result.status).toBe(202);
    expect(fakes.inputs()[0]?.expectedSponsored).toBe(1);
  });

  it("on a 409 for the first run, launches nothing more and says nothing was launched", async () => {
    const { fakes, result, finish } = await launchNewSwarm(
      ["j-1", "j-2"],
      {
        preview: previewOf([1, 1]),
        outcomes: { "j-1": [refusals.fundingChanged()] },
      },
      { expectedSponsored: 2 },
    );
    if (!isSwarmLaunchRefusal(result)) throw new Error("expected a refusal");
    expect(result.status).toBe(409);
    expect(result.body.error.details).toMatchObject({
      code: "swarm_funding_changed",
    });
    // Not retried into a paid path: one attempt, no second.
    expect(fakes.launcher.keys()).toEqual(["j-1"]);
    expect(finish).toMatchObject({ state: "stopped" });
  });

  it("on a 409 after some runs launched, keeps them and stops the rest", async () => {
    const { fakes, result, finish } = await launchNewSwarm(
      ["j-1", "j-2", "j-3"],
      {
        preview: previewOf([1, 1, 1]),
        outcomes: { "j-2": [refusals.fundingChanged()] },
      },
      { expectedSponsored: 3 },
    );
    expect(result.status).toBe(202);
    expect(fakes.launcher.keys()).toEqual(["j-1", "j-2"]);
    expect(fakes.recorded("started")).toEqual(["j-1"]);
    expect(finish).toMatchObject({
      state: "stopped",
      stopReason: { code: "swarm_funding_changed" },
    });
  });

  it("a 409 does not hide the failure of an earlier run in the same pass", async () => {
    const { result } = await launchNewSwarm(
      ["j-1", "j-2"],
      {
        preview: previewOf([1, 1]),
        outcomes: {
          "j-1": [refusals.invalid()],
          "j-2": [refusals.fundingChanged()],
        },
      },
      { expectedSponsored: 2 },
    );
    if (!isSwarmLaunchRefusal(result)) throw new Error("expected a refusal");
    expect(result.status).toBe(409);
    expect(result.body.launch?.goals[0]).toMatchObject({
      goalId: "j-1",
      status: "failed",
      error: { message: "This journey has no pinned hosts to run" },
    });
  });

  it("names the credit limit as the reason it stopped, not whatever failed first", async () => {
    const { finish } = await launchNewSwarm(["j-1", "j-2", "j-3"], {
      preview: previewOf([1, 1, 1]),
      outcomes: {
        "j-2": [refusals.invalid()],
        "j-3": [refusals.billing()],
      },
    });
    expect(finish).toMatchObject({
      state: "stopped",
      stopReason: { status: 402 },
    });
  });

  it("stops at a model limit, which every later run would meet too", async () => {
    const { fakes, finish } = await launchNewSwarm(["j-1", "j-2", "j-3"], {
      preview: previewOf([1, 1, 1]),
      outcomes: { "j-2": [refusals.usageLimit()] },
    });
    expect(fakes.launcher.keys()).toEqual(["j-1", "j-2"]);
    expect(finish).toMatchObject({ state: "stopped" });
  });

  it("answers a credit limit on the first run as the call's error, with nothing launched", async () => {
    const { fakes, result } = await launchNewSwarm(["j-1", "j-2"], {
      outcomes: { "j-1": [refusals.billing()] },
    });
    expect(result.status).toBe(402);
    expect(fakes.launcher.keys()).toEqual(["j-1"]);
  });
});
