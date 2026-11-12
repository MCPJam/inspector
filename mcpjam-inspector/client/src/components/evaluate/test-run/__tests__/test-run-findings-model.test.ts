import { describe, expect, it } from "vitest";
import type { EvalRunDecisionDiagnostic } from "@mcpjam/sdk/contract";
import { remedyForReason } from "../../stage-remedy";
import type { CaseFailureGroup } from "../../evaluate-case-row-model";
import {
  buildTestRunFindings,
  testRunFixPrompt,
  testRunVerdict,
} from "../test-run-findings-model";
import { caseRow, fixtureIteration } from "./test-run-fixtures";

const group = (
  stage: CaseFailureGroup["stage"],
  reason: CaseFailureGroup["reason"],
  iterationIds: string[],
  representative: EvalRunDecisionDiagnostic | null = null,
): CaseFailureGroup => ({
  key: `${stage}::${reason}`,
  stage,
  reason,
  iterationIds,
  representative,
});
const diagnostic = (iterationId: string) =>
  ({ iterationId }) as EvalRunDecisionDiagnostic;

describe("buildTestRunFindings", () => {
  it("turns one group into one finding with its sentence and remedy", () => {
    const [finding] = buildTestRunFindings(
      [
        caseRow({
          failureGroups: [
            group("selection", "missingToolCall", ["a", "b", "c"]),
          ],
        }),
      ],
      8,
    );
    expect(finding).toMatchObject({
      key: "selection:missingToolCall",
      iterationIds: ["a", "b", "c"],
      total: 8,
      observed:
        "3 of 8 iterations broke at Selection: an expected tool call was never made.",
      remedy: remedyForReason("missingToolCall"),
    });
  });

  it("merges the same stage and reason across launch runs", () => {
    const first = diagnostic("a");
    const findings = buildTestRunFindings(
      [
        caseRow({
          failureGroups: [group("selection", "missingToolCall", ["a"], first)],
        }),
        caseRow({
          failureGroups: [
            group("selection", "missingToolCall", ["b"], diagnostic("b")),
          ],
        }),
      ],
      2,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].iterationIds).toEqual(["a", "b"]);
    expect(findings[0].representative).toBe(first);
    expect(findings[0].observed).toBe(
      "2 of 2 iterations broke at Selection: an expected tool call was never made.",
    );
  });

  it("keeps different reasons apart, most iterations first, then chain order", () => {
    const findings = buildTestRunFindings(
      [
        caseRow({
          failureGroups: [
            group("response", null, ["r"]),
            group("selection", "missingToolCall", ["s1", "s2"]),
            group("connection", null, ["c"]),
          ],
        }),
      ],
      4,
    );
    expect(findings.map((finding) => finding.key)).toEqual([
      "selection:missingToolCall",
      "connection:none",
      "response:none",
    ]);
  });

  it.each([
    [
      null,
      null,
      1,
      1,
      "1 of 1 iteration did not complete, and no stage was established.",
    ],
    [
      null,
      null,
      2,
      5,
      "2 of 5 iterations did not complete, and no stage was established.",
    ],
    ["response", null, 1, 3, "1 of 3 iterations broke at Response."],
  ] as const)(
    "says %s / %s as a sentence",
    (stage, reason, count, total, sentence) => {
      const ids = Array.from({ length: count }, (_, i) => `i${i}`);
      const [finding] = buildTestRunFindings(
        [caseRow({ failureGroups: [group(stage, reason, ids)] })],
        total,
      );
      expect(finding.observed).toBe(sentence);
      expect(finding.remedy).toBeNull();
    },
  );

  it("builds the fix prompt from the finding and its first iteration", () => {
    const [finding] = buildTestRunFindings(
      [
        caseRow({
          failureGroups: [group("selection", "missingToolCall", ["a1"])],
        }),
      ],
      4,
    );
    const prompt = testRunFixPrompt(finding, "Sketch", [
      fixtureIteration("a1", "run-a"),
    ]);
    expect(prompt).toContain("Sketch");
    expect(prompt).toContain("First failed stage: Selection");
  });
});

describe("testRunVerdict", () => {
  const passed = fixtureIteration("p", "r", { result: "passed" });
  const failed = fixtureIteration("f", "r", { result: "failed" });
  const running = fixtureIteration("x", "r", {
    result: "pending",
    status: "running",
  });
  it.each([
    ["empty", [], [], "empty"],
    ["pending", [caseRow({ mark: "failed" })], [passed, running], "pending"],
    ["failed", [caseRow({ mark: "failed" })], [passed, failed], "failed"],
    ["flaky", [caseRow({ mark: "passed" })], [passed, failed], "flaky"],
    ["passed", [caseRow({ mark: "passed" })], [passed, passed], "passed"],
    ["undecided (no mark)", [caseRow({ mark: null })], [passed], "undecided"],
    ["undecided (no rows read)", [], [passed], "undecided"],
    [
      "mixed marks across runs",
      [caseRow({ mark: "passed" }), caseRow({ mark: "inconclusive" })],
      [passed],
      "undecided",
    ],
    [
      "a failed run wins over a passed one",
      [caseRow({ mark: "passed" }), caseRow({ mark: "failed" })],
      [passed, failed],
      "failed",
    ],
  ] as const)("%s", (_, rows, iterations, verdict) => {
    expect(testRunVerdict(rows, iterations)).toBe(verdict);
  });
});
