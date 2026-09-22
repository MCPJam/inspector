/**
 * The evidence rules the Response checks stand on (plan step C3).
 *
 * The corpus (`uvc-corpus.test.ts`) proves the detectors agree with human
 * labels on realistic trajectories. This file pins the three rules that make
 * those verdicts trustworthy and that a corpus item cannot express on its own:
 * what a size is measured on, what an absent measurement does, and that an
 * unscorable row is not a failure anywhere downstream.
 */

import { describe, expect, it } from "vitest";

import { evaluatePredicate } from "../src/predicates/evaluate";
import {
  buildIterationTranscript,
  MAX_TOOL_RESULT_TEXT_CHARS,
} from "../src/predicates/transcript";
import type { IterationTranscript } from "../src/predicates/types";
import {
  allGatingScorersPassed,
  buildEvaluationConfigSnapshot,
  deriveStageResults,
  predicateScoreDefinition,
  resolveScoreDefinition,
  scoreResultFromPredicateResult,
} from "../src/contract";

const inventory = [
  { name: "dump_logs", description: "Return raw logs.", inputSchema: {} },
];

describe("payload size is measured before our own cap", () => {
  it("keeps the measured bytes when the stored text is truncated", () => {
    const huge = "x".repeat(100_000);
    const transcript = buildIterationTranscript({
      toolCalls: [{ toolName: "dump_logs", arguments: {} }],
      toolResults: [
        {
          toolName: "dump_logs",
          text: huge,
          size: { bytes: huge.length, basis: "model_visible_output", complete: true },
        },
      ],
      resultsCaptured: true,
      toolInventory: inventory,
    });

    // Stored text is capped; the measurement is not.
    expect(transcript.toolResults?.[0]?.text?.length).toBe(
      MAX_TOOL_RESULT_TEXT_CHARS,
    );
    expect(transcript.toolResults?.[0]?.truncated).toBe(true);
    expect(transcript.toolResults?.[0]?.size.bytes).toBe(100_000);

    // …so a budget is graded on what the SERVER returned. Grading the stored
    // length instead would report every oversized result as exactly the cap,
    // and a 65_536-byte budget would pass.
    const over = evaluatePredicate(transcript, {
      type: "toolResultSizeUnder",
      maxBytes: 65_536,
    });
    expect(over.passed).toBe(false);
    expect(over.status).toBeUndefined();
    expect(over.reason).toContain("100,000 bytes");
  });
});

describe("an absent measurement is an error, never a verdict", () => {
  /** A harness that narrated its calls: no results, no timed spans. */
  const narrated: IterationTranscript = buildIterationTranscript({
    toolCalls: [{ toolName: "run_query", arguments: { sql: "select 1" } }],
    toolInventory: inventory,
  });

  it("reports `status: \"error\"` rather than a pass or a fail", () => {
    for (const predicate of [
      { type: "toolLatencyUnder", ms: 500 },
      { type: "toolResultSizeUnder", maxBytes: 4096 },
      { type: "toolResultContains", needle: "1" },
    ] as const) {
      const result = evaluatePredicate(narrated, predicate);
      expect(result.status, predicate.type).toBe("error");
      // `passed` stays false because the field is required — the STATUS is
      // what a reader keys on.
      expect(result.passed, predicate.type).toBe(false);
    }
  });

  it("distinguishes a captured empty scope from an uncaptured one", () => {
    // Same zero rows, opposite answers: we LOOKED and saw no calls, so the
    // budget was simply not exercised.
    const looked = buildIterationTranscript({
      toolCalls: [],
      toolResults: [],
      resultsCaptured: true,
      toolCallTimings: [],
      timingsCaptured: true,
    });
    expect(evaluatePredicate(looked, { type: "toolLatencyUnder", ms: 500 }))
      .toMatchObject({ passed: true });
    expect(
      evaluatePredicate(looked, { type: "toolResultSizeUnder", maxBytes: 10 }),
    ).toMatchObject({ passed: true });
  });

  it("refuses to read a partially measured scope as small", () => {
    const partial = buildIterationTranscript({
      toolCalls: [{ toolName: "dump_logs", arguments: {} }],
      toolResults: [
        {
          toolName: "dump_logs",
          size: { bytes: 0, basis: "model_visible_output", complete: false },
        },
      ],
      resultsCaptured: true,
    });
    expect(
      evaluatePredicate(partial, { type: "toolResultSizeUnder", maxBytes: 10 }),
    ).toMatchObject({ status: "error" });
  });
});

describe("an error row carries no verdict downstream", () => {
  const predicate = { type: "toolLatencyUnder", ms: 500 } as const;
  const result = evaluatePredicate(
    buildIterationTranscript({ toolCalls: [] }),
    predicate,
  );

  it("projects as an error score row with no value", () => {
    const definition = resolveScoreDefinition(
      predicateScoreDefinition(predicate, { ordinal: 0 }),
    );
    const score = scoreResultFromPredicateResult(definition, result);
    expect(score.status).toBe("error");
    expect(score).not.toHaveProperty("value");
    // A gating scorer with no verdict does not pass, and says WHICH scorer
    // was left unresolved — zero evidence never passes a gate.
    const config = buildEvaluationConfigSnapshot([definition]);
    const verdict = allGatingScorersPassed([score], config);
    expect(verdict.passed).toBe(false);
    expect(verdict.unresolvedScorerIds).toEqual([definition.scorerId]);
  });

  it("leaves the response stage notMeasured rather than failed", () => {
    const { stageResults } = deriveStageResults({
      authored: { mode: "model", toolExpectation: "open", assertionCount: 1 },
      evidence: {
        predicateResults: [
          { passed: false, status: "error", reason: result.reason, predicate },
        ],
        traceLacksSpanChannel: true,
      },
      iteration: { status: "completed" },
    });
    const response = stageResults.find((row) => row.stage === "response");
    expect(response?.state).toBe("notMeasured");
  });
});

describe("noToolErrors files at response (analyzer 11)", () => {
  it("fails response, and leaves userValue alone", () => {
    const { stageResults, firstFailedStage } = deriveStageResults({
      authored: { mode: "model", toolExpectation: "open", assertionCount: 1 },
      evidence: {
        predicateResults: [
          {
            passed: false,
            reason: "1 tool error(s)",
            predicate: { type: "noToolErrors" },
          },
        ],
        traceLacksSpanChannel: true,
      },
      iteration: { status: "completed" },
    });
    const byStage = Object.fromEntries(
      stageResults.map((row) => [row.stage, row]),
    );
    expect(byStage.response?.state).toBe("failed");
    // The same defect used to fail here too, which double-counted it and made
    // `firstFailedStage` depend on which row a reader looked at first.
    expect(byStage.userValue?.state).not.toBe("failed");
    expect(firstFailedStage).toBe("response");
  });
});
