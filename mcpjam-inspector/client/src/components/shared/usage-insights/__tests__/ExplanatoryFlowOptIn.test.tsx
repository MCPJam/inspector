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
