import { describe, expect, it } from "vitest";

import type { SwarmOverviewRun, SwarmWaveSignals } from "@/lib/swarm-api";
import { deriveSwarmFindingsModel } from "../findings/findings-derivation";
import {
  composeFindingsHeadline,
  deriveHonestyFootnotes,
} from "../findings/findings-headline";

/**
 * The headline is deterministic templates in a fixed branch order — broken
 * goals outrank friction outrank landed outrank silence — and the footnotes
 * are the card's honesty rail: every way the counts could understate reality
 * gets a chip, never a rubric row.
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

const failingRun = (name: string, runId: string, journeyRefId: string) =>
  run({
    runId,
    journeyRefId,
    personaName: name,
    goalScoreSummary: { gradedCount: 4, passedCount: 1, avgScore: 0.2 },
  });

describe("composeFindingsHeadline", () => {
  it("names up to two personas whose goal broke, with stage, evidence and feeling", () => {
    const headline = composeFindingsHeadline(
      modelFor([
        failingRun("Maya Chen", "run-1", "journey-1"),
        failingRun("Jonah Okoye", "run-2", "journey-2"),
        failingRun("Ada Third", "run-3", "journey-3"),
      ])
    );
    // Personas order alphabetically (the DetailPersonasChip convention), so
    // the two named are Ada and Jonah.
    expect(headline).toContain(
      `Ada Third's "Export the board" broke at user value`
    );
    expect(headline).toContain("Goal completion missed in 3 graded sessions");
    expect(headline).toContain("They left stalled.");
    expect(headline).toContain("Jonah Okoye's");
    // Caps at two personas.
    expect(headline).not.toContain("Maya Chen");
  });

  it("reports friction when no goal broke outright", () => {
    const headline = composeFindingsHeadline(
      modelFor([
        run({
          goalScoreSummary: { gradedCount: 4, passedCount: 3, avgScore: 0.8 },
        }),
        run({
          runId: "run-2",
          journeyRefId: "journey-2",
          goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
        }),
      ])
    );
    expect(headline).toBe(
      "No goal broke outright, but 1 of 2 goals showed friction."
    );
  });

  it("celebrates only when every graded goal landed", () => {
    const headline = composeFindingsHeadline(
      modelFor([
        run({
          goalScoreSummary: { gradedCount: 4, passedCount: 4, avgScore: 1 },
        }),
      ])
    );
    expect(headline).toBe(
      "Every graded goal landed. 12 sessions, no failures found."
    );
  });

  it("says nothing has been graded when nothing has", () => {
    const headline = composeFindingsHeadline(
      modelFor(
        [
          run({
            status: "running",
            summary: { total: 4, succeeded: 0, failed: 0, rateLimited: 0 },
          }),
        ],
        null
      )
    );
    expect(headline).toBe(
      "No findings yet. 4 sessions ran; nothing has been graded."
    );
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

  it("flags no judge, partial judge, truncation, low confidence, and a live wave", () => {
    const notes = deriveHonestyFootnotes({
      signals: signals({
        judgeCoverage: { graded: 0, total: 8 },
        truncated: true,
        lowConfidence: true,
        terminal: false,
      }),
      hasGroupId: true,
    });
    expect(notes).toContain("No judge graded these sessions");
    expect(notes).toContain("Session scan hit its cap — counts cover a subset");
    expect(notes).toContain(
      "Most sessions are unanalyzed — treat counts as partial"
    );
    expect(notes).toContain(
      "This swarm is still running — findings may change"
    );

    const partial = deriveHonestyFootnotes({
      signals: signals({ judgeCoverage: { graded: 3, total: 8 } }),
      hasGroupId: true,
    });
    expect(partial).toEqual(["Judge covered 3 of 8 sessions"]);
  });

  it("stays silent on a clean, fully graded, terminal wave", () => {
    expect(
      deriveHonestyFootnotes({ signals: signals(), hasGroupId: true })
    ).toEqual([]);
  });
});
