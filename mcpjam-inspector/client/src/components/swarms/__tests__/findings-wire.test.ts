import { describe, expect, it } from "vitest";
import {
  USER_VALUE_STAGES,
  SWARM_FINDING_COVERAGE_NOTE_LABELS,
  SWARM_FINDING_DISPOSITION_LABELS,
  SWARM_FINDING_TONE_OF_DISPOSITION,
  swarmJourneyFindingsSchema,
  type SwarmJourneyFinding,
  type SwarmJourneyFindings,
} from "@mcpjam/sdk/contract";
import type { SwarmOverviewRun } from "@/lib/swarm-api";
import {
  brokenWire,
  publishedWire,
  truncatedWire,
  WIRE_ACCOUNT,
  WIRE_GOAL,
  WIRE_MECHANISM_PHRASE,
  WIRE_PERSONA,
  WIRE_RUN_ID,
  WIRE_TRUNCATION_FIX,
} from "./swarm-findings-wire-fixtures";
import {
  deriveSwarmFindingsModelFromWire,
  representativeGoalRow,
  selectLeadWireMechanism,
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
  it("takes the fix from the cause reaching the most sessions", () => {
    const value = brokenWire();
    const mechanism = value.findings[0]!;
    value.findings = [
      {
        ...mechanism,
        id: "small",
        mechanismId: "cause-small",
        fixPhrase: "Small fix.",
        sessionIds: ["session-1"],
      },
      {
        ...mechanism,
        id: "big",
        mechanismId: "cause-big",
        fixPhrase: "Big fix.",
        sessionIds: ["session-2", "session-3", "session-4", "session-5"],
        population: { ...mechanism.population, count: 4, total: 5 },
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

  it("names the cause, the stage and the persona's goal for a broken wave", () => {
    const value = brokenWire();
    const summary = composeWireFindingsSummary(value, derive(value), {
      terminal: true,
    });
    expect(summary.kind).toBe("broken");
    // The CAUSE leads now. The stage and the goal follow on their own lines,
    // so the reader learns what went wrong before where it was noticed.
    expect(summary.lines[0]).toContain(
      WIRE_MECHANISM_PHRASE.replace(/\.$/, ""),
    );
    expect(summary.lines).toContain(
      "The explanation points at the tool response.",
    );
    expect(summary.lines.join(" ")).toContain(WIRE_GOAL.title);
    expect(summary.lines.join(" ")).toContain(WIRE_PERSONA.name);
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
    expect(summary.lines[0]).toContain(
      WIRE_MECHANISM_PHRASE.replace(/\.$/, ""),
    );
    // An unmeasured stage is stated as nothing at all, never guessed.
    expect(summary.lines.join(" ")).not.toContain("stage");
    expect(summary.lines.join(" ")).toContain(WIRE_GOAL.title);
    expect(summary.lines.join(" ")).toContain(WIRE_PERSONA.name);
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

describe("one cause supplies both the headline and the fix", () => {
  it("rejoins the rows a mechanism was fanned across and counts sessions once", () => {
    const wire = truncatedWire();
    const lead = selectLeadWireMechanism(wire)!;
    expect(lead.mechanismId).toBe("mechanism-truncation");
    expect(lead.sessionCount).toBe(2);
    expect(lead.goalRunIds).toHaveLength(2);
    expect(lead.fixPhrase).toBe(WIRE_TRUNCATION_FIX);
  });

  it("ranks by distinct supporting sessions, not by the largest single row", () => {
    // A: two rows of three sessions each = six. B: one row of four.
    // Ranking individual rows picks B; ranking the CAUSE picks A.
    const wire = truncatedWire();
    const rows = wire.findings.filter((r) => r.basis === "verifiedMechanism");
    const a = rows.map((row, i) => ({
      ...row,
      id: `a${i}`,
      mechanismId: "cause-a",
      sessionIds: [`a${i}-1`, `a${i}-2`, `a${i}-3`],
      population: { count: 3, total: 6, unit: "sessions" as const },
      fixPhrase: "Fix A.",
      mechanismPhrase: "Cause A happened.",
    }));
    const b = {
      ...rows[0]!,
      id: "b0",
      mechanismId: "cause-b",
      sessionIds: ["b-1", "b-2", "b-3", "b-4"],
      population: { count: 4, total: 6, unit: "sessions" as const },
      fixPhrase: "Fix B.",
      mechanismPhrase: "Cause B happened.",
    };
    const built = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: [...a, b],
    });
    expect(selectLeadWireMechanism(built)!.mechanismId).toBe("cause-a");
    expect(wireRecommendation(built)).toBe("Fix A.");
    // Stable under wire order.
    const reversed = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: [b, ...a.slice().reverse()],
    });
    expect(selectLeadWireMechanism(reversed)!.mechanismId).toBe("cause-a");
    expect(wireRecommendation(reversed)).toBe("Fix A.");
  });

  it("shows no fix rather than borrowing one from another cause", () => {
    const wire = truncatedWire();
    const rows = wire.findings.filter((r) => r.basis === "verifiedMechanism");
    const built = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: [
        ...rows.map((row, i) => ({ ...row, id: `lead${i}`, fixPhrase: null })),
        {
          ...rows[0]!,
          id: "other",
          mechanismId: "cause-other",
          sessionIds: ["other-1"],
          population: { count: 1, total: 6, unit: "sessions" as const },
          fixPhrase: "Do not show me.",
        },
      ],
    });
    expect(selectLeadWireMechanism(built)!.mechanismId).toBe(
      "mechanism-truncation",
    );
    expect(wireRecommendation(built)).toBeNull();
  });
});

describe("the wire headline says what was established", () => {
  const model = (wire: ReturnType<typeof truncatedWire>) =>
    deriveSwarmFindingsModelFromWire({
      journeyFindings: wire,
      personas: [],
      runs: [],
    });

  it("names the cause, the span and the stage, with the goal title intact", () => {
    const wire = truncatedWire();
    const summary = composeWireFindingsSummary(wire, model(wire), {
      terminal: true,
    });
    expect(summary.lines[0]).toBe(
      "The reply stopped before it was finished in 2 of 4 sessions read across 2 goals.",
    );
    // `derived` means the chain worker measured it; a model's reading would
    // be worded as a reading.
    expect(summary.lines[1]).toBe("Recorded at the tool response stage.");
    // One of the two goals is named IN FULL. Which one is decided by reach and
    // then by id, never by payload order — see the reordering tests below.
    expect(summary.lines.join(" ")).toContain(
      "Export the quarterly ledger for the finance team",
    );
    expect(summary.lines.join(" ")).not.toContain("…");
  });

  it("words the stage as a reading when that is all it is", () => {
    const wire = truncatedWire();
    const built = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: wire.findings.map((row) =>
        row.basis === "verifiedMechanism"
          ? { ...row, chainStageBasis: "reported" }
          : row,
      ),
    });
    const summary = composeWireFindingsSummary(built, model(built), {
      terminal: true,
    });
    expect(summary.lines[1]).toBe(
      "The explanation points at the tool response.",
    );
  });

  it("falls back to the recorded fact when no cause was confirmed", () => {
    const wire = truncatedWire({ mechanismRows: false });
    const summary = composeWireFindingsSummary(wire, model(wire), {
      terminal: true,
    });
    expect(summary.lines[0]).toBe("Reply cut off in 2 of 4 sessions read.");
  });

  it("reports rejected and unverified causes as different footnotes", () => {
    const wire = truncatedWire({
      verification: {
        proposed: 3,
        confirmed: 0,
        rejected: 1,
        unverified: 2,
        omitted: 0,
      },
    });
    const notes = wireFindingsFootnotes(wire);
    expect(notes).toContain("1 possible cause was rejected.");
    expect(notes).toContain("2 possible causes could not be verified.");
  });

  it("never calls an absent analysis a rejected cause", () => {
    const wire = truncatedWire({
      verification: {
        proposed: 0,
        confirmed: 0,
        rejected: 0,
        unverified: 0,
        omitted: 0,
      },
    });
    expect(wireFindingsFootnotes(wire).join(" ")).not.toContain("rejected");
  });
});

