import { expect, it } from "vitest";
import { swarmJourneyFindingsSchema } from "../../sdk/src/contract/swarm-finding.js";
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
it("prioritizes verified findings, bounds evidence, and preserves population", () => {
  const value = swarmJourneyFindingsSchema.parse(wire);
  const report = value.findings.find((row) => row.basis === "sessionReport")!;
  value.findings = [
    ...Array.from({ length: 10 }, (_, i) => ({
      ...report,
      id: `report:${i}`,
      citations: ["s/m:0", "s/m:1", "s/m:2"],
      reportExcerpt: {
        actual: "A long report. ".repeat(80),
        citations: ["s/m:0", "s/m:1", "s/m:2"],
      },
    })),
    ...value.findings.filter((row) => row.basis === "verifiedMechanism"),
  ];
  const result = compactJourneyFindings(value);
  expect(result.value.findings).toHaveLength(8);
  expect(result.value.findings[0].basis).toBe("verifiedMechanism");
  expect(result.value.population).toEqual(value.population);
  expect(result.value.personas).toEqual(value.personas);
  expect(result.omittedFindings).toBe(3);
  expect(result.omittedEvidence).toBeGreaterThan(0);
  expect(result.contractTruncated).toBe(true);
  expect(
    result.value.findings[1].reportExcerpt!.actual.length
  ).toBeLessThanOrEqual(400);
  expect(value.findings[0].reportExcerpt!.actual.length).toBeGreaterThan(400);
});

function baseWire() {
  return swarmJourneyFindingsSchema.parse(wire);
}

it("clamps a long excerpt at a word boundary within the cap", () => {
  const value = baseWire();
  const report = value.findings.find((row) => row.basis === "sessionReport")!;
  report.reportExcerpt = {
    actual: "word ".repeat(200),
    citations: report.reportExcerpt!.citations,
  };
  const actual = compactJourneyFindings(value).value.findings.find(
    (row) => row.basis === "sessionReport"
  )!.reportExcerpt!.actual;
  expect(actual.length).toBeLessThanOrEqual(MODEL_EXCERPT_CAP);
  expect(actual.endsWith("word…")).toBe(true);
});

it("hard-cuts an excerpt with no space instead of collapsing it", () => {
  expect(clampAtWord("x".repeat(1000), 400)).toBe(`${"x".repeat(399)}…`);
  const value = baseWire();
  const report = value.findings.find((row) => row.basis === "sessionReport")!;
  report.reportExcerpt = {
    actual: "x".repeat(1000),
    citations: report.reportExcerpt!.citations,
  };
  const actual = compactJourneyFindings(value).value.findings.find(
    (row) => row.basis === "sessionReport"
  )!.reportExcerpt!.actual;
  expect(actual).toBe(`${"x".repeat(399)}…`);
});

it("clamps model phrases to the phrase cap at a word boundary", () => {
  const value = baseWire();
  const mechanism = value.findings.find(
    (row) => row.basis === "verifiedMechanism"
  )!;
  mechanism.mechanismPhrase = "reason ".repeat(60);
  mechanism.fixPhrase = "fix ".repeat(100);
  const result = compactJourneyFindings(value);
  const row = result.value.findings[0]!;
  expect(row.mechanismPhrase!.length).toBeLessThanOrEqual(MODEL_PHRASE_CAP);
  expect(row.mechanismPhrase!.endsWith("reason…")).toBe(true);
  expect(row.fixPhrase!.length).toBeLessThanOrEqual(MODEL_PHRASE_CAP);
  expect(row.outcomePhrase).toBe(mechanism.outcomePhrase);
  expect(result.contractTruncated).toBe(true);
});

it("cuts citations to two and caps session ids, counting both", () => {
  const value = baseWire();
  value.findings = value.findings.filter(
    (row) => row.basis === "verifiedMechanism"
  );
  value.findings[0] = {
    ...value.findings[0]!,
    citations: ["s/m:0", "s/m:1", "s/m:2", "s/m:3"],
    sessionIds: Array.from({ length: 12 }, (_, i) => `session-${i}`),
  };
  const result = compactJourneyFindings(value);
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
  const value = baseWire();
  const mechanism = value.findings.find(
    (row) => row.basis === "verifiedMechanism"
  )!;
  value.findings = Array.from({ length: 11 }, (_, i) => ({
    ...mechanism,
    id: `mechanism:${i}`,
    citations: ["s/m:0", "s/m:1", "s/m:2"],
  }));
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
