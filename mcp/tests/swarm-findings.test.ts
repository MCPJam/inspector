import { expect, it } from "vitest";
import {
  swarmJourneyFindingsSchema,
  type SwarmJourneyFinding,
  type SwarmJourneyFindings,
} from "../../sdk/src/contract/swarm-finding.js";
import wire from "../../sdk/tests/fixtures/swarm-findings-wire.json";
import {
  clampAtWord,
  compactInsightsForModel,
  compactJourneyFindings,
  MODEL_EXCERPT_CAP,
  MODEL_MAX_FINDINGS,
  MODEL_MAX_SESSION_IDS_PER_FINDING,
  MODEL_PHRASE_CAP,
} from "../src/tools/platformTools.js";

// The backend owns and re-syncs the fixture, so only its envelope is reused.
// Every row these tests reason about is written here.
const MECHANISM: SwarmJourneyFinding = {
  id: "mechanism",
  basis: "verifiedMechanism",
  scopeLevel: "goal",
  persona: { name: "Ana", personaRefId: null },
  goal: { runId: "run", journeyRefId: "journey", title: "Reconcile payouts" },
  target: { kind: "host", id: "host", label: "Claude", modelId: null },
  population: { count: 1, total: 1, unit: "sessions" },
  sessionIds: ["session-1"],
  citations: ["session-1/m:0"],
  verdictSeen: "failed",
  chainStage: "response",
  chainStageState: "failed",
  chainStageBasis: "reported",
  disposition: "blockedByResponse",
  tone: "fail",
  coverageNotes: [],
  outcomePhrase: "could not save changes",
  mechanismPhrase: "The requested change was rejected.",
  fixPhrase: "Accept the requested change.",
  reportExcerpt: null,
  mechanismId: "mechanism-1",
};
const REPORT: SwarmJourneyFinding = {
  ...MECHANISM,
  id: "report",
  basis: "sessionReport",
  scopeLevel: "session",
  chainStage: null,
  chainStageState: null,
  chainStageBasis: "unmeasured",
  disposition: "notMeasured",
  tone: "muted",
  outcomePhrase: null,
  mechanismPhrase: null,
  fixPhrase: null,
  reportExcerpt: {
    actual: "The change was rejected.",
    citations: ["session-1/m:0"],
  },
  mechanismId: null,
};

function withFindings(findings: SwarmJourneyFinding[]): SwarmJourneyFindings {
  return swarmJourneyFindingsSchema.parse({ ...wire, findings });
}

it("prioritizes verified findings, bounds evidence, and preserves population", () => {
  const value = withFindings([
    ...Array.from({ length: 10 }, (_, i) => ({
      ...REPORT,
      id: `report:${i}`,
      citations: ["s/m:0", "s/m:1", "s/m:2"],
      reportExcerpt: {
        actual: "A long report. ".repeat(80),
        citations: ["s/m:0", "s/m:1", "s/m:2"],
      },
    })),
    MECHANISM,
  ]);
  const result = compactJourneyFindings(value);
  expect(result.value.findings).toHaveLength(MODEL_MAX_FINDINGS);
  expect(result.value.findings[0].basis).toBe("verifiedMechanism");
  expect(result.value.population).toEqual(value.population);
  expect(result.value.personas).toEqual(value.personas);
  expect(result.omittedFindings).toBe(11 - MODEL_MAX_FINDINGS);
  expect(result.omittedEvidence).toBeGreaterThan(0);
  expect(result.contractTruncated).toBe(true);
  expect(
    result.value.findings[1].reportExcerpt!.actual.length
  ).toBeLessThanOrEqual(MODEL_EXCERPT_CAP);
  expect(value.findings[0].reportExcerpt!.actual.length).toBeGreaterThan(
    MODEL_EXCERPT_CAP
  );
});

function excerptAfterCompaction(actual: string): string {
  const value = withFindings([
    { ...REPORT, reportExcerpt: { actual, citations: ["s/m:0"] } },
  ]);
  return compactJourneyFindings(value).value.findings[0]!.reportExcerpt!.actual;
}

it("clamps a long excerpt at a word boundary within the cap", () => {
  const actual = excerptAfterCompaction("word ".repeat(200));
  expect(actual.length).toBeLessThanOrEqual(MODEL_EXCERPT_CAP);
  expect(actual.endsWith("word…")).toBe(true);
});

it("hard-cuts an excerpt with no space instead of collapsing it", () => {
  expect(clampAtWord("x".repeat(1000), 400)).toBe(`${"x".repeat(399)}…`);
  expect(excerptAfterCompaction("x".repeat(1000))).toBe(
    `${"x".repeat(MODEL_EXCERPT_CAP - 1)}…`
  );
});

it("clamps model phrases to the phrase cap at a word boundary", () => {
  const result = compactJourneyFindings(
    withFindings([
      {
        ...MECHANISM,
        mechanismPhrase: "reason ".repeat(60),
        fixPhrase: "fix ".repeat(100),
      },
    ])
  );
  const row = result.value.findings[0]!;
  expect(row.mechanismPhrase!.length).toBeLessThanOrEqual(MODEL_PHRASE_CAP);
  expect(row.mechanismPhrase!.endsWith("reason…")).toBe(true);
  expect(row.fixPhrase!.length).toBeLessThanOrEqual(MODEL_PHRASE_CAP);
  expect(row.outcomePhrase).toBe(MECHANISM.outcomePhrase);
  expect(result.contractTruncated).toBe(true);
});

it("cuts citations to two and caps session ids, counting both", () => {
  const result = compactJourneyFindings(
    withFindings([
      {
        ...MECHANISM,
        citations: ["s/m:0", "s/m:1", "s/m:2", "s/m:3"],
        sessionIds: Array.from({ length: 12 }, (_, i) => `session-${i}`),
      },
    ])
  );
  const row = result.value.findings[0]!;
  expect(row.citations).toEqual(["s/m:0", "s/m:1"]);
  expect(row.sessionIds).toHaveLength(MODEL_MAX_SESSION_IDS_PER_FINDING);
  expect(row.sessionIds[0]).toBe("session-0");
  // 2 citations + 7 session ids left out.
  expect(result.omittedEvidence).toBe(
    2 + 12 - MODEL_MAX_SESSION_IDS_PER_FINDING
  );
  expect(result.omittedFindings).toBe(0);
});

it("records journey omissions in the envelope's own truncation counters", () => {
  const value = withFindings(
    Array.from({ length: 11 }, (_, i) => ({
      ...MECHANISM,
      id: `mechanism:${i}`,
      citations: ["s/m:0", "s/m:1", "s/m:2"],
    }))
  );
  const payload = {
    insights: {
      schemaVersion: 1,
      scope: { kind: "journey_run", id: "r" },
      status: "completed",
      findings: [],
      journeyFindings: value,
      truncation: {
        truncated: false,
        omittedFindings: 1,
        omittedEvidence: 2,
        contractTruncated: false,
      },
    },
  };
  const out = compactInsightsForModel(payload).insights;
  expect(out.journeyFindings.findings).toHaveLength(MODEL_MAX_FINDINGS);
  expect(out.journeyFindings.population).toEqual(value.population);
  expect(out.truncation).toEqual({
    truncated: true,
    // 1 already recorded upstream + 3 journey findings past the cap.
    omittedFindings: 1 + 11 - MODEL_MAX_FINDINGS,
    // 2 already recorded + one citation cut on each kept finding.
    omittedEvidence: 2 + MODEL_MAX_FINDINGS,
    contractTruncated: false,
  });
});
