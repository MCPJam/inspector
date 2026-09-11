import { describe, expect, it } from "vitest";

import type { SwarmOverviewRun, SwarmWaveSignals } from "@/lib/swarm-api";
import { deriveSwarmFindingsModel } from "../findings/findings-derivation";
import {
  composeFindingsSummary,
  countWords,
  deriveHonestyFootnotes,
  shortenGoalTitle,
} from "../findings/findings-headline";

/**
 * The summary is deterministic templates in a fixed branch order — broken
 * goals outrank friction outrank landed outrank an ungraded run — and every
 * branch names the goal, the persona, the stage and the feeling. A finished
 * run never opens on "No findings yet" (Emmanuel research, Sep 4). The
 * footnotes stay the card's honesty rail: every way the counts could
 * understate reality gets a chip, never a rubric row.
 */

function run(overrides: Partial<SwarmOverviewRun> = {}): SwarmOverviewRun {
  return {
    runId: "run-1",
    journeyRefId: "journey-1",
    journeyName: "Export the board",
    journeyArchived: false,
    personaName: "Maya Chen",
    createdAt: 0,
    swarmRunGroupId: "wave-1",
    status: "completed",
    summary: { total: 4, succeeded: 4, failed: 0, rateLimited: 0 },
    findings: [],
    ...overrides,
  };
}

function signals(overrides: Partial<SwarmWaveSignals> = {}): SwarmWaveSignals {
  return {
    candidates: [],
    sessionCount: 12,
    unanalyzedSessionCount: 0,
    judgeCoverage: { graded: 4, total: 4 },
    truncated: false,
    lowConfidence: false,
    terminal: true,
    ...overrides,
  };
}

function modelFor(
  runs: SwarmOverviewRun[],
  waveSignals: SwarmWaveSignals | null = signals()
) {
  return deriveSwarmFindingsModel({
    runs,
    signals: waveSignals,
    personas: [],
  });
}

/** Terminal by default — the interesting guarantees are about finished runs. */
function summaryFor(
  runs: SwarmOverviewRun[],
  waveSignals: SwarmWaveSignals | null = signals(),
  terminal: boolean | null = waveSignals ? waveSignals.terminal : null
) {
  return composeFindingsSummary(modelFor(runs, waveSignals), { terminal });
}

const failingRun = (name: string, runId: string, journeyRefId: string) =>
  run({
    runId,
    journeyRefId,
    personaName: name,
    goalScoreSummary: { gradedCount: 4, passedCount: 1, avgScore: 0.2 },
  });

describe("shortenGoalTitle", () => {
  it("leaves short titles intact and caps long ones at four words", () => {
    expect(shortenGoalTitle("Export the board")).toBe("Export the board");
    expect(
      shortenGoalTitle(
        "Execute custom code to sync external data into monday.com"
      )
    ).toBe("Execute custom code to…");
  });

  it("returns an empty string for an empty title", () => {
    expect(shortenGoalTitle("")).toBe("");
    expect(shortenGoalTitle("   ")).toBe("");
  });
});

