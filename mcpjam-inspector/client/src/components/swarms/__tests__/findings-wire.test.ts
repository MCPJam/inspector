import { describe, expect, it } from "vitest";
import {
  USER_VALUE_STAGES,
  SWARM_FINDING_COVERAGE_NOTE_LABELS,
  SWARM_FINDING_DISPOSITION_LABELS,
  SWARM_FINDING_TONE_OF_DISPOSITION,
  type SwarmJourneyFinding,
  type SwarmJourneyFindings,
} from "@mcpjam/sdk/contract";
import type { SwarmOverviewRun } from "@/lib/swarm-api";
import {
  brokenWire,
  publishedWire,
  WIRE_GOAL,
  WIRE_MECHANISM_PHRASE,
  WIRE_PERSONA,
  WIRE_RUN_ID,
} from "./swarm-findings-wire-fixtures";
import {
  deriveSwarmFindingsModelFromWire,
  representativeGoalRow,
  wireRecommendation,
} from "../findings/findings-derivation";
import {
  composeWireFindingsSummary,
  waveNarration,
  wireFindingsFootnotes,
} from "../findings/findings-headline";
import { JOURNEY_STAGE_COPY } from "../findings/journey-stages";
it("derives one persona per published persona row, with its own label", () => {
  // Structural only: the backend re-syncs this fixture, so its literals move.
  const journeyFindings = publishedWire();
  const model = derive(journeyFindings);
  expect(model.personas.map((p) => p.name)).toEqual(
    journeyFindings.personas.map((p) => p.persona.name),
  );
  model.personas.forEach((persona, i) => {
    const row = journeyFindings.personas[i]!;
    expect(persona.sentiment.label).toBe(
      SWARM_FINDING_DISPOSITION_LABELS[row.disposition],
    );
    expect(persona.goals.map((g) => g.runId)).toEqual(row.goalRunIds);
  });
});
it("renders producer dispositions even when no legacy run scores exist", () => {
  const model = derive(brokenWire());
  const goal = model.personas[0]!.goals[0]!;
  expect(model.personas[0]!.sentiment.label).toBe(
    SWARM_FINDING_DISPOSITION_LABELS.blockedByResponse,
  );
  expect(goal.sessions).toBe(1);
  expect(goal.stages.connection.state).toBe("none");
  expect(goal.stages.response.state).toBe("fail");
});
it("covers every canonical journey stage", () => {
  expect(Object.keys(JOURNEY_STAGE_COPY).sort()).toEqual(
    [...USER_VALUE_STAGES].sort(),
  );
});

function derive(
  journeyFindings: SwarmJourneyFindings,
  runs: SwarmOverviewRun[] = [],
) {
  return deriveSwarmFindingsModelFromWire({
    journeyFindings,
    personas: [],
    runs,
  });
}

function goalRow(
  base: SwarmJourneyFinding,
  patch: Partial<SwarmJourneyFinding>,
): SwarmJourneyFinding {
  const disposition = patch.disposition ?? base.disposition;
  return {
    ...base,
    ...patch,
    tone: SWARM_FINDING_TONE_OF_DISPOSITION[disposition],
  };
}

describe("goal disposition is independent of wire order", () => {
  it("picks the failing row even when a passing row comes first", () => {
    const value = brokenWire();
    const failing = value.findings[0]!;
    const passing = goalRow(failing, {
      id: "passing",
      scopeLevel: "session",
      disposition: "goalMet",
      chainStage: "userValue",
      chainStageState: "passed",
      mechanismPhrase: null,
    });
    const reportOnly = value.findings[1]!;
    const forward = derive({
      ...value,
      findings: [failing, passing, reportOnly],
    });
    const reversed = derive({
      ...value,
      findings: [reportOnly, passing, failing],
    });
    for (const model of [forward, reversed]) {
      const goal = model.personas[0]!.goals[0]!;
      expect(goal.sentiment).toEqual({
        label: SWARM_FINDING_DISPOSITION_LABELS.blockedByResponse,
        tone: "fail",
      });
      expect(goal.diagnosis.detail).toBe(WIRE_MECHANISM_PHRASE);
    }
    expect(forward.personas[0]!.goals[0]!.stages).toEqual(
      reversed.personas[0]!.goals[0]!.stages,
    );
  });

  it("prefers the worst row by tone when none is goal-scoped", () => {
    const value = brokenWire();
    const base = value.findings[0]!;
    const rows = [
      goalRow(base, { id: "a", scopeLevel: "session", disposition: "goalMet" }),
      goalRow(base, {
        id: "b",
        scopeLevel: "session",
        disposition: "goalMetWithFriction",
      }),
      goalRow(base, { id: "c", scopeLevel: "session", disposition: "notRun" }),
    ];
    expect(representativeGoalRow(rows)?.id).toBe("b");
    expect(representativeGoalRow([...rows].reverse())?.id).toBe("b");
  });

  it("never lets an unmeasured row clear a measured stage", () => {
    const value = brokenWire();
    const failing = value.findings[0]!;
    const unmeasured = goalRow(failing, {
      id: "unmeasured",
      scopeLevel: "session",
      chainStageState: "notMeasured",
    });
    for (const findings of [
      [failing, unmeasured],
      [unmeasured, failing],
    ]) {
      const goal = derive({ ...value, findings }).personas[0]!.goals[0]!;
      expect(goal.stages.response.state).toBe("fail");
    }
  });
});

