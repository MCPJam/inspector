import wire from "./fixtures/swarm-findings-wire.json";
import { describe, expect, it } from "vitest";
import {
  swarmJourneyFindingSchema,
  swarmJourneyFindingsSchema,
  SWARM_FINDING_DISPOSITIONS,
  SWARM_FINDING_TONE_OF_DISPOSITION,
  SWARM_FINDING_TONES,
} from "../src/contract/swarm-finding.js";
import {
  SWARM_FINDING_DISPOSITION_LABELS,
  SWARM_FINDING_COVERAGE_NOTE_LABELS,
  SWARM_FINDING_SIGNAL_LABELS,
  DECISION_LABEL_VOCABULARIES,
} from "../src/contract/decision-labels.js";
const finding = {
  id: "session:s",
  basis: "sessionReport",
  scopeLevel: "session",
  persona: { personaRefId: null, name: "Ana" },
  goal: { runId: "run", journeyRefId: "goal", title: "Save changes" },
  target: { kind: "host", id: "host", label: "Host", modelId: null },
  population: { count: 1, total: 1, unit: "sessions" },
  sessionIds: ["s"],
  citations: ["s/m:0"],
  verdictSeen: "failed",
  chainStage: "response",
  chainStageState: "failed",
  chainStageBasis: "derived",
  disposition: "blockedByResponse",
  tone: "fail",
  coverageNotes: [],
  outcomePhrase: null,
  mechanismPhrase: null,
  fixPhrase: null,
  reportExcerpt: { actual: "The change was rejected.", citations: ["s/m:0"] },
  mechanismId: null,
};
describe("swarm findings wire contract", () => {
  it("requires explicit identities, evidence and coverage without defaults", () => {
    expect(swarmJourneyFindingSchema.parse(finding)).toEqual(finding);
    expect(
      swarmJourneyFindingSchema.safeParse({
        ...finding,
        coverageNotes: undefined,
      }).success
    ).toBe(false);
    expect(
      swarmJourneyFindingSchema.safeParse({ ...finding, extra: "unknown" })
        .success
    ).toBe(false);
    expect(
      swarmJourneyFindingSchema.safeParse({
        ...finding,
        persona: { name: "Ana", personaRefId: null, extra: 1 },
      }).success
    ).toBe(false);
    expect(swarmJourneyFindingsSchema.safeParse({}).success).toBe(false);
  });
  it("rejects invented dispositions, unscoped citations and model counts", () => {
    for (const patch of [
      { disposition: "annoyed" },
      { citations: ["m:0"] },
      { outcomePhrase: "failed 2 times" },
      { outcomePhrase: "one two three four five six seven eight nine" },
      { sessionIds: Array(1001).fill("s") },
    ]) {
      expect(
        swarmJourneyFindingSchema.safeParse({ ...finding, ...patch }).success
      ).toBe(false);
    }
  });
  it("pins total label and tone maps", () => {
    expect(Object.keys(SWARM_FINDING_TONE_OF_DISPOSITION).sort()).toEqual(
      [...SWARM_FINDING_DISPOSITIONS].sort()
    );
    expect(Object.keys(SWARM_FINDING_DISPOSITION_LABELS).sort()).toEqual(
      [...SWARM_FINDING_DISPOSITIONS].sort()
    );
    expect(Object.keys(SWARM_FINDING_COVERAGE_NOTE_LABELS).sort()).toEqual(
      [...DECISION_LABEL_VOCABULARIES.swarmFindingCoverageNotes].sort()
    );
  });
});

it("accepts the actual backend shared-pipeline publication", () => {
  expect(swarmJourneyFindingsSchema.parse(wire)).toEqual(wire);
});

