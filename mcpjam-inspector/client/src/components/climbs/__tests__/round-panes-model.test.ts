import { describe, expect, it } from "vitest";
import type { RunGroup } from "../climb-queries";
import { caseTitlesOf, iterationOf, planPanes, runIn } from "../round-panes-model";
import { makeClimb, makeRound } from "./fixtures";

const group = (unitKey: string, role: string, runs: string[]): RunGroup => ({
  unitKey,
  role,
  runGroupId: `${unitKey}:${role}`,
  environmentIds: ["env_a"],
  launchedRunIds: runs,
});

const groups = [
  group("baseline:1", "baseline_a", ["b1"]),
  group("baseline:1", "baseline_b", ["b2"]),
  group("round:1", "candidate", ["r1"]),
  group("round:2", "candidate", ["r2"]),
  group("round:2", "best", ["r2best"]),
  group("round:3", "candidate", ["r3"]),
];

describe("planPanes", () => {
  it("shows the baseline as the best so far before anything is kept", () => {
    const plan = planPanes(makeClimb({ rounds: [makeRound({ number: 1 })] }), 1, groups);
    expect(plan.bestIsBaseline).toBe(true);
    expect(plan.baseline?.launchedRunIds).toEqual(["b2"]);
    expect(plan.candidate?.launchedRunIds).toEqual(["r1"]);
  });
  it("uses the best measured again in this round when there is one", () => {
    const climb = makeClimb({ rounds: [makeRound({ number: 1 }), makeRound({ number: 2 })] });
    expect(planPanes(climb, 2, groups).best?.launchedRunIds).toEqual(["r2best"]);
  });
  it("otherwise uses the last kept round's candidate", () => {
    const climb = makeClimb({ rounds: [makeRound({ number: 1 }), makeRound({ number: 2, standing: "reverted" }), makeRound({ number: 3 })] });
    const plan = planPanes(climb, 3, groups);
    expect(plan.best?.launchedRunIds).toEqual(["r1"]);
    expect(plan.bestIsBaseline).toBe(false);
    expect(plan.runIds).toEqual(["b2", "r1", "r3"]);
  });
});

describe("runIn and iterationOf", () => {
  it("finds a run by the environment the run itself records", () => {
    const runs = new Map([["r1", { configSnapshot: { environmentRef: { environmentId: "env_b" } } }]]);
    const g = group("round:1", "candidate", ["r1"]);
    expect(runIn(g, "env_b", runs as never)).toBe("r1");
    expect(runIn(g, "env_a", runs as never)).toBeUndefined();
  });
  it("takes the lowest numbered iteration of the case", () => {
    const iterations = [
      { _id: "i2", testCaseId: "c1", iterationNumber: 2 },
      { _id: "i1", testCaseId: "c1", iterationNumber: 1 },
      { _id: "i3", testCaseId: "c2", iterationNumber: 1 },
    ];
    expect(iterationOf(iterations as never, "c1")?._id).toBe("i1");
    expect(iterationOf(iterations as never, "none")).toBeUndefined();
    expect(iterationOf(undefined, "c1")).toBeUndefined();
  });
});

describe("caseTitlesOf", () => {
  const iteration = (testCaseId: string | undefined, caseKey: string, title: string) =>
    ({ testCaseId, testCaseSnapshot: { caseKey, title } }) as never;

  it("finds a title by the climb's case key even when the iteration also carries the stored case's id", () => {
    const titles = caseTitlesOf([[iteration("jd7abc", "ui_lGe3hA-H8G", "Counts projects")], [iteration(undefined, "ui_other", "Lists servers")]]);
    expect(titles["ui_lGe3hA-H8G"]).toBe("Counts projects");
    expect(titles.jd7abc).toBe("Counts projects");
    expect(titles.ui_other).toBe("Lists servers");
  });

  it("names nothing for an iteration with no title", () => {
    expect(caseTitlesOf([[{ testCaseId: "x", testCaseSnapshot: { caseKey: "k" } } as never]])).toEqual({});
  });
});
