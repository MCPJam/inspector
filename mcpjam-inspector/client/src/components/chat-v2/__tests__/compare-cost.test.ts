import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  aggregateModelCallCosts,
  type ModelCallCostEvidence,
  type ModelCostRollup,
} from "@mcpjam/sdk/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { LiveChatTraceEnvelope } from "@/shared/live-chat-trace";
import type { MultiModelCardSummary } from "../model-compare-card-header";
import {
  costWinnerLabel,
  latestTurnCost,
  useLatestTurnCost,
} from "../compare-cost";

const flag = vi.hoisted(() => ({ on: true }));
vi.mock("@/hooks/useTraceCostEnabled", () => ({
  useTraceCostEnabled: () => flag.on,
}));

afterEach(() => {
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
  status: MultiModelCardSummary["status"] = "ready",
  broadcastId = 1,
): MultiModelCardSummary {
  return {
    modelId,
    durationMs: 1200,
    tokens: 900,
    toolCount: 0,
    status,
    hasMessages: true,
    broadcastId,
    ...(cost ? { cost } : {}),
  };
}

/** The same card after a follow-up sent to it alone: it answers no broadcast. */
const followUp = (summary: MultiModelCardSummary): MultiModelCardSummary => ({
  ...summary,
  broadcastId: undefined,
});

const listPrice = { source: "list_price" as const };
const yourRates = { source: "customer_rate" as const };

describe("costWinnerLabel", () => {
  it("names the cheapest card when every card's turn is complete and provider-reported", () => {
    const cards = [
      card("a", rollup(call(0.004), call(0.002))),
      card("b", rollup(call(0.0051))),
      card("c", rollup(call(0.012))),
    ];
    expect(cards.map((item) => costWinnerLabel(item, cards))).toEqual([
      undefined,
      "Lowest cost",
      undefined,
    ]);
  });

  it("qualifies the winner when every card is estimated, at list price or at your rates", () => {
    const cards = [
      card("a", rollup(call(0.003, listPrice))),
      card("b", rollup(call(0.002, yourRates), call(0.0005, listPrice))),
    ];
    expect(costWinnerLabel(cards[1], cards)).toBe("Lowest estimated cost");
    expect(costWinnerLabel(cards[0], cards)).toBeUndefined();
  });

  it("names every card that ties at full precision", () => {
    const cards = [
      card("a", rollup(call(0.0021))),
      card("b", rollup(call(0.0021))),
    ];
    expect(cards.map((item) => costWinnerLabel(item, cards))).toEqual([
      "Lowest cost",
      "Lowest cost",
    ]);
  });

  it("keeps an explicitly reported $0 as the lowest cost", () => {
    const cards = [card("a", rollup(call(0))), card("b", rollup(call(0.001)))];
    expect(costWinnerLabel(cards[0], cards)).toBe("Lowest cost");
  });

  const cheap = rollup(call(0.001));
  const dear = rollup(call(0.009));
  it.each<[string, MultiModelCardSummary]>([
    ["a partial turn", card("b", rollup(call(0.004), call(undefined)))],
    [
      "a turn with a partly priced call",
      card(
        "b",
        rollup(
          call(0.004, {
            completeness: "partial",
            missing: ["cache_write_rate"],
          }),
        ),
      ),
    ],
    ["an unavailable turn", card("b", rollup(call(undefined)))],
    ["a turn with no cost evidence", card("b", undefined)],
    ["a failed turn", card("b", dear, "error")],
    ["a stopped turn", card("b", dear, "cancelled")],
    ["a running turn", card("b", dear, "running")],
    ["a card that has not run", card("b", undefined, "idle")],
    [
      "an estimate against a reported amount",
      card("b", rollup(call(0.009, listPrice))),
    ],
    [
      "a turn mixing reported and estimated calls",
      card("b", rollup(call(0.004), call(0.004, listPrice))),
    ],
    [
      "a runner-reported turn",
      card("b", rollup(call(0.009, { source: "runner_reported" }))),
    ],
    [
      "a card whose latest turn answered a follow-up",
      followUp(card("b", dear)),
    ],
    [
      "a card whose latest turn answered another broadcast",
      card("b", dear, "ready", 2),
    ],
  ])("names no winner beside %s", (_label, other) => {
    const cards = [card("a", cheap), other];
    expect(cards.map((item) => costWinnerLabel(item, cards))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("names no winner with a single card", () => {
    const cards = [card("a", cheap)];
    expect(costWinnerLabel(cards[0], cards)).toBeUndefined();
  });

  it("names no winner for a card whose own turn has moved on", () => {
    const cards = [card("a", cheap), card("b", dear)];
    expect(costWinnerLabel(card("a", cheap, "running"), cards)).toBeUndefined();
    expect(
      costWinnerLabel(card("a", cheap, "ready", 2), cards),
    ).toBeUndefined();
  });

  it("names the cheaper card when both answered the same broadcast", () => {
    const cards = [card("a", cheap, "ready", 7), card("b", dear, "ready", 7)];
    expect(cards.map((item) => costWinnerLabel(item, cards))).toEqual([
      "Lowest cost",
      undefined,
    ]);
  });

  it("names no winner when each card answered its own follow-up", () => {
    // Both are the thread's second prompt, but not the same prompt.
    const cards = [followUp(card("a", cheap)), followUp(card("b", dear))];
    expect(cards.map((item) => costWinnerLabel(item, cards))).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("names a winner again once every card answers the next broadcast", () => {
    const afterFollowUp = [followUp(card("a", cheap)), card("b", dear)];
    expect(costWinnerLabel(afterFollowUp[0], afterFollowUp)).toBeUndefined();

    const cards = [card("a", cheap, "ready", 2), card("b", dear, "ready", 2)];
    expect(costWinnerLabel(cards[0], cards)).toBe("Lowest cost");
  });
});

function span(
  promptIndex: number,
  stepIndex: number,
  cost?: ModelCallCostEvidence,
): EvalTraceSpan[] {
  const id = `p${promptIndex}-s${stepIndex}`;
  const base = {
    startMs: 0,
    endMs: 500,
    promptIndex,
    stepIndex,
    totalTokens: 120,
  };
  return [
    { ...base, id, name: "Step", category: "step" },
    {
      ...base,
      id: `${id}-llm`,
      parentId: id,
      name: "LLM",
      category: "llm",
      ...(cost ? { cost } : {}),
    },
  ];
}

function trace(spans: EvalTraceSpan[], promptIndexes: number[]) {
  return {
    spans,
    turns: promptIndexes.map((promptIndex) => ({
      turnId: `turn-${promptIndex}`,
      promptIndex,
      durationMs: 500,
    })),
  } satisfies Pick<LiveChatTraceEnvelope, "turns" | "spans">;
}

describe("latestTurnCost", () => {
  it("sums only the latest turn's llm spans", () => {
    const spans = [
      ...span(0, 0, call(0.5)),
      ...span(1, 0, call(0.002)),
      ...span(1, 1, call(undefined)),
    ];
    expect(latestTurnCost(trace(spans, [0, 1]))).toMatchObject({
      knownSubtotalUsd: 0.002,
      completeness: "partial",
      totalCalls: 2,
      unavailableCalls: 1,
    });
  });

  it("has no cost for a turn with no cost evidence or no turns", () => {
    const spans = [...span(0, 0, call(0.5)), ...span(1, 0)];
    expect(latestTurnCost(trace(spans, [0, 1]))).toBeUndefined();
    expect(latestTurnCost(trace(spans, []))).toBeUndefined();
    expect(latestTurnCost(null)).toBeUndefined();
  });
});

describe("useLatestTurnCost", () => {
  it("returns the same object until the cost changes", () => {
    const spans = span(0, 0, call(0.002));
    const { result, rerender } = renderHook(
      ({ value }) => useLatestTurnCost(value),
      { initialProps: { value: trace(spans, [0]) } },
    );
    const first = result.current;
    expect(first?.knownSubtotalUsd).toBe(0.002);

    // A streamed token rebuilds the trace without changing any cost.
    rerender({ value: trace([...span(0, 0, call(0.002))], [0]) });
    expect(result.current).toBe(first);

    rerender({ value: trace([...spans, ...span(0, 1, call(0.001))], [0]) });
    expect(result.current).not.toBe(first);
    expect(result.current?.knownSubtotalUsd).toBeCloseTo(0.003, 12);
  });

  it("returns nothing while trace-cost is off", () => {
    flag.on = false;
    const { result } = renderHook(() =>
      useLatestTurnCost(trace(span(0, 0, call(0.002)), [0])),
    );
    expect(result.current).toBeUndefined();
  });
});
