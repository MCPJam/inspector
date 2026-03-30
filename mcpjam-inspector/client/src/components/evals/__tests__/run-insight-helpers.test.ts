import { describe, it, expect } from "vitest";
import type { EvalSuiteRun } from "../types";
import {
  findRunInsightForCase,
  formatRunInsightStatusLabel,
} from "../run-insight-helpers";

function makeRunWithCaseInsights(
  rows: NonNullable<EvalSuiteRun["runInsights"]>["caseInsights"],
): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    completedAt: 2,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    runInsights: {
      summary: "",
      generatedAt: 0,
      modelUsed: "m",
      caseInsights: rows,
    },
  };
}

const row = (
  caseKey: string,
  testCaseId: string | undefined,
  summary: string,
): NonNullable<EvalSuiteRun["runInsights"]>["caseInsights"][number] => ({
  caseKey,
  testCaseId,
  title: "t",
  status: "new_failure",
  summary,
});

describe("findRunInsightForCase", () => {
  it("returns null when run is null/undefined", () => {
    expect(findRunInsightForCase(null, { caseKey: "a" })).toBeNull();
    expect(findRunInsightForCase(undefined, { caseKey: "a" })).toBeNull();
  });

  it("returns null when run has no caseInsights", () => {
    const run: EvalSuiteRun = {
      _id: "r",
      suiteId: "s",
      createdBy: "u",
      runNumber: 1,
      configRevision: "r",
      configSnapshot: { tests: [], environment: { servers: [] } },
      status: "completed",
      createdAt: 1,
      completedAt: 2,
      summary: { total: 0, passed: 0, failed: 0, passRate: 0 },
    };
    expect(findRunInsightForCase(run, { caseKey: "k" })).toBeNull();
  });

  it("matches by caseKey when provided", () => {
    const run = makeRunWithCaseInsights([
      row("k1", "id-1", "a"),
      row("k2", "id-2", "b"),
    ]);
    expect(findRunInsightForCase(run, { caseKey: "k2" })?.summary).toBe("b");
  });

  it("falls back to testCaseId when caseKey is not provided", () => {
    const run = makeRunWithCaseInsights([
      row("k1", "id-1", "a"),
      row("k2", "id-2", "b"),
    ]);
    expect(findRunInsightForCase(run, { testCaseId: "id-1" })?.summary).toBe(
      "a",
    );
  });

  it("falls back to testCaseId when caseKey is provided but matches no row", () => {
    const run = makeRunWithCaseInsights([
      row("k1", "id-1", "from wrong key row"),
      row("k2", "id-2", "from k2"),
    ]);
    expect(
      findRunInsightForCase(run, {
        caseKey: "missing-key",
        testCaseId: "id-1",
      })?.summary,
    ).toBe("from wrong key row");
  });

  it("prefers exact caseKey over a different row that only matches testCaseId", () => {
    const run = makeRunWithCaseInsights([
      row("wrong", "tid", "wrong key but id matches"),
      row("right", "other-id", "correct by case key"),
    ]);
    const hit = findRunInsightForCase(run, {
      caseKey: "right",
      testCaseId: "tid",
    });
    expect(hit?.summary).toBe("correct by case key");
  });

  it("returns null when neither caseKey nor testCaseId matches", () => {
    const run = makeRunWithCaseInsights([row("k1", "id-1", "a")]);
    expect(
      findRunInsightForCase(run, { caseKey: "x", testCaseId: "y" }),
    ).toBeNull();
  });

  it("does not match testCaseId when caseKey is provided and matches", () => {
    const run = makeRunWithCaseInsights([
      row("k1", "id-other", "by key"),
      row("k2", "id-wanted", "by id only"),
    ]);
    expect(
      findRunInsightForCase(run, { caseKey: "k1", testCaseId: "id-wanted" })
        ?.summary,
    ).toBe("by key");
  });
});

describe("formatRunInsightStatusLabel", () => {
  it("formats new_failure as New failure", () => {
    expect(formatRunInsightStatusLabel("new_failure")).toBe("New failure");
  });

  it("formats multi-segment statuses", () => {
    expect(formatRunInsightStatusLabel("still_failing")).toBe("Still failing");
  });
});
