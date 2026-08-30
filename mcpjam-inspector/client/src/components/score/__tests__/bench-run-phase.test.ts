import { describe, expect, it } from "vitest";
import type { BenchRun, BenchRunStatus } from "@/lib/apis/bench-api";
import {
  benchOutcomeTone,
  benchPhaseForRun,
  benchProgressFraction,
  benchProgressLabel,
  shouldPollBenchRun,
} from "../bench-run-phase";

function run(
  overrides: Partial<BenchRun> & { status: BenchRunStatus },
): BenchRun {
  return { runId: "run_1", ...overrides };
}

describe("benchmark phases come from the run row alone", () => {
  it("keeps every non-terminal status on the progress screen", () => {
    for (const status of [
      "queued",
      "running",
      "awaiting_evidence",
      "assembling",
    ] as const) {
      expect(benchPhaseForRun(run({ status }))).toBe("progress");
      expect(shouldPollBenchRun(run({ status }))).toBe(true);
    }
  });

  it("treats every terminal status as a report, including the bad ones", () => {
    for (const status of [
      "completed",
      "provisional",
      "insufficient_evidence",
      "failed",
      "cancelled",
    ] as const) {
      expect(benchPhaseForRun(run({ status }))).toBe("report");
      // A settled row never changes again; polling one spends the caller's
      // rate-limit budget on an answer that cannot move.
      expect(shouldPollBenchRun(run({ status }))).toBe(false);
    }
  });

  it("has no phase for a run that does not exist yet", () => {
    expect(benchPhaseForRun(null)).toBe("select");
    expect(shouldPollBenchRun(null)).toBe(false);
  });
});

describe("what a waiting visitor is told", () => {
  it("keeps collecting evidence and scoring apart from running", () => {
    expect(benchProgressLabel(run({ status: "running" }))).toBe(
      "Running the exam",
    );
    expect(benchProgressLabel(run({ status: "awaiting_evidence" }))).toBe(
      "Collecting results",
    );
    expect(benchProgressLabel(run({ status: "assembling" }))).toBe("Scoring");
  });

  it("says cancelling only while the run is still live", () => {
    expect(
      benchProgressLabel(run({ status: "running", cancelRequested: true })),
    ).toBe("Cancelling");
    // Already settled: the request is history, not a state.
    expect(
      benchProgressLabel(run({ status: "cancelled", cancelRequested: true })),
    ).toBe("Running the exam");
  });
});

describe("progress is a fraction or nothing", () => {
  it("returns null rather than zero when there is no denominator", () => {
    expect(benchProgressFraction(run({ status: "running" }))).toBeNull();
    expect(
      benchProgressFraction(
        run({
          status: "running",
          progress: { cellsTotal: 0, cellsCompleted: 0 },
        }),
      ),
    ).toBeNull();
  });

  it("prefers the finest denominator the run reported", () => {
    expect(
      benchProgressFraction(
        run({
          status: "running",
          progress: {
            repetitionsCompleted: 3,
            repetitionsTotal: 12,
            cellsCompleted: 1,
            cellsTotal: 2,
          },
        }),
      ),
    ).toBeCloseTo(0.25);
  });

  it("reports a real zero when the run genuinely reported none done", () => {
    expect(
      benchProgressFraction(
        run({
          status: "running",
          progress: { cellsCompleted: 0, cellsTotal: 8 },
        }),
      ),
    ).toBe(0);
  });
});

describe("a settled run's tone", () => {
  it("separates our failure from the connector's", () => {
    // `completed` is the TARGET's verdict — a connector that failed every
    // check still completes, holding a bad score.
    expect(benchOutcomeTone("completed")).toBe("scored");
    // `failed` is OURS: we could not interpret what came back.
    expect(benchOutcomeTone("failed")).toBe("failed");
    expect(benchOutcomeTone("cancelled")).toBe("stopped");
    expect(benchOutcomeTone("insufficient_evidence")).toBe("partial");
  });
});
