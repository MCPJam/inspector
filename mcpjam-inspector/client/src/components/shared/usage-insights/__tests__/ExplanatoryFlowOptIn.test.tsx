import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseAction, mockUseMutation, mockUseQuery } = vi.hoisted(() => ({
  mockUseAction: vi.fn(),
  mockUseMutation: vi.fn(),
  mockUseQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: (...args: unknown[]) => mockUseAction(...args),
  useMutation: (...args: unknown[]) => mockUseMutation(...args),
  useQuery: (...args: unknown[]) => mockUseQuery(...args),
}));

import { ExplanatoryFlowOptIn } from "../ExplanatoryFlowOptIn";

const BENCHMARK_SCOPE = {
  kind: "benchmark",
  benchmarkRunId: "run_1",
} as const;

beforeEach(() => {
  mockUseAction.mockReset();
  mockUseMutation.mockReset();
  mockUseQuery.mockReset();
  mockUseAction.mockReturnValue(vi.fn());
  mockUseMutation.mockReturnValue(vi.fn());
  mockUseQuery.mockReturnValue(null);
});

/**
 * The invariant worth a test: opening a page must not buy anything. A panel
 * that subscribes on mount is how a charge arrives for a tab somebody opened.
 */
describe("nothing is read until somebody says yes", () => {
  it("issues no query at all before the click", () => {
    render(<ExplanatoryFlowOptIn scope={BENCHMARK_SCOPE} />);

    expect(mockUseQuery).not.toHaveBeenCalled();
    expect(mockUseAction).not.toHaveBeenCalled();
    expect(screen.getByText("Analyze these traces")).toBeInTheDocument();
  });

  it("names the cost before asking, and says what it cannot affect", () => {
    render(<ExplanatoryFlowOptIn scope={BENCHMARK_SCOPE} />);
    expect(screen.getByText(/costs credits/)).toBeInTheDocument();
    expect(
      screen.getByText(/Nothing it produces feeds a score/),
    ).toBeInTheDocument();
  });

  it("subscribes only after the click", async () => {
    render(<ExplanatoryFlowOptIn scope={BENCHMARK_SCOPE} />);
    await userEvent.click(screen.getByText("Analyze these traces"));

    expect(mockUseQuery).toHaveBeenCalled();
    const names = mockUseQuery.mock.calls.map(([name]) => name);
    expect(names).toContain("chatSessions:getBenchmarkUsageBreakdown");
  });
});

describe("a surface with no cohort makes no offer", () => {
  it("renders nothing at all rather than a button that spends nothing", () => {
    const { container } = render(<ExplanatoryFlowOptIn scope={null} />);

    // Not an explanation of an absent feature either: this panel can share a
    // column with nothing else, and a permanent "not available here" line is
    // noise where an empty column is honest.
    expect(container).toBeEmptyDOMElement();
    expect(mockUseQuery).not.toHaveBeenCalled();
  });
});

/**
 * The affirmative click and the spend have to be the same act.
 *
 * The panel says "Analyze these traces" and names the cost. If that click only
 * reveals a second control asking the same question, the primary one looks
 * broken and one consent is split across two clicks — the visitor who clicks
 * once and walks away has paid for nothing and seen nothing.
 */
describe("saying yes starts the pass", () => {
  it("runs the analyzer on the click, without waiting for a second one", async () => {
    const generate = vi.fn().mockResolvedValue({});
    mockUseAction.mockReturnValue(generate);
    // No prior pass: this cohort has nothing to show and nothing in flight.
    mockUseQuery.mockReturnValue({ inferredExperience: null });

    render(<ExplanatoryFlowOptIn scope={BENCHMARK_SCOPE} />);
    await userEvent.click(screen.getByText("Analyze these traces"));

    expect(generate).toHaveBeenCalledWith({ benchmarkRunId: "run_1" });
  });

  /**
   * Consent to analyze is not consent to re-analyze. A finished pass is
   * already visible and a running one is already paid for; charging again for
   * either is the failure mode that matters here, since this is the only
   * control on the surface that spends.
   */
  it.each([
    ["ready", { status: "ready", traceCount: 4, current: true }],
    ["generating", { status: "generating", traceCount: 4, current: true }],
  ])("does not re-run when a pass is already %s", async (_label, inferred) => {
    const generate = vi.fn().mockResolvedValue({});
    mockUseAction.mockReturnValue(generate);
    mockUseQuery.mockReturnValue({ inferredExperience: inferred });

    render(<ExplanatoryFlowOptIn scope={BENCHMARK_SCOPE} />);
    await userEvent.click(screen.getByText("Analyze these traces"));

    expect(generate).not.toHaveBeenCalled();
  });

  /**
   * A pass that read a DIFFERENT set of traces is withheld by the backend, so
   * the columns are not on screen and the visitor is owed a real one.
   */
  it("runs again when the stored pass read other traces", async () => {
    const generate = vi.fn().mockResolvedValue({});
    mockUseAction.mockReturnValue(generate);
    mockUseQuery.mockReturnValue({
      inferredExperience: { status: "ready", traceCount: 4, current: false },
    });

    render(<ExplanatoryFlowOptIn scope={BENCHMARK_SCOPE} />);
    await userEvent.click(screen.getByText("Analyze these traces"));

    expect(generate).toHaveBeenCalledWith({ benchmarkRunId: "run_1" });
  });
});
