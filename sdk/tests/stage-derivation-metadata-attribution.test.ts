/**
 * D7: `metadataAttribution` as evidence for `categoryFor`'s `selection`
 * branch.
 *
 * The property under test is narrower than the judge-evidence suite's
 * subordination rule: this evidence never touches a STATE or REASON — the
 * `selection` row's `state: "failed"` and `reason: "missingToolCall" |
 * "unexpectedToolCall"` are exactly what D1 derived. All this evidence can
 * move is `failureCategory`, from `"selection"` to `"metadata"`, and it can
 * only do that when `selection` is ALREADY the first failed stage.
 */

import { describe, expect, test } from "vitest";
import {
  MAX_EVIDENCE_REASONS,
  MAX_EVIDENCE_REASON_CHARS,
  STAGE_ANALYZER_VERSION,
  deriveStageResults,
  type StageAuthoredCase,
  type StageDerivationInput,
  type StageEvidence,
  type StageResultRow,
} from "../src/contract/index.js";

const modelDrivenCase: StageAuthoredCase = {
  mode: "model_driven",
  expectsToolCall: true,
  assertionCount: 1,
};

const toolSpan = {
  id: "s1",
  category: "tool",
  status: "ok",
  toolName: "delete_all",
  promptIndex: 0,
};

type MetadataAttributionEvidence = NonNullable<
  StageEvidence["metadataAttribution"]
>;

/** A selection failure via a missing expected call — judge-decidable. */
function deriveMissing(
  metadataAttribution: MetadataAttributionEvidence | undefined,
  over: Partial<StageDerivationInput> = {}
) {
  return deriveStageResults({
    authored: modelDrivenCase,
    evidence: {
      spans: [toolSpan],
      prompts: [{ promptIndex: 0, missing: [{ toolName: "search" }] }],
      ...(metadataAttribution ? { metadataAttribution } : {}),
    },
    iteration: { status: "completed" },
    ...over,
  });
}

const selection = (rows: StageResultRow[]) =>
  rows.find((row) => row.stage === "selection")!;

describe("STAGE_ANALYZER_VERSION bumped for D7", () => {
  test("is 4", () => {
    expect(STAGE_ANALYZER_VERSION).toBe(4);
  });
});

describe("a scored+attributed verdict recategorizes a failed selection", () => {
  test("attributed: true → failureCategory: metadata, selection row untouched otherwise", () => {
    const { stageResults, firstFailedStage, failureCategory } = deriveMissing({
      status: "scored",
      attributed: true,
      reasons: ["The description for 'delete_all' says it searches files"],
    });
    expect(selection(stageResults)).toMatchObject({
      state: "failed",
      // D1's own reason is NEVER overwritten by the judge.
      reason: "missingToolCall",
    });
    expect(firstFailedStage).toBe("selection");
    expect(failureCategory).toBe("metadata");
  });

  test("the judge's quoted evidence merges into the selection row, preserving promptIndexes", () => {
    const { stageResults } = deriveMissing({
      status: "scored",
      attributed: true,
      reasons: ["quoted description text"],
    });
    expect(selection(stageResults).evidence).toMatchObject({
      promptIndexes: [0],
      predicateReasons: ["quoted description text"],
    });
  });
});

