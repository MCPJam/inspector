import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SwarmFundingPreviewState } from "@/hooks/use-swarm-funding-preview";
import { SwarmFundingSummary } from "../swarm-funding-summary";

const ready = (
  overrides: Partial<{
    supported: boolean;
    remaining: number;
    runs: Array<{
      sponsored: number;
      credits: number;
      total: number;
      targets: Array<{ targetId: string; eligible: boolean }>;
    }>;
  }> = {},
): SwarmFundingPreviewState => ({
  status: "ready",
  preview: {
    supported: true,
    remaining: 500,
    granted: 500,
    runs: [{ sponsored: 5, credits: 10, total: 15, targets: [] }],
    ...overrides,
  },
});

describe("SwarmFundingSummary", () => {
  it("shows '5 sponsored · 10 use org credits'", () => {
    render(
      <SwarmFundingSummary
        state={ready()}
        requestedRuns={1}
        pendingGoals={0}
        notice={null}
      />,
    );
    expect(screen.getByTestId("new-swarm-funding-split")).toHaveTextContent(
      "5 sponsored · 10 use org credits",
    );
  });

  it("explains why a credit-funded target is not sponsored", () => {
    render(
      <SwarmFundingSummary
        state={ready({
          remaining: 500,
          runs: [
            {
              sponsored: 0,
              credits: 4,
              total: 4,
              targets: [{ targetId: "t1", eligible: false }],
            },
          ],
        })}
        requestedRuns={1}
        pendingGoals={0}
        notice={null}
      />,
    );
    expect(
      screen.getByTestId("new-swarm-funding-explanation"),
    ).toHaveTextContent(/can't use sponsored conversations/i);
  });

  it("says new goals are not counted yet", () => {
    render(
      <SwarmFundingSummary
        state={ready()}
        requestedRuns={1}
        pendingGoals={2}
        notice={null}
      />,
    );
    expect(screen.getByTestId("new-swarm-funding-pending")).toHaveTextContent(
      "Doesn't include your 2 new goals yet.",
    );
  });

  it.each<[string, SwarmFundingPreviewState]>([
    ["idle", { status: "idle" }],
    ["loading", { status: "loading" }],
    ["error", { status: "error" }],
    [
      "unsupported",
      {
        status: "ready",
        preview: { supported: false, remaining: 0, granted: 0, runs: [] },
      },
    ],
  ])("renders nothing while %s", (_name, state) => {
    const { container } = render(
      <SwarmFundingSummary
        state={state}
        requestedRuns={1}
        pendingGoals={0}
        notice={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("ignores a preview that answered a different number of runs", () => {
    const { container } = render(
      <SwarmFundingSummary
        state={ready()}
        requestedRuns={3}
        pendingGoals={0}
        notice={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a review notice even with no preview to show", () => {
    render(
      <SwarmFundingSummary
        state={{ status: "loading" }}
        requestedRuns={1}
        pendingGoals={0}
        notice="Nothing was launched."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Nothing was launched.",
    );
  });
});
