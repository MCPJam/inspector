import { describe, expect, it } from "vitest";
import type { EvalSuiteOverviewEntry } from "../types";
import {
  evalOverviewEntryLastRunStatusClass,
  evalOverviewEntryLastRunStatusLabel,
} from "../helpers";
import {
  getSuitePassFailCounts,
  getSuitePassRatePercent,
} from "../suite-overview-presentation";

const baseEntry = (
  latestRun: EvalSuiteOverviewEntry["latestRun"],
): EvalSuiteOverviewEntry => ({
  suite: {
    _id: "s1",
    name: "Suite",
    description: "",
    configRevision: "1",
    environment: { servers: [] },
    createdBy: "u1",
    createdAt: 0,
    updatedAt: 0,
  },
  latestRun,
  recentRuns: [],
  passRateTrend: [],
  totals: { passed: 0, failed: 0, runs: 0 },
});

describe("evalOverviewEntryLastRunStatusLabel", () => {
  it('returns "No runs yet" when there is no run', () => {
    expect(evalOverviewEntryLastRunStatusLabel(baseEntry(null))).toBe(
      "No runs yet",
    );
  });

  it('returns "Running" for pending or running status', () => {
    expect(
      evalOverviewEntryLastRunStatusLabel(
        baseEntry({
          _id: "r1",
          suiteId: "s1",
          createdBy: "u1",
          runNumber: 1,
          configRevision: "1",
          configSnapshot: {
            tests: [],
            environment: { servers: [] },
          },
          status: "running",
          createdAt: 1,
        }),
      ),
    ).toBe("Running");
  });

  it("maps passed and failed", () => {
    expect(
      evalOverviewEntryLastRunStatusLabel(
        baseEntry({
          _id: "r1",
          suiteId: "s1",
          createdBy: "u1",
          runNumber: 1,
          configRevision: "1",
          configSnapshot: {
            tests: [],
            environment: { servers: [] },
          },
          status: "completed",
          result: "passed",
          createdAt: 1,
        }),
      ),
    ).toBe("Passed");
    expect(
      evalOverviewEntryLastRunStatusLabel(
        baseEntry({
          _id: "r1",
          suiteId: "s1",
          createdBy: "u1",
          runNumber: 1,
          configRevision: "1",
          configSnapshot: {
            tests: [],
            environment: { servers: [] },
          },
          status: "failed",
          createdAt: 1,
        }),
      ),
    ).toBe("Failed");
  });
});

describe("evalOverviewEntryLastRunStatusClass", () => {
  it("uses muted class when there is no run", () => {
    expect(evalOverviewEntryLastRunStatusClass(baseEntry(null))).toContain(
      "muted-foreground",
    );
  });

  it("uses success for passed", () => {
    expect(
      evalOverviewEntryLastRunStatusClass(
        baseEntry({
          _id: "r1",
          suiteId: "s1",
          createdBy: "u1",
          runNumber: 1,
          configRevision: "1",
          configSnapshot: {
            tests: [],
            environment: { servers: [] },
          },
          status: "completed",
          result: "passed",
          createdAt: 1,
        }),
      ),
    ).toContain("text-success");
  });
});

describe("policy-2 inconclusive overview metrics", () => {
  it("does not turn an inconclusive run's summary into a pass rate", () => {
    const entry = baseEntry({
      _id: "r1",
      suiteId: "s1",
      createdBy: "u1",
      runNumber: 1,
      configRevision: "1",
      configSnapshot: { tests: [], environment: { servers: [] } },
      status: "completed",
      result: "inconclusive",
      summary: { total: 10, passed: 10, failed: 0, passRate: 1 },
      createdAt: 1,
    });
    expect(getSuitePassRatePercent(entry)).toBeNull();
    expect(getSuitePassFailCounts(entry)).toBeNull();
  });
});
