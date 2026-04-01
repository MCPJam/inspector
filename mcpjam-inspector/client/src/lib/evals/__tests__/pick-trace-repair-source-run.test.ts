import { describe, expect, it } from "vitest";
import {
  pickTraceRepairSourceRun,
  isTraceRepairSuiteEligible,
} from "../pick-trace-repair-source-run";
import type { EvalSuite, EvalSuiteRun } from "@/components/evals/types";

describe("pickTraceRepairSourceRun", () => {
  it("returns null for SDK suites", () => {
    const sdkSuite: Pick<EvalSuite, "source"> = { source: "sdk" };
    const run = {
      _id: "r1",
      suiteId: "s1",
      status: "completed" as const,
      source: "sdk" as const,
      summary: { failed: 1, passed: 0, total: 1, passRate: 0 },
    } as EvalSuiteRun;
    expect(pickTraceRepairSourceRun(sdkSuite, [run])).toBeNull();
    expect(isTraceRepairSuiteEligible(sdkSuite, [run])).toBe(false);
  });

  it("picks latest completed UI run with failures", () => {
    const playgroundSuite: Pick<EvalSuite, "source"> = { source: "ui" };
    const older = {
      _id: "old",
      suiteId: "s1",
      status: "completed" as const,
      source: "ui" as const,
      createdAt: 1,
      completedAt: 2,
      summary: { failed: 2, passed: 0, total: 2, passRate: 0 },
    } as EvalSuiteRun;
    const newerPass = {
      _id: "pass",
      suiteId: "s1",
      status: "completed" as const,
      source: "ui" as const,
      createdAt: 10,
      completedAt: 11,
      summary: { failed: 0, passed: 2, total: 2, passRate: 1 },
    } as EvalSuiteRun;
    const newestFail = {
      _id: "fail",
      suiteId: "s1",
      status: "completed" as const,
      source: "ui" as const,
      createdAt: 20,
      completedAt: 21,
      summary: { failed: 1, passed: 1, total: 2, passRate: 0.5 },
    } as EvalSuiteRun;
    expect(
      pickTraceRepairSourceRun(playgroundSuite, [older, newerPass, newestFail]),
    ).toEqual(newestFail);
  });

  it("ignores non-completed runs", () => {
    const playgroundSuite: Pick<EvalSuite, "source"> = { source: "ui" };
    const running = {
      _id: "run",
      suiteId: "s1",
      status: "running" as const,
      source: "ui" as const,
      createdAt: 99,
      summary: { failed: 1, passed: 0, total: 1, passRate: 0 },
    } as EvalSuiteRun;
    expect(pickTraceRepairSourceRun(playgroundSuite, [running])).toBeNull();
  });
});
