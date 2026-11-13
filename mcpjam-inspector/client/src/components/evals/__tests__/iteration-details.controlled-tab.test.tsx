/** A page that owns the tab (through its URL) keeps it across live updates. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { IterationDetails } from "../iteration-details";
import type { EvalCase, EvalIteration } from "../types";

const { mockGetBlob } = vi.hoisted(() => ({ mockGetBlob: vi.fn() }));

vi.mock("convex/react", () => ({
  useAction: () => mockGetBlob,
  useQuery: () => undefined,
  useConvexAuth: () => ({ isAuthenticated: false, isLoading: false }),
}));
vi.mock("@/components/ui/json-editor", () => ({
  JsonEditor: () => <div data-testid="json-editor" />,
}));
vi.mock("@/lib/apis/mcp-tools-api", () => ({ listTools: vi.fn() }));
vi.mock("../trace-viewer", () => ({
  TraceViewer: () => <div data-testid="mock-trace-viewer" />,
}));

const testCase: EvalCase = {
  _id: "case-1",
  testSuiteId: "suite-1",
  createdBy: "user-1",
  title: "signed-in account",
  query: "who am I?",
  models: [{ model: "gpt-4o-mini", provider: "openai" }],
  runs: 1,
  expectedToolCalls: [],
};

const iteration: EvalIteration = {
  _id: "iter-1",
  testCaseId: "case-1",
  createdBy: "user-1",
  createdAt: 0,
  iterationNumber: 1,
  updatedAt: 0,
  status: "completed",
  result: "passed",
  actualToolCalls: [],
  tokensUsed: 0,
  blob: "trace-1",
  testCaseSnapshot: {
    title: "signed-in account",
    query: "who am I?",
    provider: "openai",
    model: "gpt-4o-mini",
    expectedToolCalls: [],
    steps: [
      { id: "s1", kind: "prompt", prompt: "who am I?" },
      { id: "a1", kind: "assert", assertion: { type: "noToolErrors" } },
    ],
  },
  metadata: {
    predicates: [
      {
        predicate: { type: "noToolErrors" },
        passed: true,
        reason: "no errors",
      },
    ],
  },
};

const scorecard = {
  render: () => <div data-testid="mock-scorecard" />,
};

describe("IterationDetails with a controlled tab", () => {
  beforeEach(() => {
    mockGetBlob.mockReset();
    mockGetBlob.mockResolvedValue({});
  });

  it("keeps the given tab when a live iteration finishes", () => {
    const onTabChange = vi.fn();
    const details = (next: EvalIteration) => (
      <IterationDetails
        iteration={next}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
        activeTab="chat"
        onTabChange={onTabChange}
      />
    );
    const { rerender } = render(details({ ...iteration, result: "pending" }));
    expect(screen.queryByTestId("mock-scorecard")).not.toBeInTheDocument();

    rerender(
      details({
        ...iteration,
        result: "failed",
        testCaseSnapshot: {
          title: "signed-in account",
          query: "who am I?",
          provider: "openai",
          model: "gpt-4o-mini",
          expectedToolCalls: [],
          steps: [{ id: "s2", kind: "prompt", prompt: "and now?" }],
        },
      }),
    );
    expect(screen.queryByTestId("mock-scorecard")).not.toBeInTheDocument();
    expect(onTabChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("trace-viewer-scorecard-tab"));
    expect(onTabChange).toHaveBeenCalledWith("scorecard");
  });

  it("falls back to its default when the given tab is not shown", () => {
    // This iteration has no browser artifacts, so there is no Replay tab.
    render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
        activeTab="browser"
        onTabChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("mock-scorecard")).toBeInTheDocument();
  });

  it("falls back to the default, not the last clicked tab", () => {
    const details = (activeTab: "steps" | "browser") => (
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
        activeTab={activeTab}
        onTabChange={vi.fn()}
      />
    );
    const { rerender } = render(details("steps"));
    expect(screen.queryByTestId("mock-scorecard")).not.toBeInTheDocument();
    rerender(details("browser"));
    expect(screen.getByTestId("mock-scorecard")).toBeInTheDocument();
  });

  it("still opens on its own default without one", () => {
    render(
      <IterationDetails
        iteration={iteration}
        testCase={testCase}
        layoutMode="full"
        scorecard={scorecard}
      />,
    );
    expect(screen.getByTestId("mock-scorecard")).toBeInTheDocument();
  });
});
