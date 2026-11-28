import { describe, expect, it } from "vitest";
import {
  goalOverridesOf,
  launchIdentityOf,
  planSourceOf,
  swarmLaunchRequestProblem,
  swarmLaunchRequestSchema,
  type SwarmLaunchRequest,
} from "../request.js";

const parse = (request: unknown) => swarmLaunchRequestSchema.safeParse(request);

describe("the launch request", () => {
  it("names what to launch in exactly one way", () => {
    expect(parse({ swarmRun: "sr_1" }).success).toBe(true);
    expect(parse({ swarm: "swarm-1" }).success).toBe(true);
    expect(parse({ goals: [{ goalId: "g1" }] }).success).toBe(true);
    expect(parse({ swarm: "swarm-1", goals: [{ goalId: "g1" }] }).success).toBe(
      true,
    );

    expect(swarmLaunchRequestProblem({})).toBe(
      "Name what to launch: swarmRun, swarm, or goals.",
    );
    expect(swarmLaunchRequestProblem({ swarmRun: "sr_1", swarm: "s" })).toBe(
      "Send swarmRun or swarm, not both.",
    );
    expect(
      swarmLaunchRequestProblem({ swarmRun: "sr_1", goals: [{ goalId: "g" }] }),
    ).toBe("Send goals or swarmRun, not both.");
  });

  it("narrows a swarm run or a swarm with goalIds, never an explicit list", () => {
    expect(parse({ swarmRun: "sr_1", goalIds: ["g1"] }).success).toBe(true);
    expect(
      swarmLaunchRequestProblem({
        goals: [{ goalId: "g1" }],
        goalIds: ["g1"],
      }),
    ).toMatch(/^goalIds narrows a swarm run or a swarm/);
  });

  it("refuses a goal listed twice", () => {
    expect(
      swarmLaunchRequestProblem({
        goals: [{ goalId: "g1" }, { goalId: "g1" }],
      }),
    ).toBe("Each goal can appear once in goals.");
  });

  it("holds the backend's bounds", () => {
    const ids = (count: number) =>
      Array.from({ length: count }, (_, i) => `id-${i}`);
    expect(parse({ swarmRun: "s", iterations: 0 }).success).toBe(false);
    expect(parse({ swarmRun: "s", iterations: 6 }).success).toBe(false);
    expect(parse({ swarmRun: "s", iterations: 1.5 }).success).toBe(false);
    expect(parse({ swarmRun: "s", environmentIds: ids(11) }).success).toBe(
      false,
    );
    expect(parse({ swarmRun: "s", environmentIds: ids(10) }).success).toBe(
      true,
    );
    expect(
      parse({ goals: ids(101).map((goalId) => ({ goalId })) }).success,
    ).toBe(false);
    expect(parse({ goals: [{ goalId: "g1", iterations: 6 }] }).success).toBe(
      false,
    );
    expect(parse({ swarmRun: "s", expectedSponsored: -1 }).success).toBe(false);
    expect(parse({ swarmRun: "s", idempotencyKey: "" }).success).toBe(false);
    expect(
      parse({ swarmRun: "s", idempotencyKey: "k".repeat(201) }).success,
    ).toBe(false);
  });

  it("is strict, and has no dryRun: planning has its own function", () => {
    expect(swarmLaunchRequestProblem({ swarmRun: "s", dryRun: true })).toMatch(
      /dryRun/,
    );
    expect(
      parse({ goals: [{ goalId: "g1", sessionsPerTarget: 2 }] }).success,
    ).toBe(false);
  });

  it("says where a field failed", () => {
    expect(swarmLaunchRequestProblem({ swarmRun: "s", iterations: 9 })).toMatch(
      /^iterations: /,
    );
  });
});

describe("the plan it maps to", () => {
  const request = (value: SwarmLaunchRequest) => value;

  it("maps each source, iterations onto sessionsPerTarget", () => {
    expect(planSourceOf(request({ swarmRun: "sr_1" }))).toEqual({
      kind: "swarmRun",
      swarmRunId: "sr_1",
    });
    expect(planSourceOf(request({ swarm: "swarm-1" }))).toEqual({
      kind: "swarm",
      swarmId: "swarm-1",
    });
    expect(
      planSourceOf(
        request({
          swarm: "swarm-1",
          goals: [
            { goalId: "g1", iterations: 3, environmentIds: ["env-1"] },
            { goalId: "g2", environmentIds: [] },
          ],
        }),
      ),
    ).toEqual({
      kind: "goals",
      swarmId: "swarm-1",
      goals: [
        { goalId: "g1", sessionsPerTarget: 3, environmentIds: ["env-1"] },
        { goalId: "g2" },
      ],
    });
  });

  it("fingerprints what is launched, not how it was asked for", () => {
    const base = request({
      swarmRun: "sr_1",
      goalIds: ["g1"],
      iterations: 2,
      environmentIds: ["env-1"],
    });
    const source = planSourceOf(base);
    if (!source) throw new Error("a swarm run is a source");
    const identity = launchIdentityOf(base, source);
    expect(identity).toEqual({
      source: { kind: "swarmRun", swarmRunId: "sr_1" },
      goalIds: ["g1"],
      sessionsPerTarget: 2,
      environmentIds: ["env-1"],
    });
    // The key and the funding expectation do not change what launches.
    expect(
      launchIdentityOf(
        { ...base, idempotencyKey: "k", expectedSponsored: 4 },
        source,
      ),
    ).toEqual(identity);
  });

  it("gives each goal its own overrides, field by field, over the launch-wide ones", () => {
    const value = request({
      goals: [
        { goalId: "g1", iterations: 4 },
        { goalId: "g2", environmentIds: ["env-own"] },
        { goalId: "g3" },
      ],
      iterations: 2,
      environmentIds: ["env-all"],
    });
    expect(goalOverridesOf(value, "g1")).toEqual({
      sessionsPerTarget: 4,
      environmentIds: ["env-all"],
    });
    expect(goalOverridesOf(value, "g2")).toEqual({
      sessionsPerTarget: 2,
      environmentIds: ["env-own"],
    });
    expect(goalOverridesOf(value, "g3")).toEqual({
      sessionsPerTarget: 2,
      environmentIds: ["env-all"],
    });
    expect(goalOverridesOf(request({ swarmRun: "sr_1" }), "g1")).toEqual({});
  });
});
