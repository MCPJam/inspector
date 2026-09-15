import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UnifiedFindingsSection } from "../unified-findings-section";
import type { EvalIteration } from "../../evals/types";

const mocks = vi.hoisted(() => ({ fail: true, mutation: vi.fn() }));
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));
vi.mock("convex/react", () => ({ useMutation: () => mocks.mutation }));
vi.mock(
  "@/components/shared/actionable-insights/use-insights-envelope",
  () => ({
    useInsightsEnvelope: () => {
      if (mocks.fail) throw new Error("Findings query unavailable");
      return undefined;
    },
  }),
);

const generation = {
  pending: false,
  failedGeneration: false,
  error: null,
  unavailable: false,
  canRequest: false,
  requestInsight: vi.fn(),
};

beforeEach(() => {
  mocks.fail = true;
  mocks.mutation.mockClear();
  generation.requestInsight.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("UnifiedFindingsSection recovery", () => {
  it("keeps execution-error cards out of findings across run switches", () => {
    mocks.fail = false;
    const iterations = [
      {
        _id: "quota",
        suiteRunId: "run-a",
        status: "completed",
        result: "failed",
        error: "Daily MCPJam model limit reached.",
        metadata: { stageStepErrorSource: "model", failureCategory: "setup" },
        actualToolCalls: [],
        tokensUsed: 0,
      },
    ] as unknown as EvalIteration[];
    const { rerender } = render(
      <UnifiedFindingsSection
        suiteRunId="run-a"
        iterations={iterations}
        generation={generation}
      />,
    );
    expect(screen.queryByTestId("run-execution-issues")).toBeNull();
    expect(screen.queryByText(/Daily MCPJam model limit reached/)).toBeNull();
    expect(screen.getByTestId("unified-findings-section")).toBeVisible();
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(generation.requestInsight).not.toHaveBeenCalled();
    rerender(
      <UnifiedFindingsSection
        suiteRunId="run-b"
        iterations={iterations}
        generation={generation}
      />,
    );
    expect(screen.queryByTestId("run-execution-issues")).toBeNull();
  });

  it("shows a retryable error without removing the rest of the report", async () => {
    const user = userEvent.setup();
    render(
      <>
        <h2>Run results</h2>
        <UnifiedFindingsSection suiteRunId="run-a" generation={generation} />
      </>,
    );
    expect(screen.getByRole("heading", { name: "Run results" })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Findings could not be loaded for this run.",
    );
    mocks.fail = false;
    await user.click(screen.getByRole("button", { name: "Retry findings" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("unified-findings-section")).toBeVisible();
    expect(mocks.mutation).not.toHaveBeenCalled();
    expect(generation.requestInsight).not.toHaveBeenCalled();
  });

  it("does not carry one run's query failure to another run", () => {
    const { rerender } = render(
      <UnifiedFindingsSection suiteRunId="run-a" generation={generation} />,
    );
    expect(screen.getByRole("alert")).toBeVisible();
    mocks.fail = false;
    rerender(
      <UnifiedFindingsSection suiteRunId="run-b" generation={generation} />,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("unified-findings-section")).toBeVisible();
  });
});
