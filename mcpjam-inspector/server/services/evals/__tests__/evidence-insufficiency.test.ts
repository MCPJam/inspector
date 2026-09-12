/**
 * One vocabulary for "we could not measure this".
 *
 * The pipeline knows four facts that all mean the same thing to a reader and
 * says each of them differently, so nobody can answer "was this result
 * measured?" without knowing all four — and a surface that checks three
 * reports a confident verdict on the fourth.
 */
import { describe, expect, it } from "vitest";
import { deriveEvidenceInsufficiency } from "../evidence-insufficiency";

describe("deriveEvidenceInsufficiency", () => {
  it("reports nothing for a fully measured iteration", () => {
    // The ordinary case, and an empty list means MEASURED — not passed.
    expect(
      deriveEvidenceInsufficiency({
        harnessCompleteness: { status: "complete" },
        judgeAbsence: { absent: false },
        agentActivity: { status: "active" },
      }),
    ).toEqual({ insufficient: false, reasons: [] });
  });

  it("reports nothing when it is told nothing", () => {
    expect(deriveEvidenceInsufficiency({})).toEqual({
      insufficient: false,
      reasons: [],
    });
  });

  it("names an absent trace", () => {
    expect(deriveEvidenceInsufficiency({ traceAbsent: true })).toEqual({
      insufficient: true,
      reasons: ["traceAbsent"],
    });
  });

  it("names a transcript with no span channel SEPARATELY", () => {
    // Not the same as `traceAbsent`, and collapsing the two is precisely how a
    // run with every tool call failing passes vacuously: this executor simply
    // never reports what happened.
    expect(
      deriveEvidenceInsufficiency({ traceLacksSpanChannel: true }),
    ).toEqual({ insufficient: true, reasons: ["traceLacksSpanChannel"] });
  });

  it("names an incomplete harness-evidence merge", () => {
    expect(
      deriveEvidenceInsufficiency({
        harnessCompleteness: { status: "partial" },
      }),
    ).toEqual({ insufficient: true, reasons: ["harnessEvidenceIncomplete"] });
  });

  it("treats a completeness status it does not recognise as incomplete", () => {
    // A new status must not read as "fully measured" simply because nothing
    // here was taught about it.
    expect(
      deriveEvidenceInsufficiency({
        harnessCompleteness: { status: "something_new" },
      }).reasons,
    ).toEqual(["harnessEvidenceIncomplete"]);
  });

  it("names an absent judge", () => {
    expect(
      deriveEvidenceInsufficiency({ judgeAbsence: { absent: true } }),
    ).toEqual({ insufficient: true, reasons: ["judgeAbsent"] });
  });

  it("names a run with no agent activity", () => {
    expect(
      deriveEvidenceInsufficiency({
        agentActivity: { status: "no_agent_activity", detail: "nothing ran" },
      }),
    ).toEqual({ insufficient: true, reasons: ["noAgentActivity"] });
  });

  it("does NOT name an exempt activity assessment", () => {
    // "The question does not apply" is not the same as "we could not measure".
    expect(
      deriveEvidenceInsufficiency({
        agentActivity: { status: "exempt", reason: "model_free" },
      }),
    ).toEqual({ insufficient: false, reasons: [] });
  });

  it("collects every reason, in a fixed order", () => {
    // Fixed so two runs of the same iteration produce the same list and a diff
    // of persisted metadata is readable.
    expect(
      deriveEvidenceInsufficiency({
        traceAbsent: true,
        traceLacksSpanChannel: true,
        harnessCompleteness: { status: "partial" },
        judgeAbsence: { absent: true },
        agentActivity: { status: "no_agent_activity", detail: "x" },
      }).reasons,
    ).toEqual([
      "traceAbsent",
      "traceLacksSpanChannel",
      "harnessEvidenceIncomplete",
      "judgeAbsent",
      "noAgentActivity",
    ]);
  });
});
