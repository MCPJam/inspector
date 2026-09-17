import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, screen } from "@/test";
import { SuiteInsightsCollapsible } from "../suite-insights-collapsible";

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn().mockResolvedValue(undefined),
}));

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }));

vi.mock("@workos-inc/authkit-react", () => ({
  useAuth: () => ({ signIn: signInMock }),
}));

const { useRunInsightsMock } = vi.hoisted(() => ({
  useRunInsightsMock: vi.fn(),
}));

vi.mock("../use-run-insights", () => ({
  useRunInsights: useRunInsightsMock,
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
  it("shows the insight summary inline in a compact callout", () => {
    useRunInsightsMock.mockReturnValue({
      summary: "Insight body text",
      pending: false,
      failedGeneration: false,
      requestRunInsights: vi.fn(),
      unavailable: false,
      requested: false,
    });

    renderWithProviders(<SuiteInsightsCollapsible runs={[completedRun]} />);

    expect(screen.getByText("Run insights")).toBeInTheDocument();
    expect(screen.getByText("Insight body text")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Run insights/i }),
    ).not.toBeInTheDocument();
  });

  it("offers show more when the summary is long", async () => {
    const user = userEvent.setup();
    const longSummary =
      "Three cases regressed after the timeout change. Failures cluster around tool-call steps and mostly affect hosts that were previously stable across the last several runs in this suite.";

    useRunInsightsMock.mockReturnValue({
      summary: longSummary,
      pending: false,
      failedGeneration: false,
      requestRunInsights: vi.fn(),
      unavailable: false,
      requested: false,
    });

    renderWithProviders(<SuiteInsightsCollapsible runs={[completedRun]} />);

    expect(screen.getByText(longSummary)).toHaveClass("line-clamp-2");
    await user.click(screen.getByRole("button", { name: /Show more/i }));
    expect(screen.getByText(longSummary)).not.toHaveClass("line-clamp-2");
    expect(
      screen.getByRole("button", { name: /Show less/i }),
    ).toBeInTheDocument();
  });

  it("renders nothing when there is no completed run", () => {
    useRunInsightsMock.mockReturnValue({
      summary: null,
      pending: false,
      failedGeneration: false,
      requestRunInsights: vi.fn(),
      unavailable: false,
      requested: false,
    });

    renderWithProviders(
      <SuiteInsightsCollapsible
        runs={[{ ...completedRun, status: "running" }]}
      />,
    );
    expect(screen.queryByText("Run insights")).not.toBeInTheDocument();
  });
});

describe("SuiteInsightsCollapsible sign-in refusal", () => {
  it("offers sign-in rather than a retry, and keeps the band visible", async () => {
    const user = userEvent.setup();
    const requestRunInsights = vi.fn();
    signInMock.mockReset();
    useRunInsightsMock.mockReturnValue({
      summary: null,
      pending: false,
      failedGeneration: false,
      requestRunInsights,
      unavailable: false,
      signInRequired: true,
      requested: false,
      errorMessage: "Sign in to keep going.",
    });

    renderWithProviders(<SuiteInsightsCollapsible runs={[completedRun]} />);

    // The band stays: the reader is exactly the person who has never seen an
    // insight, and hiding it would take the explanation away from them.
    expect(screen.getByText("Run insights")).toBeInTheDocument();
    expect(screen.getByText("Sign in to keep going.")).toBeInTheDocument();

    // Retry is the one thing that cannot work here — the refusal is about who
    // is asking, and pressing again asks the same way.
    expect(
      screen.queryByRole("button", { name: /Retry/i }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Sign in/i }));
    expect(signInMock).toHaveBeenCalledTimes(1);
    expect(requestRunInsights).not.toHaveBeenCalled();
  });
});