describe("the wire model", () => {
  it("derives tone from disposition, not from the row", () => {
    const value = brokenWire();
    // A producer bug the schema would reject; the renderer must not trust it.
    value.findings = value.findings.map((row) => ({ ...row, tone: "ok" }));
    value.personas = value.personas.map((row) => ({ ...row, tone: "ok" }));
    const model = derive(value);
    expect(model.personas[0]!.sentiment.tone).toBe("fail");
    expect(model.personas[0]!.goals[0]!.sentiment.tone).toBe("fail");
    expect(model.personas[0]!.goals[0]!.stages.response.evidence[0]!.tone).toBe(
      "fail",
    );
  });

  it("counts sessions that failed to launch from the population", () => {
    const value = brokenWire();
    value.population = {
      ...value.population,
      configured: 10,
      started: 6,
      limited: 1,
    };
    expect(derive(value).launch).toEqual({
      total: 10,
      succeeded: 6,
      failed: 3,
      rateLimited: 1,
    });
  });

  it("titles a goal with no rows from its run", () => {
    const value = brokenWire();
    value.findings = [];
    const model = derive(value, [
      {
        runId: WIRE_RUN_ID,
        journeyRefId: "journey-from-run",
        journeyName: "Reconcile payouts from the run",
      } as SwarmOverviewRun,
    ]);
    const goal = model.personas[0]!.goals[0]!;
    expect(goal.title).toBe("Reconcile payouts from the run");
    expect(goal.journeyRefId).toBe("journey-from-run");
    expect(goal.sentiment.label).toBe(
      SWARM_FINDING_DISPOSITION_LABELS.notMeasured,
    );
  });
});

describe("wireRecommendation", () => {
  it("takes the fix from the verified mechanism reaching the most sessions", () => {
    const value = brokenWire();
    const mechanism = value.findings[0]!;
    value.findings = [
      { ...mechanism, id: "small", fixPhrase: "Small fix." },
      {
        ...mechanism,
        id: "big",
        fixPhrase: "Big fix.",
        population: { ...mechanism.population, count: 5, total: 5 },
      },
      {
        ...value.findings[1]!,
        fixPhrase: "A report is not a fix.",
        population: { ...mechanism.population, count: 9, total: 9 },
      },
    ];
    expect(wireRecommendation(value)).toBe("Big fix.");
  });

  it("is null when no verified mechanism carries a fix", () => {
    const value = brokenWire();
    value.findings = value.findings.map((row) => ({ ...row, fixPhrase: null }));
    expect(wireRecommendation(value)).toBeNull();
  });
});

describe("composeWireFindingsSummary", () => {
  it("states the read counts for an unread wave and footnotes its coverage", () => {
    const value = brokenWire();
    value.summaryKind = "unread";
    value.population = { ...value.population, started: 4, read: 1, unread: 3 };
    value.coverageNotes = ["partialRead", "budgetExhausted"];
    expect(
      composeWireFindingsSummary(value, derive(value), { terminal: true }),
    ).toEqual({ kind: "unread", lines: ["1 of 4 sessions were read."] });
    expect(wireFindingsFootnotes(value)).toEqual([
      SWARM_FINDING_COVERAGE_NOTE_LABELS.partialRead,
      SWARM_FINDING_COVERAGE_NOTE_LABELS.budgetExhausted,
    ]);
  });

  it("names the goal, stage and persona for a broken wave", () => {
    const value = brokenWire();
    const summary = composeWireFindingsSummary(value, derive(value), {
      terminal: true,
    });
    expect(summary.kind).toBe("broken");
    expect(summary.lines[0]).toBe(
      `"${WIRE_GOAL.title}" broke at tool response for ${WIRE_PERSONA.name}.`,
    );
  });

  it("names the goal when the chain never located the break", () => {
    const value = brokenWire();
    value.findings = value.findings.map((row) => ({
      ...row,
      chainStage: null,
      chainStageState: null,
      chainStageBasis: "unmeasured" as const,
    }));
    const summary = composeWireFindingsSummary(value, derive(value), {
      terminal: true,
    });
    expect(summary.kind).toBe("broken");
    expect(summary.lines[0]).toBe(
      `"${WIRE_GOAL.title}" broke for ${WIRE_PERSONA.name}.`,
    );
  });
});

describe("waveNarration", () => {
  it("uses the same gate as the headline", () => {
    expect(
      waveNarration("completed", {
        summary: "No anomalies",
        candidates: [],
        sessionCount: 5,
        unanalyzedSessionCount: 5,
      }),
    ).toEqual({ modelRan: false, sessionCount: 5, unanalyzedSessionCount: 5 });
    expect(
      waveNarration("completed", {
        summary: "Resolve the saved server first.",
        candidates: [{}],
        sessionCount: 5,
        unanalyzedSessionCount: 0,
      })?.modelRan,
    ).toBe(true);
  });

  it("claims nothing before the analysis completes", () => {
    expect(waveNarration("pending", { summary: "x", candidates: [] })).toBe(
      undefined,
    );
    expect(waveNarration("completed", null)).toBe(undefined);
  });
});
