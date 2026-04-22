import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RunDetailPlaygroundActions } from "../run-detail-playground-actions";
import type { EvalSuite, EvalSuiteRun } from "../types";

const suite: EvalSuite = {
  _id: "suite-1",
  createdBy: "u1",
  name: "S",
  description: "",
  configRevision: "1",
  environment: { servers: ["srv"] },
  createdAt: 1,
  updatedAt: 1,
  source: "sdk",
};

const baseRun = {
  _id: "run-1",
  suiteId: suite._id,
  createdBy: "u1",
  runNumber: 1,
  configRevision: "1",
  configSnapshot: {
    tests: [] as [],
    environment: { servers: ["srv"] as string[] },
  },
  status: "completed" as const,
  summary: { passed: 1, failed: 0, total: 1, passRate: 1 },
  createdAt: 1,
  completedAt: 2,
  passCriteria: { minimumPassRate: 100 },
  hasServerReplayConfig: true,
} satisfies EvalSuiteRun;

describe("RunDetailPlaygroundActions", () => {
  it("calls onReplayRun when replay is available", async () => {
    const user = userEvent.setup();
    const onReplayRun = vi.fn();
    render(
      <RunDetailPlaygroundActions
        suite={suite}
        selectedRun={baseRun}
        readOnlyConfig
        onReplayRun={onReplayRun}
        onRerun={vi.fn()}
        onCancelRun={vi.fn()}
        rerunningSuiteId={null}
        replayingRunId={null}
        cancellingRunId={null}
        hasServersConfigured
        missingServers={[]}
      />,
    );
    await user.click(screen.getByRole("button", { name: /replay this run/i }));
    expect(onReplayRun).toHaveBeenCalledWith(suite, baseRun);
  });
});
