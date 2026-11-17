import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import {
  aggregateModelCallCosts,
  type ModelCallCostEvidence,
  type ModelCostRollup,
} from "@mcpjam/sdk/browser";
import { formatModelCost } from "@/components/evals/trace-cost/cost-view";
import {
  ModelCompareCardHeader,
  type MultiModelCardSummary,
} from "../model-compare-card-header";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));

afterEach(() => {
  cleanup();
  flag.on = true;
});

function call(
  amountUsd: number | undefined,
  overrides: Partial<ModelCallCostEvidence> = {},
): ModelCallCostEvidence {
  return {
    calculationVersion: 1,
    currency: "USD",
    completeness: amountUsd === undefined ? "unavailable" : "complete",
    ...(amountUsd === undefined
      ? { reason: "no_rate" as const }
      : { amountUsd, source: "provider_reported" as const }),
    ...overrides,
  };
}

const rollup = (...calls: ModelCallCostEvidence[]): ModelCostRollup =>
  aggregateModelCallCosts(calls);

function card(
  modelId: string,
  cost: ModelCostRollup | undefined,
  overrides: Partial<MultiModelCardSummary> = {},
): MultiModelCardSummary {
  return {
    modelId,
    durationMs: 1200,
    tokens: 900,
    toolCount: 1,
    status: "ready",
    hasMessages: true,
    broadcastId: 1,
    ...(cost ? { cost } : {}),
    ...overrides,
  };
}

function Header({
  summary,
  allSummaries,
}: {
  summary: MultiModelCardSummary;
  allSummaries: MultiModelCardSummary[];
}) {
  return (
    <ModelCompareCardHeader
      modelLabel={summary.modelId}
      summary={summary}
      allSummaries={allSummaries}
      mode="chat"
      onModeChange={vi.fn()}
      showTraceTabs={false}
    />
  );
}

function renderCards(cards: MultiModelCardSummary[]) {
  return render(
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 280px)" }}>
      {cards.map((summary) => (
        <div key={summary.modelId} data-testid={`card-${summary.modelId}`}>
          <Header summary={summary} allSummaries={cards} />
        </div>
      ))}
    </div>,
  );
}

const costRow = (modelId: string) =>
  within(screen.getByTestId(`card-${modelId}`)).getByTestId("compare-cost-row");

const withoutCost = (cards: MultiModelCardSummary[]) =>
  cards.map((summary) => ({ ...summary, cost: undefined }));

