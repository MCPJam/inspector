import { neverStartedReport } from "./swarm-report-fixtures";
import { describe, expect, it } from "vitest";

import type { SwarmOverviewRun, SwarmWaveSignals } from "@/lib/swarm-api";
import { deriveSwarmFindingsModel } from "../findings/findings-derivation";
import {
  clampNarration,
  composeFindingsSummary,
  countWords,
  deriveHonestyFootnotes,
  narratedWaveSummary,
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
  waveSignals: SwarmWaveSignals | null = signals(),
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
  terminal: boolean | null = waveSignals ? waveSignals.terminal : null,
) {
  return composeFindingsSummary(modelFor(runs, waveSignals), { terminal })
    .lines;
}

/** The branch that spoke, for the cases that are about branch selection. */
function summaryKindFor(
  runs: SwarmOverviewRun[],
  waveSignals: SwarmWaveSignals | null = signals(),
  terminal: boolean | null = waveSignals ? waveSignals.terminal : null,
) {
  return composeFindingsSummary(modelFor(runs, waveSignals), { terminal }).kind;
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
        "Execute custom code to sync external data into monday.com",
      ),
    ).toBe("Execute custom code to…");
  });

  it("returns an empty string for an empty title", () => {
    expect(shortenGoalTitle("")).toBe("");
    expect(shortenGoalTitle("   ")).toBe("");
  });
});