describe("tone follows disposition", () => {
  it("accepts every disposition with its own tone and rejects any other", () => {
    for (const disposition of SWARM_FINDING_DISPOSITIONS) {
      const tone = SWARM_FINDING_TONE_OF_DISPOSITION[disposition];
      expect(
        swarmJourneyFindingSchema.safeParse({ ...finding, disposition, tone })
          .success
      ).toBe(true);
      for (const other of SWARM_FINDING_TONES.filter((t) => t !== tone)) {
        const result = swarmJourneyFindingSchema.safeParse({
          ...finding,
          disposition,
          tone: other,
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(["tone"]);
      }
    }
  });

  it("holds for persona rollup rows too", () => {
    const parsed = swarmJourneyFindingsSchema.parse(wire);
    const persona = {
      persona: { personaRefId: null, name: "Ana" },
      disposition: "goalMet",
      goalRunIds: ["run"],
    };
    expect(
      swarmJourneyFindingsSchema.safeParse({
        ...parsed,
        personas: [{ ...persona, tone: "fail" }],
      }).success
    ).toBe(false);
    expect(
      swarmJourneyFindingsSchema.safeParse({
        ...parsed,
        personas: [{ ...persona, tone: "ok" }],
      }).success
    ).toBe(true);
  });

  it("accepts the backend fixture as published", () => {
    for (const row of [...wire.findings, ...wire.personas]) {
      expect(row.tone).toBe(
        SWARM_FINDING_TONE_OF_DISPOSITION[
          row.disposition as keyof typeof SWARM_FINDING_TONE_OF_DISPOSITION
        ]
      );
    }
  });
});

describe("recorded signals and verification counts", () => {
  it("accepts a population-fact row that reports what was recorded", () => {
    const row = {
      ...finding,
      id: "signal:outputTruncated:p:run:host",
      basis: "populationFact" as const,
      scopeLevel: "goal" as const,
      signal: "outputTruncated" as const,
      outcomePhrase: "Reply cut off before finishing",
      // A table lookup is not the chain worker's verdict, so a signal row
      // never colours a stage it did not measure.
      chainStageState: null,
      chainStageBasis: "reported" as const,
      reportExcerpt: null,
    };
    expect(swarmJourneyFindingSchema.parse(row)).toEqual(row);
  });

  it("rejects a signal outside the vocabulary", () => {
    expect(
      swarmJourneyFindingSchema.safeParse({ ...finding, signal: "ranOutOfWork" })
        .success
    ).toBe(false);
  });

  it("parses an old payload that predates the signal and account fields", () => {
    expect(swarmJourneyFindingSchema.safeParse(finding).success).toBe(true);
    expect(swarmJourneyFindingSchema.parse(finding).signal).toBeUndefined();
  });

  it("carries a plain-language account beside the cited engineering one", () => {
    const row = {
      ...finding,
      reportExcerpt: {
        actual: "The change was rejected.",
        account: "She tried to save her changes and the app would not take them.",
        citations: ["s/m:0"],
      },
    };
    expect(swarmJourneyFindingSchema.parse(row)).toEqual(row);
    // The account is bounded; `actual` keeps its own, larger bound.
    expect(
      swarmJourneyFindingSchema.safeParse({
        ...finding,
        reportExcerpt: {
          actual: "ok",
          account: "x".repeat(601),
          citations: ["s/m:0"],
        },
      }).success
    ).toBe(false);
  });

  it("conserves verification counts: proposed is the three states summed", () => {
    const envelope = swarmJourneyFindingsSchema.parse(wire);
    const verification = {
      proposed: 4,
      confirmed: 2,
      rejected: 1,
      unverified: 1,
      // Overlapping, never a fourth state.
      omitted: 1,
    };
    const parsed = swarmJourneyFindingsSchema.parse({
      ...envelope,
      verification,
    });
    expect(parsed.verification).toEqual(verification);
    expect(verification.proposed).toBe(
      verification.confirmed + verification.rejected + verification.unverified
    );
  });

  it("refuses a negative or fractional count", () => {
    const envelope = swarmJourneyFindingsSchema.parse(wire);
    for (const bad of [-1, 1.5])
      expect(
        swarmJourneyFindingsSchema.safeParse({
          ...envelope,
          verification: {
            proposed: bad,
            confirmed: 0,
            rejected: 0,
            unverified: 0,
            omitted: 0,
          },
        }).success,
        String(bad)
      ).toBe(false);
  });

  it("labels every signal and the new coverage note", () => {
    for (const signal of DECISION_LABEL_VOCABULARIES.swarmFindingSignals)
      expect(SWARM_FINDING_SIGNAL_LABELS[signal]).toBeTruthy();
    // "rejected", not "checked and rejected": validation can refuse a proposal
    // before any model verifies it.
    expect(SWARM_FINDING_COVERAGE_NOTE_LABELS.mechanismsRejected).toBe(
      "A possible cause was rejected"
    );
  });
});
