import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ModelCallCostEvidence } from "@mcpjam/sdk/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceTimeline } from "../trace-timeline";
import type { IterationModelCall } from "../trace-cost/iteration-model-calls";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
const query = vi.hoisted(() => ({
  useQuery: vi.fn<(...args: unknown[]) => IterationModelCall[] | undefined>(),
}));
vi.mock("convex/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("convex/react")>()),
  useQuery: query.useQuery,
}));
// Entry animations would leave each render's rows at a different frame.
vi.mock("framer-motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("framer-motion")>()),
  useReducedMotion: () => true,
}));
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizablePanel: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ResizableHandle: () => <div />,
}));
vi.mock("@/components/ui/json-editor", () => ({
  ScrollableJsonView: ({ value }: { value: unknown }) => (
    <div>{JSON.stringify(value)}</div>
  ),
}));

const reported: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd: 0.0021,
  source: "provider_reported",
  funding: "mcpjam",
};
const estimate: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "partial",
  amountUsd: 0.0045,
  source: "list_price",
  parts: { input: 0.0015, output: 0.003 },
  missing: ["cache_write_rate"],
  funding: "customer",
};

function spans(withCost: boolean): EvalTraceSpan[] {
  const step = (index: number, startMs: number): EvalTraceSpan[] => [
    {
      id: `p0-s${index}`,
      name: `Step ${index + 1}`,
      category: "step",
      startMs,
      endMs: startMs + 800,
      promptIndex: 0,
      stepIndex: index,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    },
    {
      id: `p0-s${index}-llm`,
      parentId: `p0-s${index}`,
      name: `LLM call ${index + 1}`,
      category: "llm",
      startMs,
      endMs: startMs + 800,
      promptIndex: 0,
      stepIndex: index,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      ...(withCost ? { cost: index === 0 ? reported : estimate } : {}),
    },
  ];
  return [...step(0, 0), ...step(1, 900)];
}

/** A short llm span with no tokens, as framework routing records one. */
function shortCall(withCost: boolean): EvalTraceSpan {
  return {
    id: "p0-s1-route",
    parentId: "p0-s1",
    name: "Routing call",
    category: "llm",
    startMs: 900,
    endMs: 920,
    promptIndex: 0,
    stepIndex: 1,
    ...(withCost ? { cost: reported } : {}),
  };
}

const user = userEvent.setup();

async function openSecondCall() {
  await user.click(
    within(
      screen
        .getAllByTestId("trace-row")
        .find((row) => row.textContent?.includes("LLM call 2"))!,
    ).getByTestId("trace-row-label-button"),
  );
}

async function hoverSecondCall() {
  await user.hover(
    screen
      .getAllByTestId("trace-row")
      .find((row) => row.textContent?.includes("LLM call 2"))!,
  );
  return screen.findByTestId("trace-row-hover-card");
}

afterEach(() => {
  cleanup();
  flag.on = true;
  query.useQuery.mockReset();
});

const harness = { iterationId: "it-1", harness: true };
// A harness records its calls apart from its spans; the backend matches
// the second call to its step's llm span.
const harnessCalls: IterationModelCall[] = [
  {
    generationId: "g-2",
    modelId: "anthropic/claude-sonnet-4.5",
    createdAt: 2,
    cost: estimate,
    matchedSpanId: "p0-s1-llm",
  },
];

