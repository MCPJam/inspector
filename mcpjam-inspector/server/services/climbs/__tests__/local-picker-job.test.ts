/**
 * MCPJam's steps on a person's machine: the job starts for a climb once, takes
 * the due step, runs it under the lease, reports it, and ends when the climb
 * stops, pauses or is done; the drain waits for the running step and pauses a
 * climb whose step it cannot run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLIMB, fakeConvex } from "./helpers.js";
import { climbRow } from "./climb-fixtures.js";

const hoisted = vi.hoisted(() => ({ convex: null as unknown, step: vi.fn() }));
vi.mock("../../../routes/v1/convex-client.js", () => ({ createConvexClient: () => hoisted.convex }));
vi.mock("../picker-step.js", () => ({ runPickerStep: hoisted.step }));

import { createDrainCoordinator } from "../../lifecycle/drain.js";
import { startLocalPickerJob, stepRunnerFor, stopLocalPickerJobs } from "../local-picker-job.js";

const started = { started: true, climbId: CLIMB, generation: 6, attempt: 1, maxAttempts: 3, heartbeatIntervalMs: 20_000, projectId: "proj1", pickerModel: "m/x", resumeRound: null };
const local = (over: Record<string, unknown> = {}) => climbRow({ picker: "mcpjam", stepRunner: "local", ...over });
const due = { status: "due", dueAt: 1, attempts: 0, emptyTurns: 0 };

/** The climb as each read finds it, in order; the last one stays. */
function script(states: Array<Record<string, unknown>>) {
  let reads = 0;
  const fake = fakeConvex({
    "climbs:getClimb": () => states[Math.min(reads++, states.length - 1)],
    "climbSteps:markClimbStepStarted": (args) => (args.generation === undefined ? started : { started: false, leaseOk: true, stop: false }),
    "climbSteps:markClimbStepFinished": () => ({ next: "none" }),
    "climbPickerSpend:markClimbStepSpend": () => ({}),
  });
  hoisted.convex = fake.convex;
  return fake;
}

const job = (deps: Parameters<typeof startLocalPickerJob>[1] = {}) =>
  startLocalPickerJob({ projectId: "proj1", climbId: CLIMB, getBearer: async () => "bearer" }, { pollMs: 1, ...deps });

beforeEach(() => {
  hoisted.step.mockReset();
});
afterEach(async () => {
  await stopLocalPickerJobs();
});

describe("where a climb's steps run", () => {
  it("is hosted on the hosted app and local on a person's machine, by the server", () => {
    expect(stepRunnerFor(true)).toBe("hosted");
    expect(stepRunnerFor(false)).toBe("local");
  });
});

