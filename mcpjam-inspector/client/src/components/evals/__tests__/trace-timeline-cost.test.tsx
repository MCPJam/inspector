import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ModelCallCostEvidence } from "@mcpjam/sdk/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import { TraceTimeline } from "../trace-timeline";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));
vi.mock("@/lib/analytics", () => ({ track: vi.fn() }));
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
});

describe("trace cost, flag on", () => {
  it("shows the trace total with its basis and coverage", () => {
    render(<TraceTimeline recordedSpans={spans(true)} transcriptMessages={[]} />);
    const summary = screen.getByTestId("trace-cost-summary");
    expect(summary).toHaveTextContent("≈$0.0066");
    expect(summary).toHaveTextContent("Reported and estimated");
    expect(summary).toHaveTextContent("Partial");
    expect(summary).toHaveTextContent("2 of 2 calls priced, 1 partly");
  });

  it("shows one call's cost in the detail line, its source and what it excludes", async () => {
    render(<TraceTimeline recordedSpans={spans(true)} transcriptMessages={[]} />);
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
    render(<TraceTimeline recordedSpans={spans(true)} transcriptMessages={[]} />);
    const card = await hoverSecondCall();
    const block = within(card).getByTestId("trace-row-hover-cost");
    expect(block).toHaveTextContent("Amount≈$0.0045");
    expect(block).toHaveTextContent("Input≈$0.0015");
    expect(block).toHaveTextContent("Output≈$0.0030");
    expect(block).toHaveTextContent("SourceEstimated at list price");
  });

  it("shows nothing for a trace recorded without costs", () => {
    render(<TraceTimeline recordedSpans={spans(false)} transcriptMessages={[]} />);
    expect(screen.queryByTestId("trace-cost-summary")).toBeNull();
  });
});

describe("trace cost, flag off", () => {
  async function renderSelectedAndHovered(withCost: boolean) {
    render(
      <TraceTimeline recordedSpans={spans(withCost)} transcriptMessages={[]} />,
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
  });
});
