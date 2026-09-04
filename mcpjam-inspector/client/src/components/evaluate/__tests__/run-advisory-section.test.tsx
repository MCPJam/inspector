/**
 * The section that used to be the loudest thing on the page.
 *
 * What matters here is placement and default state, not content: these rows
 * were always correct, and putting a judge's opinion of a passing case above
 * the case that measurably failed is what made the run page unreadable.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RunAdvisorySection } from "../run-advisory-section";
import type { TriageRow } from "../../evals/ai-triage-helpers";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("../../shared/actionable-insights/actionable-findings", () => ({
  ActionableFindings: () => <div>actionable findings</div>,
}));

function triageRow(overrides: Partial<TriageRow> = {}): TriageRow {
  return {
    id: "row-1",
    source: "workflow",
    title: "Draw a rectangle",
    category: "workflow",
    severity: 1,
    affectedCaseKeys: ["k1"],
    failureCount: 0,
    rawIssues: ["listed views before drawing"],
    rawSuggestions: ["drop the redundant list call"],
    ...overrides,
  } as TriageRow;
}

afterEach(cleanup);

describe("RunAdvisorySection", () => {
  it("stays closed and says these findings decide nothing", () => {
    render(
      <RunAdvisorySection
        suiteRunId="run_1"
        triageRows={[triageRow()]}
        showActionableFindings={false}
      />,
    );
    expect(
      screen.getByText("Worth a look, never required"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Model-generated observations. They do not change the verdict.",
      ),
    ).toBeInTheDocument();
    // Closed: the rows are available, not in the way.
    expect(screen.queryByText("Draw a rectangle")).toBeNull();
  });

  it("counts what is inside without opening it", () => {
    render(
      <RunAdvisorySection
        suiteRunId="run_1"
        triageRows={[triageRow(), triageRow({ id: "row-2" })]}
        showActionableFindings={false}
      />,
    );
    expect(screen.getByText("2 findings")).toBeInTheDocument();
  });

  it("keeps every row, one click away", async () => {
    render(
      <RunAdvisorySection
        suiteRunId="run_1"
        triageRows={[triageRow()]}
        showActionableFindings
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Worth a look/ }));
    expect(screen.getByText("Draw a rectangle")).toBeInTheDocument();
    expect(screen.getByText("listed views before drawing")).toBeInTheDocument();
    expect(screen.getByText("actionable findings")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Copy fix prompt: Draw a rectangle" }),
    ).toBeInTheDocument();
  });

  it("renders nothing at all when there is nothing to fold", () => {
    // An empty disclosure promises content that is not there.
    const { container } = render(
      <RunAdvisorySection
        suiteRunId="run_1"
        triageRows={[]}
        showActionableFindings={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
