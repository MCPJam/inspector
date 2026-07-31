import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ChatboxGoalOutcomeGrid } from "../ChatboxGoalOutcomeGrid";
import { EMPTY_USAGE_FILTER, selectCell } from "@/hooks/chatbox-usage-filters";
import type { GoalFacet, UsageBreakdown } from "@/hooks/useUsageInsights";

function facet(overrides: Partial<GoalFacet> = {}): GoalFacet {
  return {
    clusterId: "cluster-a",
    label: "Invoice lookup",
    total: 10,
    outcomes: {
      completed: 3,
      partial: 0,
      unresolved: 5,
      errored: 2,
      unclear: 0,
    },
    unlabeled: 0,
    unresolvedRate: 0.7,
    errorRate: 0.2,
    retryRate: 0.4,
    toolDistribution: [],
    pathDistribution: [],
    distinctPathCount: 4,
    routingEntropy: 1.85,
    ...overrides,
  };
}

function breakdown(overrides: Partial<UsageBreakdown> = {}): UsageBreakdown {
  return {
    themes: [],
    userBreakdown: [],
    deviceBreakdown: [],
    languageBreakdown: [],
    modelBreakdown: [],
    outcomeBreakdown: [],
    frictionBreakdown: [],
    behaviorTagBreakdown: [],
    goalFacets: [facet()],
    labeledOutcomeCount: 10,
    outcomeFeedbackCalibration: [],
    totalSessions: 10,
    latestRun: null,
    ...overrides,
  };
}

describe("ChatboxGoalOutcomeGrid", () => {
  it("renders the target reading: goal, volume, unresolved rate, route count", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown()}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );

    const row = screen.getByRole("row", { name: /Invoice lookup/ });
    expect(within(row).getByText("10")).toBeInTheDocument();
    expect(within(row).getByText("70%")).toBeInTheDocument();
    expect(within(row).getByText("20%")).toBeInTheDocument();
    // Distinct tool routes for this one goal.
    expect(within(row).getByText("4")).toBeInTheDocument();
    expect(within(row).getByText("1.85")).toBeInTheDocument();
  });

  it("does not truncate the goal label", () => {
    const long =
      "Invoice lookup and reconciliation against outstanding purchase orders";
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({ goalFacets: [facet({ label: long })] })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it("renders an unknown rate as an em dash, never as 0%", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({
          goalFacets: [
            facet({
              unresolvedRate: null,
              errorRate: null,
              routingEntropy: null,
            }),
          ],
        })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    const row = screen.getByRole("row", { name: /Invoice lookup/ });
    // Three unknowns: unresolved rate, error rate, entropy.
    expect(within(row).getAllByText("—")).toHaveLength(3);
    expect(within(row).queryByText("0%")).not.toBeInTheDocument();
  });

  it("shows the truncation notice so rates are not read as unconditional", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({
          scan: {
            scanned: 5000,
            matched: 2000,
            truncated: true,
            maxSessions: 2000,
            windowEndAt: 1,
            windowStartAt: 0,
          },
        })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /most recent 2,000 matching sessions/i
    );
  });

  it("omits the truncation notice when the scan was complete", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({
          scan: {
            scanned: 42,
            matched: 42,
            truncated: false,
            maxSessions: 2000,
            windowEndAt: 1,
            windowStartAt: 0,
          },
        })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("reports the labeled denominator explicitly", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({ labeledOutcomeCount: 7, totalSessions: 10 })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(
      screen.getByText(/7 of 10 scanned sessions have an inferred outcome/i)
    ).toBeInTheDocument();
  });

  it("separates the not-analyzed column from the unclear column", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({
          goalFacets: [
            facet({
              total: 6,
              outcomes: {
                completed: 0,
                partial: 0,
                unresolved: 0,
                errored: 0,
                unclear: 2,
              },
              unlabeled: 4,
            }),
          ],
        })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    // Two distinct columns, because absence of a verdict is not the `unclear`
    // verdict.
    expect(
      screen.getByRole("columnheader", { name: "Unclear" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Not analyzed" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Unclear: 2 sessions/ })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /not analyzed: 4 sessions/ })
    ).toBeInTheDocument();
  });

  it("calls onSelectCell with the clicked cell", async () => {
    const user = userEvent.setup();
    const onSelectCell = vi.fn();
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown()}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={onSelectCell}
      />
    );

    await user.click(
      screen.getByRole("button", { name: /Unresolved: 5 sessions/ })
    );
    expect(onSelectCell).toHaveBeenCalledWith({
      clusterId: "cluster-a",
      clusterLabel: "Invoice lookup",
      outcome: "unresolved",
    });
  });

  it("marks the selected cell pressed and leaves the others unpressed", () => {
    const filter = selectCell(EMPTY_USAGE_FILTER, {
      clusterId: "cluster-a",
      outcome: "unresolved",
    });
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown()}
        filter={filter}
        onSelectCell={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /Unresolved: 5 sessions/ })
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /Completed: 3 sessions/ })
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("disables empty cells so there is nothing to drill into", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown()}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(
      screen.getByRole("button", { name: /Partial: 0 sessions/ })
    ).toBeDisabled();
  });

  it("sorts by unresolved rate on request, ranking unknown rates last", async () => {
    const user = userEvent.setup();
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({
          goalFacets: [
            facet({
              clusterId: "big",
              label: "Big volume",
              total: 100,
              unresolvedRate: 0.1,
            }),
            facet({
              clusterId: "bad",
              label: "Bad outcomes",
              total: 10,
              unresolvedRate: 0.9,
            }),
            facet({
              clusterId: "unknown",
              label: "No labels",
              total: 50,
              unresolvedRate: null,
            }),
          ],
        })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );

    // Default is volume.
    let rowHeaders = screen
      .getAllByRole("rowheader")
      .map((el) => el.textContent);
    expect(rowHeaders[0]).toBe("Big volume");

    await user.click(
      screen.getByRole("button", { name: /Sort by unresolved/ })
    );
    rowHeaders = screen.getAllByRole("rowheader").map((el) => el.textContent);
    expect(rowHeaders[0]).toBe("Bad outcomes");
    // An unknown rate must not outrank a measured one.
    expect(rowHeaders[rowHeaders.length - 1]).toBe("No labels");
  });

  it("folds rows past the cap into a real Other row rather than dropping them", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      facet({
        clusterId: `c${i}`,
        label: `Goal ${i}`,
        total: 100 - i,
      })
    );
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({ goalFacets: many })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(screen.getByText("Other (3 goals)")).toBeInTheDocument();
  });

  it("explains an empty grid on a run that predates the split", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={breakdown({
          goalFacets: [],
          latestRun: {
            _id: "run-1",
            status: "done",
            startedAt: 0,
            finishedAt: 1,
            sessionCount: 5,
            clusterCount: 2,
            errorMessage: null,
            signalsVersion: null,
            isStale: false,
          },
        })}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(
      screen.getByText(/ran before goal outcomes existed/i)
    ).toBeInTheDocument();
  });

  it("renders a loading state rather than an empty grid while the breakdown is undefined", () => {
    render(
      <ChatboxGoalOutcomeGrid
        breakdown={undefined}
        filter={EMPTY_USAGE_FILTER}
        onSelectCell={vi.fn()}
      />
    );
    expect(screen.getByText(/Loading goal outcomes/i)).toBeInTheDocument();
  });
});
