import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test";
import { SuiteInsightsCollapsible } from "../suite-insights-collapsible";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../use-run-insights", () => ({
  useRunInsights: vi.fn(() => ({
    summary: "Insight body text",
    pending: false,
    failedGeneration: false,
    requestRunInsights: vi.fn(),
    unavailable: false,
    requested: true,
  })),
}));

const completedRun = {
  _id: "run-a",
  suiteId: "suite-1",
  createdBy: "u1",
  runNumber: 1,
  configRevision: "1",
  configSnapshot: { tests: [], environment: { servers: [] } },
  status: "completed" as const,
  source: "ui" as const,
  createdAt: Date.now(),
  completedAt: Date.now(),
};

describe("SuiteInsightsCollapsible", () => {
  it("renders summary and toggles header when clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SuiteInsightsCollapsible runs={[completedRun]} />);

    const trigger = screen.getByRole("button", { name: /Run insights/i });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Insight body text")).toBeInTheDocument();

    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("renders nothing when there is no completed run", () => {
    renderWithProviders(
      <SuiteInsightsCollapsible
        runs={[{ ...completedRun, status: "running" }]}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /Run insights/i }),
    ).not.toBeInTheDocument();
  });
});