describe("the persona speaks for a session that actually exists", () => {
  it("borrows the account from a supporting session, with its own detail", () => {
    const wire = truncatedWire();
    const derived = deriveSwarmFindingsModelFromWire({
      journeyFindings: wire,
      personas: [],
      runs: [],
    });
    const persona = derived.personas[0]!;
    expect(persona.account).toBe(WIRE_ACCOUNT);
    expect(persona.issue).toBe(WIRE_ACCOUNT);
    expect(persona.accountSessionId).toMatch(/^session-/);
    // The cited engineering sentence belongs to that SAME session.
    expect(persona.cited?.actual).toBe(
      "The assistant's reply stopped at its output limit.",
    );
  });

  it("is stable under wire reordering", () => {
    const wire = truncatedWire();
    const reversed = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: [...wire.findings].reverse(),
    });
    const of = (w: typeof wire) =>
      deriveSwarmFindingsModelFromWire({
        journeyFindings: w,
        personas: [],
        runs: [],
      }).personas[0]!;
    expect(of(reversed).accountSessionId).toBe(of(wire).accountSessionId);
  });

  it("falls back cleanly on a payload with no accounts at all", () => {
    const wire = brokenWire();
    const persona = deriveSwarmFindingsModelFromWire({
      journeyFindings: wire,
      personas: [],
      runs: [],
    }).personas[0]!;
    expect(persona.account).toBeUndefined();
    expect(persona.issue).not.toBe("");
  });
});

