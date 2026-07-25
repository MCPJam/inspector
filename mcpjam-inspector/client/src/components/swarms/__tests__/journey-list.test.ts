import { describe, expect, it } from "vitest";
import type { JourneyRun } from "@/lib/swarm-api";
import { journeyTargetColumns, journeyHostOutcome } from "../journey-list";

function run(
  partial: Partial<JourneyRun> & {
    hostSummaries: JourneyRun["hostSummaries"];
  },
): JourneyRun {
  return {
    _id: partial._id ?? "run-x",
    status: partial.status ?? "completed",
    summary: partial.summary ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
    },
    hostSummaries: partial.hostSummaries,
    snapshot: partial.snapshot,
    goalScoreSummary: partial.goalScoreSummary,
    createdAt: partial.createdAt ?? 1,
  };
}

const hs = (
  hostId: string,
  total: number,
  succeeded: number,
  failed = 0,
  rateLimited = 0,
) => ({ hostId, total, succeeded, failed, rateLimited });

describe("journeyTargetColumns", () => {
  const hosts = [
    { hostId: "a", name: "Alpha" },
    { hostId: "b", name: "Bravo" },
  ];

  it("unrun legacy journey: one column per hostId in journey order", () => {
    const journey = {
      _id: "j1",
      personaRefId: "p",
      goal: "g1",
      hostIds: ["b", "a", "z"],
      config: { sessionsPerHost: 1, maxTurns: 1 },
    };
    const cols = journeyTargetColumns(journey, hosts, null);
    expect(cols.map((c) => c.key)).toEqual(["b", "a", "z"]);
    expect(cols.map((c) => c.label)).toEqual(["Bravo", "Alpha", "z"]);
    expect(cols.every((c) => c.environmentId === undefined)).toBe(true);
  });

  it("unrun env-based journey: one column per environment in environmentIds order, labeled by env name", () => {
    const journey = {
      _id: "j1",
      personaRefId: "p",
      goal: "g1",
      hostIds: ["a"],
      environmentIds: ["env2", "env1"],
      config: { sessionsPerHost: 1, maxTurns: 1 },
    };
    const environments = [
      { environmentId: "env1", projectId: "pr", name: "Staging", hostId: "a", revision: 1 },
      { environmentId: "env2", projectId: "pr", name: "Prod", hostId: "a", revision: 3 },
    ];
    const cols = journeyTargetColumns(journey, hosts, null, environments);
    expect(cols.map((c) => c.label)).toEqual(["Prod", "Staging"]);
    expect(cols.map((c) => c.environmentId)).toEqual(["env2", "env1"]);
    expect(cols.map((c) => c.hostId)).toEqual(["a", "a"]);
  });

  it("run with two SAME-HOST env targets: distinct columns keyed by targetId, env-name labels, #n suffix on collisions", () => {
    const journey = {
      _id: "j1",
      personaRefId: "p",
      goal: "g1",
      hostIds: ["a"],
      environmentIds: ["env1", "env2"],
      config: { sessionsPerHost: 1, maxTurns: 1 },
    };
    const latestRun = run({
      hostSummaries: [
        { hostId: "a", targetId: "environment:env1", total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
        { hostId: "a", targetId: "environment:env2", total: 1, succeeded: 0, failed: 1, rateLimited: 0 },
      ],
      snapshot: {
        hosts: [
          { hostId: "a", targetId: "environment:env1", environmentRef: { environmentId: "env1", name: "Same Name", revision: 1 } },
          { hostId: "a", targetId: "environment:env2", environmentRef: { environmentId: "env2", name: "Same Name", revision: 2 } },
        ],
      },
    });
    const cols = journeyTargetColumns(journey, hosts, latestRun);
    expect(cols.map((c) => c.key)).toEqual([
      "environment:env1",
      "environment:env2",
    ]);
    expect(cols.map((c) => c.label)).toEqual(["Same Name #1", "Same Name #2"]);
    // Per-target outcomes stay distinct even though the host is shared.
    expect(journeyHostOutcome(latestRun, "environment:env1")).toBe("pass");
    expect(journeyHostOutcome(latestRun, "environment:env2")).toBe("fail");
  });

  it("fresh legacy run: host-shaped targetIds collapse to bare hostId keys (pre-3A parity)", () => {
    const journey = {
      _id: "j1",
      personaRefId: "p",
      goal: "g1",
      hostIds: ["a"],
      config: { sessionsPerHost: 1, maxTurns: 1 },
    };
    const latestRun = run({
      hostSummaries: [
        { hostId: "a", targetId: "host:a", total: 1, succeeded: 1, failed: 0, rateLimited: 0 },
      ],
      snapshot: { hosts: [{ hostId: "a", targetId: "host:a" }] },
    });
    const cols = journeyTargetColumns(journey, hosts, latestRun);
    expect(cols.map((c) => c.key)).toEqual(["a"]);
    expect(journeyHostOutcome(latestRun, "a")).toBe("pass");
  });
});

describe("journeyHostOutcome", () => {
  it("classifies pass / fail / partial for a terminal run", () => {
    const r = run({
      status: "partial",
      hostSummaries: [hs("h1", 2, 2), hs("h2", 2, 0, 2), hs("h3", 3, 1, 2)],
    });
    expect(journeyHostOutcome(r, "h1")).toBe("pass");
    expect(journeyHostOutcome(r, "h2")).toBe("fail");
    expect(journeyHostOutcome(r, "h3")).toBe("part");
  });

  it("returns none for a host absent from the run's summaries", () => {
    const r = run({ status: "completed", hostSummaries: [hs("h1", 1, 1)] });
    expect(journeyHostOutcome(r, "other")).toBe("none");
  });

  it("returns running while a running run's host has incomplete attempts", () => {
    const r = run({ status: "running", hostSummaries: [hs("h1", 3, 1)] });
    expect(journeyHostOutcome(r, "h1")).toBe("running");
    // Absent host under a running run also reads as running (not yet reported).
    expect(journeyHostOutcome(r, "h2")).toBe("running");
  });

  it("resolves a running run's host once all attempts are accounted for", () => {
    const r = run({ status: "running", hostSummaries: [hs("h1", 2, 2)] });
    expect(journeyHostOutcome(r, "h1")).toBe("pass");
  });
});