describe("CompareCostRow in the compare header", () => {
  const listPrice = { source: "list_price" as const };
  const mixed = [
    card("reported", rollup(call(0.0042), call(0.0009))),
    card("estimated", rollup(call(0.0031, listPrice))),
    card("partial", rollup(call(0.002), call(0.001), call(undefined))),
  ];

  it("renders today's header while trace-cost is off", () => {
    flag.on = false;
    const { container: priced } = renderCards(mixed);
    const pricedHtml = priced.innerHTML;
    cleanup();
    const { container: plain } = renderCards(withoutCost(mixed));
    expect(pricedHtml).toBe(plain.innerHTML);
    expect(screen.queryByTestId("compare-cost-row")).not.toBeInTheDocument();
  });

  it("adds only the Cost row when trace-cost is on", () => {
    const { container: on } = renderCards(mixed);
    on.querySelectorAll('[data-testid="compare-cost-row"]').forEach((row) =>
      row.remove(),
    );
    const onHtml = on.innerHTML;
    cleanup();
    flag.on = false;
    const { container: off } = renderCards(mixed);
    expect(onHtml).toBe(off.innerHTML);
  });

  it("labels the latest turn's amount with the trace's formatting, and names the cheapest reported card", () => {
    const cards = [
      card("a", rollup(call(0.0042), call(0.0009))),
      card("b", rollup(call(1.5))),
      card("c", rollup(call(0.00004))),
    ];
    renderCards(cards);

    expect(costRow("a")).toHaveTextContent(formatModelCost(0.0051));
    expect(costRow("b")).toHaveTextContent("$1.50");
    expect(costRow("c")).toHaveTextContent("<$0.0001");
    for (const id of ["a", "b", "c"]) {
      expect(costRow(id)).toHaveTextContent("Latest turn");
    }
    expect(costRow("c")).toHaveTextContent("Lowest cost");
    expect(screen.getAllByText("Lowest cost")).toHaveLength(1);
  });

  it("marks estimates and names an estimated winner as such", () => {
    const cards = [
      card("a", rollup(call(0.0031, listPrice))),
      card("b", rollup(call(0.0024, { source: "customer_rate" }))),
    ];
    renderCards(cards);

    expect(costRow("a")).toHaveTextContent("≈$0.0031");
    expect(
      within(costRow("a")).getByTitle("Estimated at list price"),
    ).toBeInTheDocument();
    expect(costRow("b")).toHaveTextContent("Lowest estimated cost");
    expect(screen.queryByText("Lowest cost")).not.toBeInTheDocument();
  });

  it("shows coverage for a partial turn and names no winner", () => {
    renderCards(mixed);

    expect(costRow("partial")).toHaveTextContent("$0.0030");
    expect(costRow("partial")).toHaveTextContent("Partial");
    expect(costRow("partial")).toHaveTextContent("2 of 3 calls priced");
    expect(costRow("reported")).not.toHaveTextContent("calls priced");
    expect(screen.queryByText(/^Lowest/)).not.toBeInTheDocument();
  });

  it("says the cost is unavailable when nothing is priced, and waits on a card that has not run", () => {
    renderCards([
      card("none", rollup(call(undefined))),
      card("legacy", undefined),
      card("idle", undefined, { status: "idle", hasMessages: false }),
    ]);

    expect(costRow("none")).toHaveTextContent("Cost unavailable");
    expect(costRow("none")).toHaveTextContent("0 of 1 call priced");
    expect(costRow("legacy")).toHaveTextContent("Cost unavailable");
    expect(costRow("idle")).toHaveTextContent("—");
    expect(costRow("idle")).not.toHaveTextContent("Cost unavailable");
  });

  it("keeps a failed card's amount but names no winner", () => {
    const cards = [
      card("a", rollup(call(0.004))),
      card("b", rollup(call(0.001)), { status: "error" }),
    ];
    renderCards(cards);

    expect(costRow("b")).toHaveTextContent("$0.0010");
    expect(screen.queryByText(/^Lowest/)).not.toBeInTheDocument();
  });

  it("shows a running card's subtotal with a spinner and names no winner", () => {
    const cards = [
      card("a", rollup(call(0.004))),
      card("b", rollup(call(0.001)), { status: "running" }),
    ];
    renderCards(cards);

    expect(costRow("b")).toHaveTextContent("$0.0010");
    expect(
      within(costRow("b")).getByTestId("metric-running-spinner"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Lowest/)).not.toBeInTheDocument();
  });

  it("fits three narrow cards: the amount stays on one line and the notes wrap under the bar", () => {
    const cards = [
      card("anthropic/claude-sonnet-4.5", rollup(call(0.0042, listPrice))),
      card(
        "openai/gpt-5-mini",
        rollup(call(0.0012, listPrice), call(0.0002, listPrice)),
      ),
      card(
        "google/gemini-2.5-flash",
        rollup(call(0.0019, listPrice), call(undefined)),
      ),
    ];
    renderCards(cards);

    expect(screen.getAllByTestId("compare-cost-row")).toHaveLength(3);
    for (const { modelId } of cards) {
      const row = costRow(modelId);
      const amount = row.querySelector(".tabular-nums .whitespace-nowrap");
      expect(amount).not.toBeNull();
      expect(row.lastElementChild).toHaveClass("flex-wrap");
    }
    // The partial card disqualifies the comparison, so the cheapest card has no label.
    expect(costRow("openai/gpt-5-mini")).toHaveTextContent("≈$0.0014");
    expect(costRow("google/gemini-2.5-flash")).toHaveTextContent(
      "Partial·1 of 2 calls priced",
    );
    expect(screen.queryByText(/^Lowest/)).not.toBeInTheDocument();
  });
});
