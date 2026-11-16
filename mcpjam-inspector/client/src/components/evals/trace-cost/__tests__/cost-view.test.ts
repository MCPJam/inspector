import { describe, expect, it } from "vitest";
import type { ModelCallCostEvidence } from "@mcpjam/sdk/browser";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  describeRowCost,
  formatModelCost,
  rollupLlmSpanCosts,
  selectRowCost,
} from "../cost-view";

const reported: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd: 0.0021,
  source: "provider_reported",
};
const estimate: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "partial",
  amountUsd: 0.0045,
  source: "list_price",
  parts: { input: 0.0015, output: 0.003 },
  missing: ["cache_write_rate", "web_search_rate"],
};
const unpriced: ModelCallCostEvidence = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "unavailable",
  reason: "no_rate",
};

function llm(
  id: string,
  cost?: ModelCallCostEvidence,
  promptIndex?: number,
): EvalTraceSpan {
  return {
    id,
    name: "LLM",
    category: "llm",
    startMs: 0,
    endMs: 10,
    ...(promptIndex === undefined ? {} : { promptIndex }),
    ...(cost ? { cost } : {}),
  };
}

describe("formatModelCost", () => {
  it.each([
    [0, "$0.00"],
    [0.00004, "<$0.0001"],
    [0.0001, "$0.0001"],
    [0.0088, "$0.0088"],
    [0.0126, "$0.0126"],
    [0.9, "$0.9000"],
    [0.99994, "$0.9999"],
    [0.99996, "$1.00"],
    [1, "$1.00"],
    [1234.567, "$1,234.57"],
  ])("formats %s as %s", (amount, expected) => {
    expect(formatModelCost(amount)).toBe(expected);
  });
});

describe("rollupLlmSpanCosts", () => {
  it("shows nothing for a trace recorded before costs were captured", () => {
    expect(rollupLlmSpanCosts([llm("a"), llm("b")])).toBeUndefined();
  });

  it("sums llm spans only and counts a call without evidence as unpriced", () => {
    const step: EvalTraceSpan = {
      id: "s",
      name: "Step 1",
      category: "step",
      startMs: 0,
      endMs: 10,
      cost: reported,
    };
    const rollup = rollupLlmSpanCosts([step, llm("a", reported), llm("b")]);
    expect(rollup).toMatchObject({
      knownSubtotalUsd: 0.0021,
      completeness: "partial",
      totalCalls: 2,
      unavailableCalls: 1,
    });
    expect(describeRowCost({ kind: "rollup", rollup: rollup! })).toMatchObject({
      amountUsd: 0.0021,
      estimated: false,
      sourceLabel: "Provider-reported",
      completeness: "partial",
      coverage: "1 of 2 calls priced",
    });
  });

  it("is unavailable, with no amount, when no call is priced", () => {
    const rollup = rollupLlmSpanCosts([llm("a", unpriced), llm("b", unpriced)]);
    const view = describeRowCost({ kind: "rollup", rollup: rollup! });
    expect(view.completeness).toBe("unavailable");
    expect(view.amountUsd).toBeUndefined();
    expect(view.coverage).toBe("0 of 2 calls priced");
  });

  it("keeps an explicitly reported zero as $0.00, complete", () => {
    const zero = { ...reported, amountUsd: 0 };
    const view = describeRowCost({
      kind: "rollup",
      rollup: rollupLlmSpanCosts([llm("a", zero)])!,
    });
    expect(view).toMatchObject({
      amountUsd: 0,
      completeness: "complete",
      coverage: "1 of 1 call priced",
    });
  });

  it("marks a sum with any estimate and names mixed sources", () => {
    const rollup = rollupLlmSpanCosts([llm("a", reported), llm("b", estimate)])!;
    expect(rollup.knownSubtotalUsd).toBe(0.0066);
    expect(describeRowCost({ kind: "rollup", rollup })).toMatchObject({
      estimated: true,
      sourceLabel: "Reported and estimated",
      coverage: "2 of 2 calls priced, 1 partly",
    });
  });
});

describe("selectRowCost", () => {
  const spans = [llm("a", reported, 0), llm("b", estimate, 1), llm("c", reported)];

  it("reads one llm span's evidence as-is", () => {
    expect(selectRowCost({ kind: "span", span: spans[1] }, spans)).toEqual({
      kind: "call",
      cost: estimate,
    });
    expect(
      selectRowCost({ kind: "span", span: { ...spans[1], category: "step" } }, spans),
    ).toBeUndefined();
    expect(selectRowCost({ kind: "interaction" }, spans)).toBeUndefined();
  });

  it("sums a prompt's calls, treating a missing prompt index as prompt 0", () => {
    const cost = selectRowCost({ kind: "prompt", promptIndex: 0 }, spans);
    expect(cost?.kind === "rollup" && cost.rollup.totalCalls).toBe(2);
    expect(cost?.kind === "rollup" && cost.rollup.knownSubtotalUsd).toBe(0.0042);
  });
});

describe("describeRowCost for one call", () => {
  it("labels an estimate, lists its parts and what it excludes", () => {
    expect(describeRowCost({ kind: "call", cost: estimate })).toEqual({
      amountUsd: 0.0045,
      estimated: true,
      sourceLabel: "Estimated at list price",
      completeness: "partial",
      note: "Excludes cache writes, web searches.",
      parts: [
        { label: "Input", amountUsd: 0.0015 },
        { label: "Output", amountUsd: 0.003 },
      ],
    });
  });

  it("explains why a call is unavailable", () => {
    expect(describeRowCost({ kind: "call", cost: unpriced })).toMatchObject({
      amountUsd: undefined,
      completeness: "unavailable",
      note: "No price is on record for this model.",
    });
    const invalid = { ...unpriced, reason: "invalid_rate" as const };
    expect(describeRowCost({ kind: "call", cost: invalid }).note).toBe(
      "The price on record for this model was invalid. An organization admin can set a price under Model prices to price future calls.",
    );
  });

  it("names customer rates and runner reports", () => {
    const label = (source: ModelCallCostEvidence["source"]) =>
      describeRowCost({ kind: "call", cost: { ...reported, source } }).sourceLabel;
    expect(label("customer_rate")).toBe("Estimated at your rates");
    expect(label("runner_reported")).toBe("Runner-reported");
  });
});
