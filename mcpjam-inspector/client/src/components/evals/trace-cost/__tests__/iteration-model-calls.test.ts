import { describe, expect, it } from "vitest";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  isIterationModelCallsUnavailable,
  iterationCostContext,
  joinModelCalls,
} from "../iteration-model-calls";

const rollup = {
  currency: "USD" as const,
  knownSubtotalUsd: 0.05,
  completeness: "complete" as const,
  totalCalls: 3,
  completeCalls: 3,
  partialCalls: 0,
  unavailableCalls: 0,
  sources: ["list_price" as const],
};

const reported = {
  calculationVersion: 1,
  currency: "USD",
  completeness: "complete",
  amountUsd: 0.01,
  source: "provider_reported",
};

describe("iterationCostContext", () => {
  it("keeps a stored rollup and reads the engine from the run", () => {
    expect(
      iterationCostContext(
        { _id: "it-1", usage: { costRollup: rollup } },
        "harness:claude-code",
      ),
    ).toEqual({ iterationId: "it-1", rollup, harness: true });
    expect(iterationCostContext({ _id: "it-1" }, "emulated").harness).toBe(
      false,
    );
  });

  it("falls back to the iteration's execution record without a run", () => {
    // A record as the backend stores it, with and without a harness.
    const execution = (harness?: object) => ({
      requested: {
        modelId: "anthropic/claude-sonnet-4.5",
        source: "hosted",
        fallback: { provider: "none", model: "none" },
      },
      resolved: {
        rail: "gateway",
        wireModelId: "anthropic/claude-sonnet-4.5",
        offering: { rail: "gateway", providerKey: "gateway" },
      },
      effectiveSettings: { maxOutputTokens: 4096 },
      ...(harness ? { harness } : {}),
    });
    const harnessed = execution({ id: "codex", runtimeVersion: "1.2.3" });

    expect(
      iterationCostContext({ _id: "it-1", execution: harnessed }).harness,
    ).toBe(true);
    expect(
      iterationCostContext({ _id: "it-1", execution: execution() }).harness,
    ).toBe(false);
    expect(iterationCostContext({ _id: "it-1" }).harness).toBe(false);
    // The run's recorded engine wins over the record.
    expect(
      iterationCostContext({ _id: "it-1", execution: harnessed }, "emulated")
        .harness,
    ).toBe(false);
  });

  it.each([
    ["a non-USD currency", { currency: "EUR" }],
    ["an unknown completeness", { completeness: "done" }],
    ["a missing completeness", { completeness: undefined }],
    ["a negative subtotal", { knownSubtotalUsd: -1 }],
    ["a non-finite subtotal", { knownSubtotalUsd: Infinity }],
    ["a string subtotal", { knownSubtotalUsd: "0.05" }],
    ["a fractional call count", { totalCalls: 1.5 }],
    ["a negative complete count", { completeCalls: -1 }],
    ["a missing partial count", { partialCalls: undefined }],
    ["a string unavailable count", { unavailableCalls: "0" }],
    ["sources that are not a list", { sources: "list_price" }],
    ["an unknown source", { sources: ["list_price", "guess"] }],
    ["an inherited key as a source", { sources: ["toString"] }],
  ])("drops a rollup with %s", (_, change) => {
    const usage = { costRollup: { ...rollup, ...change } } as never;
    expect(iterationCostContext({ _id: "it-1", usage })).not.toHaveProperty(
      "rollup",
    );
  });

  it("drops a rollup that is not an object", () => {
    const usage = { costRollup: 0.05 } as never;
    expect(iterationCostContext({ _id: "it-1", usage })).not.toHaveProperty(
      "rollup",
    );
  });
});

describe("joinModelCalls", () => {
  const llm = (id: string, cost?: object): EvalTraceSpan => ({
    id,
    name: "Model",
    category: "llm",
    startMs: 0,
    endMs: 1,
    ...(cost ? { cost: cost as EvalTraceSpan["cost"] } : {}),
  });
  const call = (generationId: string, extra: object = {}) => ({
    generationId,
    modelId: `model-${generationId}`,
    createdAt: 1,
    cost: reported,
    ...extra,
  });

  it("lists only calls no llm span in the trace stands for, with their cost parsed", () => {
    const { unmatched } = joinModelCalls(
      [llm("s0-llm", reported)],
      [
        call("g1", { matchedSpanId: "s0-llm" }),
        call("g2"),
        call("g3", { cost: { ...reported, amountUsd: "x" } }),
        // Matched to a span this trace does not have: listed, so it counts once.
        call("g4", { matchedSpanId: "gone" }),
      ],
    );
    expect(unmatched).toEqual([
      { generationId: "g2", modelId: "model-g2", cost: reported },
      { generationId: "g3", modelId: "model-g3", cost: undefined },
      { generationId: "g4", modelId: "model-g4", cost: reported },
    ]);
    expect(joinModelCalls([], undefined)).toEqual({ spans: [], unmatched: [] });
  });

  it("gives a cost-less span its matched call's cost and keeps a span's own", () => {
    const own = { ...reported, amountUsd: 0.5 };
    const spans = [llm("s0-llm"), llm("s1-llm", own), llm("s2-llm")];
    const joined = joinModelCalls(spans, [
      call("g0", { matchedSpanId: "s0-llm" }),
      call("g1", { matchedSpanId: "s1-llm" }),
      // The same generation reported again is the same call.
      call("g0", { matchedSpanId: "s0-llm", cost: own }),
    ]);
    expect(joined.spans.map((span) => span.cost)).toEqual([
      reported,
      own,
      undefined,
    ]);
    expect(joined.spans[1]).toBe(spans[1]);
    expect(joined.unmatched).toEqual([]);
  });

  it("lists a second billed call on an already joined span, so it still counts once", () => {
    const own = { ...reported, amountUsd: 0.5 };
    const joined = joinModelCalls(
      [llm("s0-llm")],
      [
        call("g0", { matchedSpanId: "s0-llm" }),
        call("g1", { matchedSpanId: "s0-llm", cost: own }),
        call("g1", { matchedSpanId: "s0-llm", cost: own }),
      ],
    );
    expect(joined.spans.map((span) => span.cost)).toEqual([reported]);
    expect(joined.unmatched).toEqual([
      { generationId: "g1", modelId: "model-g1", cost: own },
    ]);
  });
});

describe("isIterationModelCallsUnavailable", () => {
  it("matches only this query not being served", () => {
    const q = "[CONVEX Q(evalIterationModelCalls:list)]";
    expect(
      isIterationModelCallsUnavailable(
        new Error(`${q} Could not find public function`),
      ),
    ).toBe(true);
    expect(
      isIterationModelCallsUnavailable(
        new Error(`${q} [Request ID: 1] Server Error`),
      ),
    ).toBe(true);
    expect(
      isIterationModelCallsUnavailable(
        new Error("[CONVEX Q(other:list)] Server Error"),
      ),
    ).toBe(false);
    expect(
      isIterationModelCallsUnavailable(new Error(`${q} Not a member`)),
    ).toBe(false);
  });
});
