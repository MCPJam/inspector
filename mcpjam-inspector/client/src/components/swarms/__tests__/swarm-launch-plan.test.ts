import { describe, expect, it } from "vitest";
import {
  fitLaunchPlan,
  launchPlanSessions,
  quotePlannedRuns,
  type LaunchPlan,
} from "../swarm-launch-plan";

/**
 * The create flow's launch plan: what it counts, what the quote prices, and
 * how "Run K conversations instead" shrinks it. The fitter is advisory (the
 * flow re-quotes its result before applying it), but the ORDER it gives
 * things up in is product behaviour: breadth across personas first, then
 * depth, and reused personas last.
 */

const plan = (overrides: Partial<LaunchPlan> = {}): LaunchPlan => ({
  proposed: [],
  reused: [],
  ...overrides,
});

describe("launchPlanSessions", () => {
  it("counts goals × iterations × environments, new and reused alike", () => {
    expect(
      launchPlanSessions(
        plan({
          proposed: [{ key: "a", goalKeys: ["g1", "g2"], iterations: 3 }],
          reused: [{ personaId: "p", journeyIds: ["j1"], iterations: 2 }],
        }),
        2,
      ),
    ).toBe((2 * 3 + 1 * 2) * 2);
  });

  it("counts a run with no environment selected once per goal", () => {
    expect(
      launchPlanSessions(
        plan({
          reused: [{ personaId: "p", journeyIds: ["j1"], iterations: 2 }],
        }),
        0,
      ),
    ).toBe(2);
  });
});

describe("quotePlannedRuns", () => {
  it("prices new goals as bare runs and reused goals by id, with the launch's overrides", () => {
    expect(
      quotePlannedRuns(
        plan({
          proposed: [{ key: "a", goalKeys: ["g1"], iterations: 2 }],
          reused: [{ personaId: "p", journeyIds: ["j1"], iterations: 4 }],
        }),
        { environmentIds: ["env-1", "env-2"], maxTurns: 8 },
      ),
    ).toEqual([
      {
        key: "new:a:g1",
        environmentIds: ["env-1", "env-2"],
        sessionsPerTarget: 2,
        maxTurns: 8,
        setupWrites: true,
      },
      {
        key: "reused:j1",
        journeyId: "j1",
        sessionsPerTarget: 4,
        environmentIds: ["env-1", "env-2"],
      },
    ]);
  });

  it("leaves a reused goal on its own environments when none are selected", () => {
    expect(
      quotePlannedRuns(
        plan({
          reused: [{ personaId: "p", journeyIds: ["j1"], iterations: 1 }],
        }),
        { environmentIds: [], maxTurns: 8 },
      ),
    ).toEqual([{ key: "reused:j1", journeyId: "j1", sessionsPerTarget: 1 }]);
  });

  it("prices nothing it cannot price exactly", () => {
    // A new goal with no environment has no targets to price yet.
    expect(
      quotePlannedRuns(
        plan({ proposed: [{ key: "a", goalKeys: ["g1"], iterations: 1 }] }),
        { environmentIds: [], maxTurns: 8 },
      ),
    ).toBeNull();
    expect(
      quotePlannedRuns(
        plan({ proposed: [{ key: "a", goalKeys: [], iterations: 1 }] }),
        { environmentIds: ["env-1"], maxTurns: 8 },
      ),
    ).toBeNull();
  });
});

describe("fitLaunchPlan", () => {
  it("keeps a goal from every persona before a second from any", () => {
    const fitted = fitLaunchPlan(
      plan({
        proposed: [
          { key: "a", goalKeys: ["a1", "a2", "a3"], iterations: 2 },
          { key: "b", goalKeys: ["b1", "b2", "b3"], iterations: 2 },
        ],
      }),
      { environmentCount: 1, maxSessions: 3 },
    );
    expect(fitted).toEqual({
      proposed: [
        { key: "a", goalKeys: ["a1", "a2"], iterations: 1 },
        { key: "b", goalKeys: ["b1"], iterations: 1 },
      ],
      reused: [],
    });
  });

  it("raises iterations back toward the chosen count only after breadth", () => {
    const fitted = fitLaunchPlan(
      plan({
        proposed: [
          { key: "a", goalKeys: ["a1"], iterations: 3 },
          { key: "b", goalKeys: ["b1"], iterations: 3 },
        ],
      }),
      { environmentCount: 1, maxSessions: 5 },
    );
    expect(fitted?.proposed).toEqual([
      { key: "a", goalKeys: ["a1"], iterations: 3 },
      { key: "b", goalKeys: ["b1"], iterations: 2 },
    ]);
    expect(launchPlanSessions(fitted!, 1)).toBe(5);
  });

  it("sizes by environments, since every goal runs once per environment", () => {
    const fitted = fitLaunchPlan(
      plan({
        proposed: [{ key: "a", goalKeys: ["a1", "a2", "a3"], iterations: 1 }],
      }),
      { environmentCount: 2, maxSessions: 5 },
    );
    expect(fitted?.proposed[0]?.goalKeys).toEqual(["a1", "a2"]);
    expect(launchPlanSessions(fitted!, 2)).toBe(4);
  });

  it("fits reused personas last, at the most iterations that still fit", () => {
    const fitted = fitLaunchPlan(
      plan({
        proposed: [{ key: "a", goalKeys: ["a1"], iterations: 1 }],
        reused: [
          { personaId: "p", journeyIds: ["j1", "j2"], iterations: 3 },
          { personaId: "q", journeyIds: ["j3"], iterations: 1 },
        ],
      }),
      { environmentCount: 1, maxSessions: 5 },
    );
    expect(fitted?.reused).toEqual([
      { personaId: "p", journeyIds: ["j1", "j2"], iterations: 2 },
    ]);
    expect(launchPlanSessions(fitted!, 1)).toBe(5);
  });

  it("offers nothing when not even one goal fits", () => {
    expect(
      fitLaunchPlan(
        plan({ proposed: [{ key: "a", goalKeys: ["a1"], iterations: 1 }] }),
        { environmentCount: 3, maxSessions: 2 },
      ),
    ).toBeNull();
  });
});