describe("composeFindingsSummary: a wave that never launched", () => {
  const deadRun = (runId: string, journeyRefId: string) =>
    run({
      runId,
      journeyRefId,
      report: neverStartedReport(3),
      summary: { total: 3, succeeded: 0, failed: 3, rateLimited: 0 },
    });

  it("reports the launch failure instead of counting untried goals as friction", () => {
    // The prod bug: nine goals nobody ever tried were reported as nine goals
    // that "showed friction", because launch failures landed on the connection
    // stage and every aggregate read it.
    const lines = summaryFor([
      deadRun("run-1", "journey-1"),
      deadRun("run-2", "journey-2"),
    ]);

    expect(lines[0]).toBe("6 of 6 sessions failed to launch.");
    expect(lines).toContain("Nothing about the server was tested.");
    expect(lines.join(" ")).not.toContain("friction");
    expect(lines.join(" ")).not.toContain("goals showed");
    // Nothing happened to anyone, so nobody left feeling anything.
    expect(lines.join(" ")).not.toContain("left");
  });

  it("names rate limiting separately from refusal", () => {
    const lines = summaryFor([
      run({
        report: neverStartedReport(4),
        summary: { total: 4, succeeded: 0, failed: 3, rateLimited: 1 },
      }),
    ]);
    expect(lines[0]).toBe("3 of 4 sessions failed to launch.");
    expect(lines).toContain("1 session were rate limited.");
  });

  it("does not claim a launch failure when sessions merely never resolved", () => {
    // succeeded 0 AND failed 0: the sessions never reached an outcome. That is
    // an ungraded run, not a wave that could not connect.
    const lines = summaryFor([
      run({ summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 } }),
    ]);
    expect(lines.join(" ")).not.toContain("failed to launch");
    expect(lines[0]).toBe("This run finished with nothing graded.");
  });

  it("stays quiet about launches while the wave is still running", () => {
    const lines = summaryFor(
      [
        run({
          status: "running",
          summary: { total: 3, succeeded: 0, failed: 3, rateLimited: 0 },
        }),
      ],
      signals({ terminal: false }),
    );
    expect(lines.join(" ")).not.toContain("failed to launch");
    expect(lines[0]).toBe("Nothing graded yet.");
  });

  it("marks the branch so a generated summary cannot overwrite it", () => {
    expect(summaryKindFor([deadRun("run-1", "journey-1")])).toBe(
      "not_launched",
    );
    expect(
      summaryKindFor([
        run({
          goalScoreSummary: { gradedCount: 4, passedCount: 1, avgScore: 0.2 },
        }),
      ]),
    ).toBe("broken");
  });

  it("never names connection as the friction stage on a partly-launched wave", () => {
    // One goal launched cleanly and rubbed at the value stage; its sibling did
    // not launch at all. The friction sentence must name `user value`, and the
    // untried goal must fall out of the denominator.
    const lines = summaryFor([
      run({
        summary: { total: 4, succeeded: 2, failed: 2, rateLimited: 0 },
        goalScoreSummary: { gradedCount: 4, passedCount: 3, avgScore: 0.8 },
      }),
      run({
        runId: "run-2",
        journeyRefId: "journey-2",
        summary: { total: 2, succeeded: 0, failed: 2, rateLimited: 0 },
      }),
    ]);
    expect(lines[0]).toBe(
      "1 of 1 goals showed friction. No stage broke outright.",
    );
    expect(lines.join(" ")).toContain("at user value");
    expect(lines.join(" ")).not.toContain("at connection");
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
      '"Export the board" broke at user value for Ada Third.',
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
    const lines = composeFindingsSummary(model, { terminal: true }).lines;

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
      "1 of 2 goals showed friction. No stage broke outright.",
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
      "1 of 1 goals showed friction. No stage broke outright.",
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
    const lines = composeFindingsSummary(model, { terminal: true }).lines;

    expect(lines[1]).toBe(
      "The tool response stage showed friction for Maya Chen.",
    );
    expect(lines.join(" ")).not.toContain("Export the board");
  });

  it("celebrates only when every graded goal landed", () => {
    const lines = summaryFor([
      run({
        goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
      }),
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
    }).lines;

    expect(lines[0]).toBe("This run finished with nothing graded.");
    expect(lines.join(" ")).not.toContain("No findings yet");
    // Absent is unknown: an ungraded run is never evidence that anything held.
    expect(lines).toContain(
      "No goal was scored, so nothing here is evidence that the experience held.",
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
        null,
      ),
      { terminal: false },
    ).lines;
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
      null,
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

describe("clampNarration", () => {
  it("takes the first COMPLETE sentence, dropping the backend's truncated tail", () => {
    // Real shape: the backend stores `.slice(0, 320)`, so the last sentence is
    // routinely cut mid-clause.
    expect(
      clampNarration(
        "The main fix is to make the server-selection path unambiguous. Update the tool-facing guidance so the agent first resolves the saved server and rejects host",
      ),
    ).toBe("The main fix is to make the server-selection path unambiguous.");
  });

  it("ellipsizes a narration with no sentence boundary at all", () => {
    expect(clampNarration("Resolve the saved server and rejects host")).toBe(
      "Resolve the saved server and rejects host…",
    );
    // A dangling connective punctuation mark goes with it.
    expect(clampNarration("Resolve the saved server, and")).toBe(
      "Resolve the saved server, and…",
    );
  });

  it("is null for nothing at all", () => {
    expect(clampNarration(null)).toBeNull();
    expect(clampNarration(undefined)).toBeNull();
    expect(clampNarration("   ")).toBeNull();
  });
});

describe("deriveHonestyFootnotes", () => {
  it("marks a legacy wave (no signals or no durable group id) as rubric-only", () => {
    expect(
      deriveHonestyFootnotes({ signals: null, hasGroupId: false }),
    ).toEqual([
      "Evaluator findings only: deterministic signals unavailable for this wave",
    ]);
    expect(
      deriveHonestyFootnotes({ signals: signals(), hasGroupId: false })[0],
    ).toContain("Evaluator findings only");
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
    expect(notes).toContain(
      "Session scan hit its cap, so counts cover a subset",
    );
    expect(notes).toContain(
      "Most sessions are unanalyzed, so treat counts as partial",
    );
    expect(notes).toContain(
      "This swarm is still running, so findings may change",
    );

    const partialJudge = deriveHonestyFootnotes({
      signals: signals({ judgeCoverage: { graded: 3, total: 8 } }),
      hasGroupId: true,
    });
    expect(partialJudge).toEqual([]);
  });

  it("stays silent on a clean, fully graded, terminal wave", () => {
    expect(
      deriveHonestyFootnotes({ signals: signals(), hasGroupId: true }),
    ).toEqual([]);
  });

  it("chips rate limits on a partial launch, not the failed-to-launch tally", () => {
    const notes = deriveHonestyFootnotes({
      signals: signals(),
      hasGroupId: true,
      launch: { total: 9, succeeded: 6, failed: 3, rateLimited: 2 },
    });
    expect(notes).toEqual(["2 sessions rate limited"]);
  });

  it("does not chip a launch nothing survived — the summary already says it", () => {
    expect(
      deriveHonestyFootnotes({
        signals: signals(),
        hasGroupId: true,
        launch: { total: 9, succeeded: 0, failed: 9, rateLimited: 0 },
      }),
    ).toEqual([]);
  });
});

describe("narratedWaveSummary", () => {
  it("drops the fixed prose a zero-candidate wave stores without a model", () => {
    // Real prod row: 3 graded sessions all failed, 2 rate limited, no mined
    // candidates. This sentence replaced the deterministic headline.
    expect(
      narratedWaveSummary("completed", {
        summary:
          "No anomalies concentrated along any dimension of this wave. Nothing to act on from the deterministic signals.",
        candidates: [],
      }),
    ).toBeNull();
  });

  it("keeps the summary when a model narrated candidates", () => {
    expect(
      narratedWaveSummary("completed", {
        summary: "  Resolve the saved server first.  ",
        candidates: [{}],
      }),
    ).toBe("Resolve the saved server first.");
  });

  it("is null until the analysis completes, or when it has no summary", () => {
    expect(
      narratedWaveSummary("pending", { summary: "x", candidates: [{}] }),
    ).toBeNull();
    expect(narratedWaveSummary("completed", null)).toBeNull();
    expect(
      narratedWaveSummary("completed", { summary: "  ", candidates: [{}] }),
    ).toBeNull();
  });
});
