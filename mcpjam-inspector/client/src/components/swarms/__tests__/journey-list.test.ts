import { describe, expect, it } from "vitest";
import type { JourneyRun } from "@/lib/swarm-api";
import { journeyHostColumns, journeyHostOutcome } from "../journey-list";

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

describe("journeyHostColumns", () => {
  it("unions target hosts, orders by the project host list, appends unknowns", () => {
    const journeys = [
      { _id: "j1", personaRefId: "p", goal: "g1", hostIds: ["b", "z"], config: { sessionsPerHost: 1, maxTurns: 1 } },
      { _id: "j2", personaRefId: "p", goal: "g2", hostIds: ["a", "b"], config: { sessionsPerHost: 1, maxTurns: 1 } },
    ];
    const hosts = [
      { hostId: "a", name: "Alpha" },
      { hostId: "b", name: "Bravo" },
    ];
    const cols = journeyHostColumns(journeys, hosts);
    // a, b come first (project order); z is unknown → appended, name falls back.
    expect(cols.map((c) => c.hostId)).toEqual(["a", "b", "z"]);
    expect(cols.map((c) => c.name)).toEqual(["Alpha", "Bravo", "z"]);
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
