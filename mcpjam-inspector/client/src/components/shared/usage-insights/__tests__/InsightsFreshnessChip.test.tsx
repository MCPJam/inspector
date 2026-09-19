import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { InsightsFreshnessChip } from "../InsightsFreshnessChip";
import type { InsightsAnalysisSummary } from "@/hooks/useUsageInsights";
const analysis: InsightsAnalysisSummary = {
  total: 10,
  analyzed: 9,
  pending: 1,
  running: 0,
  failed: 0,
  skipped: 0,
  deferred: 0,
  awaitingTaxonomy: 0,
  unassigned: 1,
  staleAssignments: 0,
  projectionPending: 1,
  projectionFailed: 0,
  deferredUntil: null,
  lastAnalyzedAt: 1,
  failures: {},
  skips: {},
  sampled: false,
  taxonomies: [
    {
      dimension: "goal",
      version: 2,
      status: "needs_review",
      assigned: 9,
      unassigned: 1,
      sampleSize: 10,
    },
  ],
};
test("coverage is visible while details and force re-analysis live in the popover", async () => {
  const user = userEvent.setup();
  const rebuild = vi.fn();
  render(
    <InsightsFreshnessChip
      scope={{ kind: "swarm", projectId: "p" }}
      analysis={analysis}
      onRebuild={rebuild}
      rebuildBusy={false}
    />,
  );
  await user.click(
    screen.getByRole("button", { name: "Analyzed 9 of 10 · 1 analyzing" }),
  );
  expect(screen.getByText(/goal v2: needs review/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Re-analyze" }));
  expect(rebuild).toHaveBeenCalledWith({ force: true });
});
test("guest-owned sessions invite sign-in without a scope failure label", () => {
  render(
    <InsightsFreshnessChip
      scope={{ kind: "scenario", scenarioId: "s" }}
      analysis={{
        ...analysis,
        analyzed: 0,
        pending: 0,
        skipped: 10,
        skips: { guest_owned: 10 },
      }}
      onRebuild={vi.fn()}
      rebuildBusy={false}
    />,
  );
  expect(
    screen.getByText("10 skipped: sign in to analyze"),
  ).toBeInTheDocument();
  expect(screen.queryByText("Analysis failed")).not.toBeInTheDocument();
});