describe("a recorded fact is evidence, not a verdict", () => {
  it("puts the signal on its stage without colouring the stage", () => {
    const wire = truncatedWire({ mechanismRows: false });
    const goal = deriveSwarmFindingsModelFromWire({
      journeyFindings: wire,
      personas: [],
      runs: [],
    }).personas[0]!.goals.find((g) => g.runId === WIRE_RUN_ID)!;
    const response = goal.stages.response;
    expect(response.evidence.map((e) => e.observation)).toContain(
      "Reply cut off",
    );
    // The chain never measured this stage, so it stays unstated.
    expect(response.state).toBe("none");
  });
});

describe("a reordered payload says the same thing", () => {
  const reversed = (wire: ReturnType<typeof truncatedWire>) =>
    swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: [...wire.findings].reverse(),
    });
  const model = (wire: ReturnType<typeof truncatedWire>) =>
    deriveSwarmFindingsModelFromWire({
      journeyFindings: wire,
      personas: [],
      runs: [],
    });

  it("names the same goal whichever row came first", () => {
    const wire = truncatedWire();
    const lines = (w: typeof wire) =>
      composeWireFindingsSummary(w, model(w), { terminal: true }).lines;
    expect(lines(reversed(wire))).toEqual(lines(wire));
  });

  it("refuses to name a stage the grouped rows disagree about", () => {
    const wire = truncatedWire();
    // One row says the chain measured `response`; the other says `call`. There
    // is no honest single answer, so the card states no stage at all rather
    // than whichever the payload happened to list first.
    let seen = 0;
    const split = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: wire.findings.map((row) =>
        row.basis === "verifiedMechanism" && seen++ === 0
          ? { ...row, chainStage: "call" }
          : row,
      ),
    });
    expect(selectLeadWireMechanism(split)!.chainStage).toBeNull();
    expect(
      composeWireFindingsSummary(split, model(split), {
        terminal: true,
      }).lines.join(" "),
    ).not.toContain("stage");
  });

  it("claims a measured stage only when every row measured it", () => {
    const wire = truncatedWire();
    let seen = 0;
    const mixed = swarmJourneyFindingsSchema.parse({
      ...wire,
      findings: wire.findings.map((row) =>
        row.basis === "verifiedMechanism" && seen++ === 0
          ? { ...row, chainStageBasis: "reported" }
          : row,
      ),
    });
    // The stage still holds, but "recorded at" would claim the chain worker
    // measured it in a row where it did not.
    expect(selectLeadWireMechanism(mixed)!.chainStageBasis).toBe("reported");
    expect(
      composeWireFindingsSummary(mixed, model(mixed), {
        terminal: true,
      }).lines,
    ).toContain("The explanation points at the tool response.");
  });
});
