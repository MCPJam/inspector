import { describe, expect, it } from "vitest";
import type {
  ActionableFinding,
  InsightsFindingProvenance,
} from "@/lib/insights-envelope-api";
import {
  mergeLaunchFindings,
  type RunFindings,
} from "../launch-findings-model";

function finding(
  id: string,
  count: number,
  total: number,
  iterationId: string,
  overrides: Partial<ActionableFinding> = {},
): ActionableFinding {
  return {
    id,
    signalFingerprint: `fp_${id}`,
    title: "Selection",
    category: "agent_behavior",
    attribution: "unknown",
    actionTarget: "investigate",
    actionability: "investigate",
    severity: "medium",
    confidence: "low",
    observed: `${count} of ${total} iterations broke at Selection: an expected tool call was never made.`,
    recommendation: "Open the exemplar sessions.",
    acceptanceCriteria: [],
    affected: { count, total, unit: "iterations" },
    evidence: [{ iterationId, kind: "transcript", excerpt: "…" }],
    ...overrides,
  };
}

function provenance(
  id: string,
  stage?: InsightsFindingProvenance["stage"],
  reason?: InsightsFindingProvenance["reason"],
): InsightsFindingProvenance {
  return {
    candidateId: id,
    groupKind: "stage_break",
    basis: "measured",
    mechanismBasis: "complete",
    affectedIterationIds: [],
    ...(stage ? { stage } : {}),
    ...(reason ? { reason } : {}),
  };
}

function part(
  findings: ActionableFinding[],
  provenances: InsightsFindingProvenance[],
  iterationCount = 12,
): RunFindings {
  return { findings, provenance: provenances, iterationCount };
}

describe("mergeLaunchFindings", () => {
  it("merges the same stage and reason across runs, summing counts over the launch", () => {
    const merged = mergeLaunchFindings([
      part(
        [finding("a", 3, 12, "gpt-1")],
        [provenance("a", "selection", "missingToolCall")],
      ),
      part(
        [finding("b", 2, 12, "haiku-1")],
        [provenance("b", "selection", "missingToolCall")],
      ),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].affected).toEqual({
      count: 5,
      total: 24,
      unit: "iterations",
    });
    expect(merged[0].observed).toBe(
      "5 of 24 iterations broke at Selection: an expected tool call was never made.",
    );
    // The first model's iteration is the one Open iteration opens.
    expect(merged[0].evidence.map((item) => item.iterationId)).toEqual([
      "gpt-1",
      "haiku-1",
    ]);
  });

  it("restates a finding only one model has over the whole launch", () => {
    const merged = mergeLaunchFindings([
      part(
        [finding("a", 3, 12, "gpt-1")],
        [provenance("a", "selection", "missingToolCall")],
      ),
      part([], []),
    ]);
    expect(merged.map((item) => item.observed)).toEqual([
      "3 of 24 iterations broke at Selection: an expected tool call was never made.",
    ]);
  });

  it("keeps different reasons apart, and falls back to the signal without a stage", () => {
    const merged = mergeLaunchFindings([
      part(
        [finding("a", 3, 12, "x"), finding("c", 1, 12, "y")],
        [provenance("a", "selection", "missingToolCall"), provenance("c")],
      ),
      part(
        [finding("b", 2, 12, "z"), finding("c", 1, 12, "w")],
        [provenance("b", "selection", "wrongTool"), provenance("c")],
      ),
    ]);
    expect(merged.map((item) => item.affected.count).sort()).toEqual([2, 2, 3]);
  });

  it("leaves prose it cannot restate alone", () => {
    const merged = mergeLaunchFindings([
      part([finding("a", 1, 1, "x", { observed: "The tool errored." })], []),
    ]);
    expect(merged[0].observed).toBe("The tool errored.");
  });
});
