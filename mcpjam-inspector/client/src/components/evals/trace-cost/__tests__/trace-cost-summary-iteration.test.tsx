import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type {
  ModelCallCostEvidence,
  ModelCostRollup,
} from "@mcpjam/sdk/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceCostSummary, useTraceCostSpans } from "../trace-cost-display";
import type {
  IterationCostContext,
  IterationModelCall,
} from "../iteration-model-calls";

/** The summary as the timeline mounts it, with the joined spans. */
function Summary({
  spans,
  iteration,
}: {
  spans: EvalTraceSpan[];
  iteration: IterationCostContext;
}) {
  const cost = useTraceCostSpans(spans, iteration);
  return (
    <>
      {cost.loader}
      <TraceCostSummary
        spans={cost.spans}
        iteration={iteration}
        unmatched={cost.unmatched}
      />
    </>
  );
}

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));
const query = vi.hoisted(() => ({
  useQuery: vi.fn<(...args: unknown[]) => IterationModelCall[] | undefined>(),
}));
vi.mock("convex/react", () => ({ useQuery: query.useQuery }));
vi.mock("@/lib/error-reporting", () => ({ reportBoundaryError: vi.fn() }));

const estimate: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd: 0.004,
  source: "list_price",
};
const reported: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd: 0.0123,
  source: "provider_reported",
};
const storedRollup: ModelCostRollup = {
  currency: "USD",
  knownSubtotalUsd: 1.5,
  completeness: "complete",
  totalCalls: 4,
  completeCalls: 4,
  partialCalls: 0,
  unavailableCalls: 0,
  sources: ["customer_rate"],
};

const spans: EvalTraceSpan[] = [
  { id: "s0", name: "Step 1", category: "step", startMs: 0, endMs: 10 },
  {
    id: "s0-llm",
    parentId: "s0",
    name: "Model",
    category: "llm",
    startMs: 0,
    endMs: 5,
    cost: estimate,
  },
];

const calls: IterationModelCall[] = [
  {
    generationId: "g-matched",
    modelId: "anthropic/claude-sonnet-4.5",
    createdAt: 1,
    cost: estimate,
    matchedSpanId: "s0-llm",
  },
  {
    generationId: "g-subagent",
    modelId: "anthropic/claude-haiku-4.5",
    createdAt: 2,
    cost: reported,
  },
  { generationId: "g-unpriced", modelId: "openai/gpt-5-mini", createdAt: 3 },
];

const harness = { iterationId: "it-1", harness: true };

describe("TraceCostSummary for an eval iteration", () => {
  afterEach(() => {
    cleanup();
    flag.on = true;
    query.useQuery.mockReset();
  });

  it("shows the iteration's stored total instead of summing spans", () => {
    render(
      <Summary
        spans={spans}
        iteration={{
          iterationId: "it-1",
          harness: false,
          rollup: storedRollup,
        }}
      />,
    );
    const summary = screen.getByTestId("trace-cost-summary");
    expect(summary).toHaveTextContent("≈$1.50");
    expect(summary).toHaveTextContent("Estimated at your rates");
    expect(summary).toHaveTextContent("4 of 4 calls priced");
    expect(query.useQuery).not.toHaveBeenCalled();
  });

  it("lists a harness iteration's unmatched calls and counts them in the total", () => {
    query.useQuery.mockReturnValue(calls);
    render(<Summary spans={spans} iteration={harness} />);

    expect(query.useQuery).toHaveBeenCalledWith(expect.anything(), {
      iterationId: "it-1",
    });
    const summary = screen.getByTestId("trace-cost-summary");
    // One span call plus two unmatched: $0.004 + $0.0123, the third unpriced.
    expect(summary).toHaveTextContent("≈$0.0163");
    expect(summary).toHaveTextContent("2 of 3 calls priced");
    const list = within(screen.getByTestId("trace-cost-unmatched-calls"));
    expect(list.getByText("Model calls not matched to a step")).toBeTruthy();
    expect(
      list.getAllByRole("listitem").map((item) => item.textContent),
    ).toEqual([
      "anthropic/claude-haiku-4.5$0.0123Provider-reported",
      "openai/gpt-5-miniCost unavailable",
    ]);
    expect(list.queryByText("anthropic/claude-sonnet-4.5")).toBeNull();
    // A long list scrolls inside the summary instead of squeezing the trace.
    expect(screen.getByTestId("trace-cost-unmatched-list")).toHaveClass(
      "max-h-40",
      "overflow-y-auto",
    );
  });

  it("counts a matched call's cost once when its span carries none", () => {
    // Harness llm spans carry no cost of their own; the matched call does.
    const bareSpans = spans.map(({ cost: _cost, ...span }) => span);
    query.useQuery.mockReturnValue(calls);
    render(<Summary spans={bareSpans} iteration={harness} />);

    const summary = screen.getByTestId("trace-cost-summary");
    expect(summary).toHaveTextContent("≈$0.0163");
    expect(summary).toHaveTextContent("2 of 3 calls priced");
  });

  it("keeps the stored total when a harness iteration has one", () => {
    query.useQuery.mockReturnValue(calls);
    render(
      <Summary
        spans={spans}
        iteration={{ ...harness, rollup: storedRollup }}
      />,
    );
    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "≈$1.50",
    );
    expect(screen.getByTestId("trace-cost-unmatched-calls")).toBeTruthy();
  });

  it("shows nothing extra when the backend does not serve the query", () => {
    query.useQuery.mockImplementation(() => {
      throw new Error(
        "[CONVEX Q(evalIterationModelCalls:list)] Could not find public function for 'evalIterationModelCalls:list'",
      );
    });
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    render(<Summary spans={spans} iteration={harness} />);

    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "$0.0040",
    );
    expect(screen.queryByTestId("trace-cost-unmatched-calls")).toBeNull();
  });

  it("drops calls it loaded once the query fails for the same iteration", () => {
    query.useQuery.mockReturnValue(calls);
    const { rerender } = render(<Summary spans={spans} iteration={harness} />);
    expect(screen.getByTestId("trace-cost-unmatched-calls")).toBeTruthy();

    query.useQuery.mockImplementation(() => {
      throw new Error(
        "[CONVEX Q(evalIterationModelCalls:list)] [Request ID: 1] Server Error",
      );
    });
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    rerender(<Summary spans={[...spans]} iteration={harness} />);

    expect(screen.queryByTestId("trace-cost-unmatched-calls")).toBeNull();
    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "$0.0040",
    );
  });

  it("renders nothing and asks for nothing with the flag off", () => {
    flag.on = false;
    query.useQuery.mockReturnValue(calls);
    const { container } = render(
      <Summary
        spans={spans}
        iteration={{ ...harness, rollup: storedRollup }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    expect(query.useQuery).not.toHaveBeenCalled();
  });
});