describe("composeFindingsSummary", () => {
  it("names the goal, the stage, the persona, the spread and the feeling", () => {
    // Personas sort alphabetically, so Ada Third leads.
    const lines = summaryFor([
      failingRun("Maya Chen", "run-1", "journey-1"),
      failingRun("Jonah Okoye", "run-2", "journey-2"),
      failingRun("Ada Third", "run-3", "journey-3"),
    ]);

    expect(lines[0]).toBe(
      '"Export the board" broke at user value for Ada Third.'
    );
    // The cause prefers the rubric label over restating the stage, and every
    // line carries a full stop even when the detector sentence did not.
    expect(lines[1]).toBe("Goal completion missed in 3 graded sessions.");
    expect(lines).toContain("2 other personas also had a goal that broke.");
    expect(lines).toContain("Ada Third left stalled.");
    // The persona is never the subject of the failure verb — the goal is.
    expect(lines[0]).not.toMatch(/Ada Third (broke|failed|stalled)/);
  });

  it("names the one other persona rather than counting to one", () => {
    const lines = summaryFor([
      failingRun("Maya Chen", "run-1", "journey-1"),
      failingRun("Ada Third", "run-2", "journey-2"),
    ]);
    expect(lines).toContain("Maya Chen also had a goal that broke.");
    expect(lines.join(" ")).not.toContain("1 other personas");
    // She may still have goals that landed; only the break is established.
    expect(lines.join(" ")).not.toContain("did not land");
  });

  it("keeps a persona-scoped failure at persona level, naming no goal", () => {
    // The detector's subject is the persona, so derivation fanned the same
    // evidence to every one of her goals — it cannot name which goal broke.
    const model = deriveSwarmFindingsModel({
      runs: [
        run(),
        run({ runId: "run-2", journeyRefId: "journey-2", journeyName: "Ship" }),
      ],
      signals: signals({
        candidates: [
          {
            detector: "tool_errors",
            subjectKind: "persona",
            subjectId: "persona-1",
            subjectLabel: "Maya Chen",
            affectedSessions: 2,
            sliceTotal: 4,
            exemplarSessionIds: [],
            contrastSessionIds: [],
            severityScore: 1,
          },
        ],
      }),
      personas: [],
    });
    const lines = composeFindingsSummary(model, { terminal: true });

    expect(lines[0]).toBe("The tool response stage broke for Maya Chen.");
    expect(lines.join(" ")).not.toContain("Export the board");
  });

  it("reports friction with a measured denominator, and says nothing broke", () => {
    const lines = summaryFor([
      run({
        goalScoreSummary: { gradedCount: 4, passedCount: 3, avgScore: 0.8 },
      }),
      run({
        runId: "run-2",
        journeyRefId: "journey-2",
        goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
      }),
    ]);
    expect(lines[0]).toBe(
      "1 of 2 goals showed friction. No stage broke outright."
    );
    expect(lines).toContain("Maya Chen left uneasy.");
  });

  it("counts only measured goals in the friction denominator", () => {
    // The second goal has nothing graded at all — counting it would present
    // an ungraded goal as one that held.
    const lines = summaryFor([
      run({
        goalScoreSummary: { gradedCount: 4, passedCount: 3, avgScore: 0.8 },
      }),
      run({ runId: "run-2", journeyRefId: "journey-2" }),
    ]);
    expect(lines[0]).toBe(
      "1 of 1 goals showed friction. No stage broke outright."
    );
  });

  it("keeps persona-scoped friction at persona level, naming no goal", () => {
    // A persona-scoped warn fans to every goal she tried, so it cannot say
    // WHICH goal rubbed — the same rule the broken-goal branch follows.
    const model = deriveSwarmFindingsModel({
      runs: [
        run(),
        run({ runId: "run-2", journeyRefId: "journey-2", journeyName: "Ship" }),
      ],
      signals: signals({
        candidates: [
          {
            detector: "latency_outlier",
            subjectKind: "persona",
            subjectId: "persona-1",
            subjectLabel: "Maya Chen",
            affectedSessions: 2,
            sliceTotal: 4,
            exemplarSessionIds: [],
            contrastSessionIds: [],
            severityScore: 1,
          },
        ],
      }),
      personas: [],
    });
    const lines = composeFindingsSummary(model, { terminal: true });

    expect(lines[1]).toBe(
      "The tool response stage showed friction for Maya Chen."
    );
    expect(lines.join(" ")).not.toContain("Export the board");
  });

  it("celebrates only when every graded goal landed", () => {
    const lines = summaryFor([
      run({ goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 } }),
    ]);
    expect(lines[0]).toBe("Every graded goal landed.");
    expect(lines).toContain("1 goal across 1 persona, and no stage broke.");
    expect(lines).toContain("Maya Chen left relieved.");
  });

  it("never opens a FINISHED run on 'No findings yet'", () => {
    const ungraded = [
      run({
        status: "running",
        summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 },
      }),
    ];
    const lines = composeFindingsSummary(modelFor(ungraded, null), {
      terminal: true,
    });

    expect(lines[0]).toBe("This run finished with nothing graded.");
    expect(lines.join(" ")).not.toContain("No findings yet");
    // Absent is unknown: an ungraded run is never evidence that anything held.
    expect(lines).toContain(
      "No goal was scored, so nothing here is evidence that the experience held."
    );
  });

  it("says a still-running run is still running", () => {
    const lines = composeFindingsSummary(
      modelFor(
        [
          run({
            status: "running",
            summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 },
          }),
        ],
        null
      ),
      { terminal: false }
    );
    expect(lines[0]).toBe("Nothing graded yet.");
    expect(lines.join(" ")).toContain("still going");
  });

  it("claims neither ending when a legacy wave carries no signals", () => {
    const lines = summaryFor(
      [
        run({
          status: "running",
          summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 },
        }),
      ],
      null
    );
    expect(lines[0]).toBe("Nothing has been graded for this run.");
    expect(lines.join(" ")).not.toContain("still going");
    expect(lines.join(" ")).not.toContain("finished");
  });

  it("stays a few short lines, never a paragraph", () => {
    const lines = summaryFor([
      failingRun("Maya Chen", "run-1", "journey-1"),
      failingRun("Ada Third", "run-2", "journey-2"),
    ]);
    expect(lines.length).toBeLessThanOrEqual(4);
    for (const line of lines) {
      expect(countWords(line)).toBeLessThanOrEqual(17);
    }
  });
});

describe("deriveHonestyFootnotes", () => {
  it("marks a legacy wave (no signals or no durable group id) as rubric-only", () => {
    expect(
      deriveHonestyFootnotes({ signals: null, hasGroupId: false })
    ).toEqual([
      "Rubric findings only — deterministic signals unavailable for this wave",
    ]);
    expect(
      deriveHonestyFootnotes({ signals: signals(), hasGroupId: false })[0]
    ).toContain("Rubric findings only");
  });

  it("flags truncation, low confidence, and a live wave", () => {
    const notes = deriveHonestyFootnotes({
      signals: signals({
        truncated: true,
        lowConfidence: true,
        terminal: false,
      }),
      hasGroupId: true,
    });
    expect(notes).toContain("Session scan hit its cap — counts cover a subset");
    expect(notes).toContain(
      "Most sessions are unanalyzed — treat counts as partial"
    );
    expect(notes).toContain(
      "This swarm is still running — findings may change"
    );

    const partialJudge = deriveHonestyFootnotes({
      signals: signals({ judgeCoverage: { graded: 3, total: 8 } }),
      hasGroupId: true,
    });
    expect(partialJudge).toEqual([]);
  });

  it("stays silent on a clean, fully graded, terminal wave", () => {
    expect(
      deriveHonestyFootnotes({ signals: signals(), hasGroupId: true })
    ).toEqual([]);
  });
});
