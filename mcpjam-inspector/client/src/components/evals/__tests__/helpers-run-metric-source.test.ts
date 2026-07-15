import { describe, expect, it } from "vitest";
import { getLatestRunMetricSource, getRunMetricSource } from "../helpers";
import type { EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "rev-1",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    result: "passed",
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    createdAt: 1,
    completedAt: 2,
    ...overrides,
  };
}

describe("getRunMetricSource", () => {
  it("keys off the run's own source", () => {
    expect(getRunMetricSource(makeRun({ source: "sdk" }), "ui")).toBe("sdk");
    expect(getRunMetricSource(makeRun({ source: "ui" }), "sdk")).toBe("ui");
  });

  it("collapses api and schedule runs to the manual label", () => {
    expect(getRunMetricSource(makeRun({ source: "api" }), "sdk")).toBe("ui");
    expect(getRunMetricSource(makeRun({ source: "schedule" }), "sdk")).toBe(
      "ui",
    );
  });

  it("falls back to the suite's source for legacy runs without one", () => {
    expect(getRunMetricSource(makeRun(), "sdk")).toBe("sdk");
    expect(getRunMetricSource(makeRun(), "ui")).toBe("ui");
    expect(getRunMetricSource(null, "sdk")).toBe("sdk");
    expect(getRunMetricSource(undefined, undefined)).toBe("ui");
  });
});

describe("getLatestRunMetricSource", () => {
  it("labels by the newest run's source on a mixed suite", () => {
    const runs = [
      makeRun({ _id: "old-ci", source: "sdk", completedAt: 100 }),
      makeRun({ _id: "new-ui", source: "ui", completedAt: 200 }),
    ];
    expect(getLatestRunMetricSource(runs, "sdk")).toBe("ui");
  });

  it("uses createdAt when completedAt is missing", () => {
    const runs = [
      makeRun({ _id: "a", source: "ui", completedAt: undefined, createdAt: 10 }),
      makeRun({
        _id: "b",
        source: "sdk",
        completedAt: undefined,
        createdAt: 20,
      }),
    ];
    expect(getLatestRunMetricSource(runs, "ui")).toBe("sdk");
  });

  it("falls back to the suite source when there are no runs", () => {
    expect(getLatestRunMetricSource([], "sdk")).toBe("sdk");
    expect(getLatestRunMetricSource([], undefined)).toBe("ui");
  });
});
