import { describe, expect, it } from "vitest";
import { pickTraceRepairCaseSourceIteration } from "../pick-trace-repair-case-iteration";
import type { EvalIteration, EvalSuiteRun } from "@/components/evals/types";

describe("pickTraceRepairCaseSourceIteration", () => {
  const baseRun: EvalSuiteRun = {
    _id: "run1",
    suiteId: "suite1",
    createdBy: "u",
    runNumber: 1,
    configRevision: "r",
    configSnapshot: { tests: [], environment: { servers: [] } },
    status: "completed",
    createdAt: 1,
    isActive: false,
    hasServerReplayConfig: true,
  };

  it("returns null when blob or suiteRunId missing", () => {
    const iters: EvalIteration[] = [
      {
        _id: "i1",
        testCaseId: "tc",
        createdBy: "u",
        createdAt: 1,
        iterationNumber: 1,
        updatedAt: 2,
        status: "completed",
        result: "failed",
        suiteRunId: "run1",
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ];
    expect(
      pickTraceRepairCaseSourceIteration("tc", iters, [baseRun]),
    ).toBeNull();
  });

  it("PR-4 R6: accepts iterations with only chatSessionId (no legacy blob)", () => {
    // Post-flag-flip iterations may have only `chatSessionId` set when
    // the per-turn fanout succeeded and the legacy blob path was
    // skipped. The trace-repair source picker must consider these
    // valid candidates — `getTestIterationBlob` is source-aware and
    // synthesizes the envelope from chatSessions data.
    const iters: EvalIteration[] = [
      {
        _id: "chatsessions-only",
        testCaseId: "tc",
        createdBy: "u",
        createdAt: 2,
        iterationNumber: 1,
        updatedAt: 5,
        status: "completed",
        result: "failed",
        suiteRunId: "run1",
        chatSessionId: "sess-x",
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ];
    const picked = pickTraceRepairCaseSourceIteration("tc", iters, [baseRun]);
    expect(picked?._id).toBe("chatsessions-only");
  });

  it("PR-4 R6: rejects iterations with neither blob nor chatSessionId", () => {
    const iters: EvalIteration[] = [
      {
        _id: "no-trace",
        testCaseId: "tc",
        createdBy: "u",
        createdAt: 2,
        iterationNumber: 1,
        updatedAt: 5,
        status: "completed",
        result: "failed",
        suiteRunId: "run1",
        // No blob, no chatSessionId — not a valid trace-repair source.
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ];
    expect(
      pickTraceRepairCaseSourceIteration("tc", iters, [baseRun]),
    ).toBeNull();
  });

  it("picks latest failed traced iteration with replay config", () => {
    const iters: EvalIteration[] = [
      {
        _id: "old",
        testCaseId: "tc",
        createdBy: "u",
        createdAt: 1,
        iterationNumber: 1,
        updatedAt: 1,
        status: "completed",
        result: "failed",
        suiteRunId: "run1",
        blob: "b1",
        actualToolCalls: [],
        tokensUsed: 0,
      },
      {
        _id: "newer",
        testCaseId: "tc",
        createdBy: "u",
        createdAt: 2,
        iterationNumber: 2,
        updatedAt: 5,
        status: "completed",
        result: "failed",
        suiteRunId: "run1",
        blob: "b2",
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ];
    const picked = pickTraceRepairCaseSourceIteration("tc", iters, [baseRun]);
    expect(picked?._id).toBe("newer");
  });
});
