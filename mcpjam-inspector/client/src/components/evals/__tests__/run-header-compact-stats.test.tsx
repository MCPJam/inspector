import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RunHeaderCompactStats } from "../run-header-compact-stats";
import type { EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user",
    runNumber: 1,
    configRevision: "rev1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    createdAt: 1_000,
    completedAt: 136_000,
    summary: { total: 7, passed: 6, failed: 1, passRate: 6 / 7 },
    ...overrides,
  };
}

describe("RunHeaderCompactStats", () => {
  it("renders passed, failed, pass rate, and duration for a completed run", () => {
    render(<RunHeaderCompactStats run={makeRun()} />);
    expect(
      screen.getByText(/6 passed · 1 failed · 86% · 2m 15s/),
    ).toBeInTheDocument();
  });

  it("uses statsOverride when provided", () => {
    render(
      <RunHeaderCompactStats
        run={makeRun({ summary: { total: 1, passed: 1, failed: 0, passRate: 1 } })}
        statsOverride={{
          passed: 5,
          failed: 2,
          total: 7,
          passRate: 5 / 7,
        }}
      />,
    );
    expect(
      screen.getByText(/5 passed · 2 failed · 71% · 2m 15s/),
    ).toBeInTheDocument();
  });

  it("shows run in progress when status is running", () => {
    render(
      <RunHeaderCompactStats
        run={makeRun({
          status: "running",
          completedAt: undefined,
          summary: { total: 3, passed: 1, failed: 0, passRate: 0 },
        })}
      />,
    );
    expect(screen.getByText(/Run in progress/)).toBeInTheDocument();
  });
});