describe("the local job", () => {
  it("takes the due step, runs it and reports the round it submitted", async () => {
    const { called } = script([local({ state: "ready", step: due }), local({ state: "running" }), local({ state: "stopped" })]);
    hoisted.step.mockResolvedValue({ kind: "done", submittedRound: 2 });
    expect(job()).toBe(true);
    await vi.waitFor(() => expect(called("climbSteps:markClimbStepFinished")).toHaveLength(1));
    expect(called("climbSteps:markClimbStepStarted")[0]).toEqual({ climbId: CLIMB });
    expect(called("climbSteps:markClimbStepFinished")).toEqual([{ climbId: CLIMB, generation: 6, submittedRound: 2 }]);
    expect(hoisted.step.mock.calls[0]![0]).toMatchObject({ climbId: CLIMB, generation: 6, pickerModel: "m/x", projectId: "proj1" });
  });

  it("reports a turn that submitted nothing with no round, which the backend retries once", async () => {
    const { called } = script([local({ step: due }), local({ state: "stopped" })]);
    hoisted.step.mockResolvedValue({ kind: "done" });
    job();
    await vi.waitFor(() => expect(called("climbSteps:markClimbStepFinished")).toEqual([{ climbId: CLIMB, generation: 6 }]));
  });

  it("renews the lease and reports the spend through the starter's own mutations", async () => {
    const { called } = script([local({ step: due }), local({ state: "stopped" })]);
    hoisted.step.mockImplementation(async (_claim, lease) => {
      expect(await lease.renew()).toEqual({ leaseOk: true, stop: false });
      await lease.spend({ estimatedCostUsd: 0.03, tokens: 900 });
      return { kind: "done", submittedRound: 1 };
    });
    job();
    await vi.waitFor(() => expect(called("climbSteps:markClimbStepFinished")).toHaveLength(1));
    expect(called("climbSteps:markClimbStepStarted")[1]).toEqual({ climbId: CLIMB, generation: 6 });
    expect(called("climbPickerSpend:markClimbStepSpend")).toEqual([{ climbId: CLIMB, generation: 6, estimatedCostUsd: 0.03, tokens: 900 }]);
  });

  it("writes nothing when the lease was lost or the climb stopped under the step", async () => {
    const { called } = script([local({ step: due }), local({ state: "stopped" })]);
    hoisted.step.mockResolvedValue({ kind: "lost" });
    job();
    await vi.waitFor(() => expect(hoisted.step).toHaveBeenCalled());
    await stopLocalPickerJobs();
    expect(called("climbSteps:markClimbStepFinished")).toEqual([]);
  });

  it("says the step stopped when it fails, so the climb pauses and a person decides", async () => {
    const { called } = script([local({ step: due })]);
    hoisted.step.mockRejectedValue(new Error("model refused"));
    job();
    await vi.waitFor(() => expect(called("climbSteps:markClimbStepFinished")).toEqual([{ climbId: CLIMB, generation: 6, interrupted: true }]));
  });

  it("starts once per climb, and again after it ends", async () => {
    script([local({ state: "stopped" })]);
    expect(job()).toBe(true);
    expect(job()).toBe(false);
    await stopLocalPickerJobs();
    expect(job()).toBe(true);
  });

  it.each([
    ["a paused climb", local({ state: "ready", paused: { at: 1, code: "inspector_stopped", reason: "r" } })],
    ["a stopped climb", local({ state: "stopped" })],
    ["a climb another picker runs", climbRow({ picker: "agent" })],
    ["a climb whose steps run on a worker", local({ stepRunner: "hosted", step: due })],
  ])("takes no step of %s", async (_label, row) => {
    const { called } = script([row]);
    job();
    await stopLocalPickerJobs();
    await vi.waitFor(() => expect(called("climbs:getClimb").length).toBeGreaterThan(0));
    expect(called("climbSteps:markClimbStepStarted")).toEqual([]);
  });

  it("ends when a ready climb shows no step for long enough, rather than polling for ever", async () => {
    const { called } = script([local({ state: "ready" })]);
    job();
    await vi.waitFor(() => expect(called("climbs:getClimb").length).toBeGreaterThan(24));
    await vi.waitFor(() => expect(job()).toBe(true));
  });
});

describe("the drain", () => {
  it("waits for the running step, not for the job's idle polling", async () => {
    script([local({ step: due }), local({ state: "stopped" })]);
    const drain = createDrainCoordinator();
    const track = vi.spyOn(drain, "track");
    let finish!: () => void;
    hoisted.step.mockImplementation(() => new Promise((resolve) => (finish = () => resolve({ kind: "done", submittedRound: 1 }))));
    job({ drain });
    await vi.waitFor(() => expect(track).toHaveBeenCalledWith("claimed_job", expect.any(Promise)));
    expect(drain.counts()).toEqual({ claimed_job: 1 });
    finish();
    await vi.waitFor(() => expect(drain.counts()).toEqual({}));
  });

  it("takes a due step it will not run and reports it interrupted, which pauses the climb until continue_climb", async () => {
    const { called } = script([local({ step: due })]);
    const drain = createDrainCoordinator();
    drain.begin();
    job({ drain });
    await vi.waitFor(() => expect(called("climbSteps:markClimbStepFinished")).toEqual([{ climbId: CLIMB, generation: 6, interrupted: true }]));
    expect(hoisted.step).not.toHaveBeenCalled();
  });

  it("leaves a climb with no step due alone while the process drains", async () => {
    const { called } = script([local({ state: "running" })]);
    const drain = createDrainCoordinator();
    drain.begin();
    job({ drain });
    await vi.waitFor(() => expect(called("climbs:getClimb")).toHaveLength(1));
    expect(called("climbSteps:markClimbStepStarted")).toEqual([]);
  });
});
