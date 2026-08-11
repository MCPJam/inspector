/**
 * "Built 2h ago" — and the three things it must not say.
 *
 * The chip reports when the analysis behind the view last finished. Three
 * states are easy to get wrong and all three mislead in the same direction —
 * they make the view look freshly analyzed when it is not:
 *   - a FAILED run carries a `finishedAt` like any other terminal run;
 *   - an in-flight run makes Rebuild a redundant second request;
 *   - `latestRun.isStale` means a blown lease on a queued/running job, NOT
 *     old data, so it must never be read as staleness.
 */
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InsightsFreshnessChip } from "../InsightsFreshnessChip";
import type { ClusterRunState } from "@/hooks/useUsageInsights";

const { state } = vi.hoisted(() => ({
  state: { signals: undefined as { dataStale?: boolean } | undefined },
}));

vi.mock("convex/react", () => ({
  useQuery: () => state.signals,
  useMutation: () => async () => undefined,
}));

beforeEach(() => {
  state.signals = undefined;
});

const SCOPE = { kind: "chatbox" as const, chatboxId: "cb-1" };

function run(overrides: Partial<ClusterRunState>): ClusterRunState {
  return {
    _id: "run-1",
    status: "done",
    startedAt: Date.now() - 60_000,
    finishedAt: Date.now() - 30_000,
    sessionCount: 12,
    clusterCount: 3,
    errorMessage: null,
    ...overrides,
  } as ClusterRunState;
}

function renderChip(latestRun: ClusterRunState) {
  return render(
    <InsightsFreshnessChip
      scope={SCOPE}
      latestRun={latestRun}
      onRebuild={vi.fn()}
      rebuildBusy={false}
      testId="chip"
    />,
  );
}

describe("InsightsFreshnessChip", () => {
  it("reports a completed run by when it finished", () => {
    renderChip(run({}));
    expect(screen.getByTestId("chip")).toHaveTextContent(/^Built /);
  });

  it("renders nothing when the cohort has never been analyzed", () => {
    // No run at all is not "not analyzed yet" with a chip around it — there
    // is no freshness to report, so the statline keeps its space.
    render(
      <InsightsFreshnessChip
        scope={SCOPE}
        latestRun={null}
        onRebuild={vi.fn()}
        rebuildBusy={false}
        testId="chip"
      />,
    );
    expect(screen.queryByTestId("chip")).toBeNull();
  });

  it("marks a completed run whose watermarks have moved on", () => {
    // `dataStale` is the honest staleness signal: a session or a rating
    // landed after the newest snapshot. It is NOT `latestRun.isStale`.
    state.signals = { dataStale: true };
    renderChip(run({}));
    expect(screen.getByTestId("chip-stale-dot")).toBeInTheDocument();
    expect(screen.getByTestId("chip")).toHaveTextContent(/^Built /);
  });

  it("does not call a failed run built", () => {
    // `finishedAt` is set on failure too — reading it as freshness would
    // report an analysis that was never produced.
    renderChip(run({ status: "failed", errorMessage: "provider timeout" }));
    expect(screen.getByTestId("chip")).toHaveTextContent("Analysis failed");
    expect(screen.getByTestId("chip")).not.toHaveTextContent("Built");
  });

  it("disables Rebuild while a run is in flight", async () => {
    renderChip(run({ status: "running", finishedAt: null }));
    await screen.getByTestId("chip").click();
    expect(screen.getByTestId("chip-rebuild")).toBeDisabled();
  });

  it("keeps retry available on a stuck run", async () => {
    // A blown 15-minute lease is the one in-flight state a human should be
    // able to act on.
    renderChip(
      run({ status: "running", finishedAt: null, isStale: true } as never),
    );
    await screen.getByTestId("chip").click();
    expect(screen.getByTestId("chip-rebuild")).toBeEnabled();
    expect(screen.getByTestId("chip-rebuild")).toHaveTextContent(
      "Retry analysis",
    );
  });
});