describe("what does NOT recategorize a failed selection", () => {
  test("attributed: false stays failureCategory: selection", () => {
    const { failureCategory } = deriveMissing({
      status: "scored",
      attributed: false,
      reasons: ["the model just picked wrong; the description was fine"],
    });
    expect(failureCategory).toBe("selection");
  });

  test("scored with no attributed flag stays failureCategory: selection", () => {
    const { failureCategory } = deriveMissing({ status: "scored" });
    expect(failureCategory).toBe("selection");
  });

  test("a pending verdict stays failureCategory: selection", () => {
    const { failureCategory } = deriveMissing({
      status: "pending",
      pendingKind: "scheduled",
    });
    expect(failureCategory).toBe("selection");
  });

  test("an errored judge stays failureCategory: selection — a broken grader is not attribution", () => {
    const { failureCategory } = deriveMissing({ status: "error" });
    expect(failureCategory).toBe("selection");
  });

  test("skipped / not_applicable stay failureCategory: selection", () => {
    for (const status of ["skipped", "not_applicable"] as const) {
      expect(deriveMissing({ status }).failureCategory).toBe("selection");
    }
  });

  test("no metadataAttribution at all is indistinguishable from before D7", () => {
    expect(deriveMissing(undefined).failureCategory).toBe("selection");
  });

  test("attributed: true with no reasons stays failureCategory: selection — an unaudited attribution is not a recategorization", () => {
    const { failureCategory, stageResults } = deriveMissing({
      status: "scored",
      attributed: true,
    });
    expect(failureCategory).toBe("selection");
    expect(selection(stageResults).evidence?.predicateReasons).toBeUndefined();
  });

  test("attributed: true with only empty/whitespace reasons stays failureCategory: selection", () => {
    const { failureCategory } = deriveMissing({
      status: "scored",
      attributed: true,
      reasons: ["", "   "],
    });
    expect(failureCategory).toBe("selection");
  });

  test("unrelated evidence never adds a selection evidence.predicateReasons key", () => {
    const { stageResults } = deriveMissing({
      status: "scored",
      attributed: false,
      reasons: ["ignored — not attributed"],
    });
    expect(selection(stageResults).evidence?.predicateReasons).toBeUndefined();
  });
});

describe("the branch is unreachable when the chain broke upstream", () => {
  test("a connection failure ignores metadataAttribution entirely", () => {
    const { failureCategory, firstFailedStage } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        setupSignals: {
          connection: {
            outcome: "failed",
            attribution: "theirs",
            egressVerified: true,
          },
        },
        // An attributed verdict here must never surface — `selection` never
        // even gets a turn at `categoryFor` once `connection` fails first.
        metadataAttribution: {
          status: "scored",
          attributed: true,
          reasons: ["should never be read"],
        },
      },
      iteration: { status: "completed" },
    });
    expect(firstFailedStage).toBe("connection");
    expect(failureCategory).toBe("setup");
  });

  test("a setup-aborted run ignores metadataAttribution entirely", () => {
    const { failureCategory } = deriveStageResults({
      authored: modelDrivenCase,
      evidence: {
        traceAbsent: true,
        metadataAttribution: {
          status: "scored",
          attributed: true,
          reasons: ["should never be read"],
        },
      },
      iteration: { status: "setup_failed" },
    });
    expect(failureCategory).toBe("setup");
  });
});

describe("metadataAttribution reasons obey the existing evidence bounds", () => {
  test("count and length are capped like every other evidence source", () => {
    const { stageResults } = deriveMissing({
      status: "scored",
      attributed: true,
      reasons: Array.from(
        { length: MAX_EVIDENCE_REASONS + 5 },
        (_, index) => `${index}:${"r".repeat(MAX_EVIDENCE_REASON_CHARS + 40)}`
      ),
    });
    const evidence = selection(stageResults).evidence?.predicateReasons ?? [];
    expect(evidence.length).toBe(MAX_EVIDENCE_REASONS);
    for (const entry of evidence) {
      expect(entry.length).toBeLessThanOrEqual(MAX_EVIDENCE_REASON_CHARS);
    }
  });
});

describe("an unexpectedToolCall selection failure is attributable too", () => {
  test("attributed: true recategorizes it the same way", () => {
    const { stageResults, failureCategory } = deriveStageResults({
      authored: { ...modelDrivenCase, isNegativeTest: true },
      evidence: {
        spans: [toolSpan],
        prompts: [
          { promptIndex: 0, unexpected: [{ toolName: "delete_all" }], passed: false },
        ],
        metadataAttribution: {
          status: "scored",
          attributed: true,
          reasons: ["'delete_all' is described as a safe cleanup tool"],
        },
      },
      iteration: { status: "completed" },
    });
    expect(selection(stageResults)).toMatchObject({
      state: "failed",
      reason: "unexpectedToolCall",
    });
    expect(failureCategory).toBe("metadata");
  });
});