describe("trace cost, flag on", () => {
  it("shows the trace total with its basis and coverage", () => {
    render(
      <TraceTimeline recordedSpans={spans(true)} transcriptMessages={[]} />,
    );
    const summary = screen.getByTestId("trace-cost-summary");
    expect(summary).toHaveTextContent("≈$0.0066");
    expect(summary).toHaveTextContent("Reported and estimated");
    expect(summary).toHaveTextContent("Partial");
    expect(summary).toHaveTextContent("2 of 2 calls priced, 1 partly");
  });

  it("shows one call's cost in the detail line, its source and what it excludes", async () => {
    render(
      <TraceTimeline recordedSpans={spans(true)} transcriptMessages={[]} />,
    );
    await openSecondCall();
    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByTestId("trace-cost-inline")).toHaveTextContent(
      "≈$0.0045",
    );
    const chips = within(pane).getByTestId("trace-cost-chips");
    expect(chips).toHaveTextContent("Estimated at list price");
    expect(chips).toHaveTextContent("Partial");
    expect(chips).toHaveTextContent("Excludes cache writes.");
  });

  it("breaks the call down in the hover card", async () => {
    render(
      <TraceTimeline recordedSpans={spans(true)} transcriptMessages={[]} />,
    );
    const card = await hoverSecondCall();
    const block = within(card).getByTestId("trace-row-hover-cost");
    expect(block).toHaveTextContent("Amount≈$0.0045");
    expect(block).toHaveTextContent("Input≈$0.0015");
    expect(block).toHaveTextContent("Output≈$0.0030");
    expect(block).toHaveTextContent("SourceEstimated at list price");
  });

  it("shows a matched harness call's cost on its span, as the total counts it", async () => {
    query.useQuery.mockReturnValue(harnessCalls);
    const bare = spans(false);
    render(
      <TraceTimeline
        recordedSpans={bare}
        transcriptMessages={[]}
        iterationCost={harness}
      />,
    );
    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "≈$0.0045",
    );

    await openSecondCall();
    const pane = screen.getByTestId("trace-detail-pane");
    expect(within(pane).getByTestId("trace-cost-inline")).toHaveTextContent(
      "≈$0.0045",
    );
    expect(within(pane).getByTestId("trace-cost-chips")).toHaveTextContent(
      "Estimated at list price",
    );
    const card = await hoverSecondCall();
    expect(within(card).getByTestId("trace-row-hover-cost")).toHaveTextContent(
      "Amount≈$0.0045",
    );
    expect(bare.some((span) => span.cost)).toBe(false);
  });

  it("keeps a short call with cost selectable, as the total counts it", () => {
    render(
      <TraceTimeline
        recordedSpans={[...spans(true), shortCall(true)]}
        transcriptMessages={[]}
      />,
    );
    expect(
      screen
        .getAllByTestId("trace-row")
        .some((row) => row.textContent?.includes("Routing call")),
    ).toBe(true);
    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "3 of 3 calls priced",
    );
  });

  it("still hides a short call with no tokens and no cost", () => {
    render(
      <TraceTimeline
        recordedSpans={[...spans(true), shortCall(false)]}
        transcriptMessages={[]}
      />,
    );
    expect(
      screen
        .getAllByTestId("trace-row")
        .some((row) => row.textContent?.includes("Routing call")),
    ).toBe(false);
  });

  it("keeps a short harness call selectable when its matched call has cost", () => {
    query.useQuery.mockReturnValue([
      {
        generationId: "g-route",
        modelId: "anthropic/claude-haiku-4.5",
        createdAt: 3,
        cost: reported,
        matchedSpanId: "p0-s1-route",
      },
    ]);
    render(
      <TraceTimeline
        recordedSpans={[...spans(false), shortCall(false)]}
        transcriptMessages={[]}
        iterationCost={harness}
      />,
    );
    expect(
      screen
        .getAllByTestId("trace-row")
        .some((row) => row.textContent?.includes("Routing call")),
    ).toBe(true);
    expect(screen.queryByTestId("trace-cost-unmatched-calls")).toBeNull();
  });

  it("shows nothing for a trace recorded without costs", () => {
    render(
      <TraceTimeline recordedSpans={spans(false)} transcriptMessages={[]} />,
    );
    expect(screen.queryByTestId("trace-cost-summary")).toBeNull();
  });
});

describe("trace cost without recorded spans", () => {
  const rollup = {
    currency: "USD" as const,
    knownSubtotalUsd: 1.5,
    completeness: "complete" as const,
    totalCalls: 4,
    completeCalls: 4,
    partialCalls: 0,
    unavailableCalls: 0,
    sources: ["customer_rate" as const],
  };
  const unmatchedCall: IterationModelCall = {
    generationId: "g-9",
    modelId: "anthropic/claude-haiku-4.5",
    createdAt: 9,
    cost: reported,
  };

  it("shows the stored total beside the no-timing message", () => {
    render(
      <TraceTimeline
        recordedSpans={[]}
        transcriptMessages={[]}
        iterationCost={{ iterationId: "it-1", harness: false, rollup }}
      />,
    );
    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "≈$1.50",
    );
    expect(
      screen.getByText("No timing data recorded for this iteration."),
    ).toBeTruthy();
  });

  it("lists a harness's calls as unmatched when only the total time is known", () => {
    query.useQuery.mockReturnValue([unmatchedCall]);
    render(
      <TraceTimeline
        recordedSpans={[]}
        transcriptMessages={[]}
        estimatedDurationMs={1200}
        iterationCost={harness}
      />,
    );
    expect(screen.getByTestId("trace-cost-summary")).toHaveTextContent(
      "$0.0021",
    );
    expect(screen.getByTestId("trace-cost-unmatched-calls")).toHaveTextContent(
      "anthropic/claude-haiku-4.5",
    );
    expect(screen.getByText("Estimated total only")).toBeTruthy();
  });

  it("renders the same DOM with the flag off", () => {
    flag.on = false;
    query.useQuery.mockReturnValue([unmatchedCall]);
    for (const estimatedDurationMs of [undefined, 1200]) {
      const html = (iterationCost?: typeof harness) => {
        render(
          <TraceTimeline
            recordedSpans={[]}
            transcriptMessages={[]}
            estimatedDurationMs={estimatedDurationMs}
            iterationCost={iterationCost}
          />,
        );
        const out = document.body.innerHTML;
        cleanup();
        return out;
      };
      expect(html(harness)).toBe(html());
    }
    expect(query.useQuery).not.toHaveBeenCalled();
  });
});

describe("trace cost, flag off", () => {
  async function renderSelectedAndHovered(withCost: boolean) {
    query.useQuery.mockReturnValue(harnessCalls);
    render(
      <TraceTimeline
        recordedSpans={[...spans(withCost), shortCall(withCost)]}
        transcriptMessages={[]}
        iterationCost={withCost ? harness : undefined}
      />,
    );
    await openSecondCall();
    await hoverSecondCall();
    // React ids count up across renders; everything else must match.
    const html = document.body.innerHTML.replace(/_r_[0-9a-z]+_/g, "_r_");
    cleanup();
    return html;
  }

  it("renders exactly the DOM a trace without costs renders", async () => {
    flag.on = false;
    const withoutCost = await renderSelectedAndHovered(false);
    const withCost = await renderSelectedAndHovered(true);
    expect(withCost).toBe(withoutCost);
    expect(withCost).not.toContain("$0.");
    expect(withCost).not.toContain("trace-cost");
    expect(query.useQuery).not.toHaveBeenCalled();
  });
});
