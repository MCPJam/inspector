import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PassCriteriaBadge } from "../pass-criteria-badge";
import type { EvalSuiteRun } from "../types";

function makeRun(overrides: Partial<EvalSuiteRun> = {}): EvalSuiteRun {
  return {
    _id: "run-1",
    suiteId: "suite-1",
    createdBy: "user-1",
    runNumber: 1,
    configRevision: "1",
    configSnapshot: {
      tests: [],
      environment: { servers: [] },
    },
    status: "completed",
    result: "passed",
    createdAt: 1_000,
    completedAt: 2_000,
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    ...overrides,
  } as EvalSuiteRun;
}

describe("PassCriteriaBadge", () => {
  it("labels cancelled runs as cancelled, not failed", () => {
    render(
      <PassCriteriaBadge
        run={makeRun({ status: "cancelled", result: "cancelled" })}
      />,
    );

    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  it("labels timed out runs as timed out, not failed", () => {
    render(
      <PassCriteriaBadge
        run={makeRun({ status: "timed_out", result: "timed_out" })}
      />,
    );

    expect(screen.getByText("Timed out")).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });
});
