import { describe, expect, it } from "vitest";
import {
  isIterationModelCallsUnavailable,
  iterationCostContext,
  unmatchedModelCalls,
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

  it("drops a rollup that is not one", () => {
    const usage = { costRollup: { ...rollup, currency: "EUR" } } as never;
    expect(iterationCostContext({ _id: "it-1", usage })).not.toHaveProperty(
      "rollup",
    );
  });
});

describe("unmatchedModelCalls", () => {
  it("lists only calls with no span join and parses their cost", () => {
    expect(
      unmatchedModelCalls([
        {
          generationId: "g1",
          modelId: "anthropic/claude-sonnet-4.5",
          createdAt: 1,
          cost: reported,
          matchedSpanId: "span-1",
        },
        {
          generationId: "g2",
          modelId: "anthropic/claude-haiku-4.5",
          createdAt: 2,
          cost: reported,
        },
        {
          generationId: "g3",
          modelId: "openai/gpt-5-mini",
          createdAt: 3,
          cost: { ...reported, amountUsd: undefined },
        },
      ]),
    ).toEqual([
      {
        generationId: "g2",
        modelId: "anthropic/claude-haiku-4.5",
        cost: reported,
      },
      { generationId: "g3", modelId: "openai/gpt-5-mini", cost: undefined },
    ]);
    expect(unmatchedModelCalls(undefined)).toEqual([]);
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
