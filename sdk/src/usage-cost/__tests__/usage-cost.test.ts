import { describe, expect, it } from "vitest";
import {
  aggregateModelCallCosts,
  extractReportedProviderCost,
  normalizeModelUsage,
  parseModelCallCostEvidence,
  parseModelRates,
  parseNormalizedModelUsage,
  priceModelCall,
  toModelCallCostEvidence,
  usdPerTokenToPerMillion,
  type RateEvidence,
} from "../index.js";

const sonnet: RateEvidence = {
  source: "list_price",
  modelId: "anthropic/claude-sonnet-4.5",
  provider: "anthropic",
  versionId: "price-v1",
  rates: {
    currency: "USD",
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    webSearchPerThousand: 10,
    tiers: [
      {
        aboveInputTokens: 200_000,
        input: 6,
        output: 22.5,
        cacheRead: 0.6,
        cacheWrite: 7.5,
        cacheWrite1h: 12,
      },
    ],
  },
};

describe("normalizeModelUsage", () => {
  it("splits AI SDK 7 usage into exclusive buckets and keeps raw extras", () => {
    // Recorded shape from @ai-sdk/anthropic 4.x convertAnthropicUsage.
    const usage = normalizeModelUsage({
      inputTokens: 1_200,
      inputTokenDetails: {
        noCacheTokens: 200,
        cacheReadTokens: 600,
        cacheWriteTokens: 400,
      },
      outputTokens: 300,
      outputTokenDetails: { textTokens: 250, reasoningTokens: 50 },
      totalTokens: 1_500,
      raw: {
        input_tokens: 200,
        cache_creation_input_tokens: 400,
        cache_read_input_tokens: 600,
        cache_creation: {
          ephemeral_5m_input_tokens: 100,
          ephemeral_1h_input_tokens: 300,
        },
        server_tool_use: { web_search_requests: 2 },
        output_tokens: 300,
      },
    });
    expect(usage).toEqual({
      uncachedInputTokens: 200,
      cacheReadTokens: 600,
      cacheWriteTokens: 400,
      cacheWrite1hTokens: 300,
      outputTokens: 300,
      reasoningTokens: 50,
      webSearchRequests: 2,
    });
  });

  it("derives fresh input when the SDK omits noCacheTokens", () => {
    expect(
      normalizeModelUsage({
        inputTokens: 1_000,
        inputTokenDetails: { cacheReadTokens: 800 },
        outputTokens: 10,
        outputTokenDetails: {},
      })
    ).toEqual({
      uncachedInputTokens: 200,
      cacheReadTokens: 800,
      outputTokens: 10,
    });
  });

  it("reads the flat legacy shape and SDK eval aliases", () => {
    expect(
      normalizeModelUsage({
        inputTokens: 100,
        cachedInputTokens: 40,
        outputTokens: 7,
        reasoningTokens: 3,
      })
    ).toEqual({
      uncachedInputTokens: 60,
      cacheReadTokens: 40,
      outputTokens: 7,
      reasoningTokens: 3,
    });
    expect(normalizeModelUsage({ input: 9, output: 1 })).toEqual({
      uncachedInputTokens: 9,
      outputTokens: 1,
    });
  });

  it("returns undefined when nothing usable was reported", () => {
    expect(normalizeModelUsage(undefined)).toBeUndefined();
    expect(normalizeModelUsage({})).toBeUndefined();
    expect(normalizeModelUsage({ inputTokens: Number.NaN })).toBeUndefined();
    expect(normalizeModelUsage({ inputTokens: -1 })).toBeUndefined();
  });

  it("keeps explicit zeros when parsing stored usage", () => {
    expect(
      parseNormalizedModelUsage({
        uncachedInputTokens: 0,
        outputTokens: 0,
        extra: 5,
        cacheReadTokens: "12",
      })
    ).toEqual({ uncachedInputTokens: 0, outputTokens: 0 });
  });
});

describe("extractReportedProviderCost", () => {
  it("reads the Gateway's numeric string and OpenRouter's number", () => {
    expect(
      extractReportedProviderCost({ gateway: { cost: "0.000088" } })
    ).toEqual({
      amountUsd: 0.000088,
      source: "provider_reported",
      reporter: "gateway",
    });
    expect(
      extractReportedProviderCost({ openrouter: { usage: { cost: 0.0123 } } })
    ).toEqual({
      amountUsd: 0.0123,
      source: "provider_reported",
      reporter: "openrouter",
    });
  });

  it("keeps a reported zero and rejects malformed amounts", () => {
    expect(
      extractReportedProviderCost({ gateway: { cost: "0" } })?.amountUsd
    ).toBe(0);
    expect(
      extractReportedProviderCost({ gateway: { cost: "" } })
    ).toBeUndefined();
    expect(
      extractReportedProviderCost({ gateway: { cost: "-1" } })
    ).toBeUndefined();
    expect(
      extractReportedProviderCost({ openrouter: { usage: {} } })
    ).toBeUndefined();
  });
});

describe("priceModelCall", () => {
  it("prices every bucket at its own rate", () => {
    const cost = priceModelCall({
      usage: {
        uncachedInputTokens: 1_000,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 2_000,
        cacheWrite1hTokens: 500,
        outputTokens: 500,
        reasoningTokens: 100,
        webSearchRequests: 1,
      },
      rate: sonnet,
    });
    expect(cost.completeness).toBe("complete");
    expect(cost.source).toBe("list_price");
    expect(cost.parts).toEqual({
      input: 0.003,
      output: 0.0075,
      cacheRead: 0.003,
      cacheWrite: 0.008625,
      webSearch: 0.01,
    });
    // Reasoning is a subset of output and is not charged twice.
    expect(cost.amountUsd).toBe(0.032125);
    expect(cost.rate?.versionId).toBe("price-v1");
  });

  it("prices each request at its own context tier, not the run's total", () => {
    const small = { uncachedInputTokens: 50_000, outputTokens: 1_000 };
    const fiveSmall = aggregateModelCallCosts(
      Array.from({ length: 5 }, () =>
        priceModelCall({ usage: small, rate: sonnet })
      )
    );
    const oneLarge = priceModelCall({
      usage: { uncachedInputTokens: 250_000, outputTokens: 5_000 },
      rate: sonnet,
    });
    expect(fiveSmall.knownSubtotalUsd).toBe(0.825);
    expect(oneLarge.tierAboveInputTokens).toBe(200_000);
    expect(oneLarge.amountUsd).toBe(1.6125);
  });

  it("counts cache tokens toward the context threshold", () => {
    const cost = priceModelCall({
      usage: {
        uncachedInputTokens: 1_000,
        cacheReadTokens: 199_500,
        outputTokens: 0,
      },
      rate: sonnet,
    });
    expect(cost.tierAboveInputTokens).toBe(200_000);
  });

  it("makes the estimate partial instead of pricing an unknown rate at zero", () => {
    const cost = priceModelCall({
      usage: {
        uncachedInputTokens: 100,
        cacheReadTokens: 1_000,
        outputTokens: 10,
      },
      rate: {
        source: "customer_rate",
        modelId: "azure/my-gpt-deployment",
        rates: { currency: "USD", input: 2, output: 8 },
      },
    });
    expect(cost.completeness).toBe("partial");
    expect(cost.missing).toEqual(["cache_read_rate"]);
    expect(cost.amountUsd).toBe(0.00028);
    expect(cost.source).toBe("customer_rate");
  });

  it("marks missing output tokens partial and explicit zeros complete", () => {
    expect(
      priceModelCall({ usage: { uncachedInputTokens: 1_000 }, rate: sonnet })
        .missing
    ).toEqual(["output_tokens"]);
    const zero = priceModelCall({
      usage: { uncachedInputTokens: 0, outputTokens: 0 },
      rate: sonnet,
    });
    expect(zero).toMatchObject({ completeness: "complete", amountUsd: 0 });
  });

  it("prefers provider-reported dollars, even without usage", () => {
    const cost = priceModelCall({
      reported: {
        amountUsd: 0.5,
        source: "provider_reported",
        reporter: "openrouter",
      },
      rate: sonnet,
    });
    expect(cost).toMatchObject({
      completeness: "complete",
      amountUsd: 0.5,
      source: "provider_reported",
      reporter: "openrouter",
    });
    expect(cost.rate).toBeUndefined();
  });

  it("uses runner-reported dollars only when nothing better exists", () => {
    const runner = { amountUsd: 0.2, source: "runner_reported" } as const;
    expect(
      priceModelCall({
        usage: { uncachedInputTokens: 10, outputTokens: 1 },
        reported: runner,
        rate: sonnet,
      }).source
    ).toBe("list_price");
    expect(priceModelCall({ reported: runner }).source).toBe("runner_reported");
  });

  it("explains why a cost is unavailable", () => {
    expect(priceModelCall({})).toMatchObject({
      completeness: "unavailable",
      reason: "no_usage",
    });
    expect(
      priceModelCall({ usage: { uncachedInputTokens: 1, outputTokens: 1 } })
    ).toMatchObject({ completeness: "unavailable", reason: "no_rate" });
    expect(
      priceModelCall({
        usage: { uncachedInputTokens: 1, outputTokens: 1 },
        rate: { ...sonnet, rates: { ...sonnet.rates, input: Number.NaN } },
      })
    ).toMatchObject({ completeness: "unavailable", reason: "invalid_rate" });
    expect(
      priceModelCall({
        usage: { uncachedInputTokens: 1, outputTokens: 1 },
        rate: {
          ...sonnet,
          rates: { ...sonnet.rates, currency: "EUR" as "USD" },
        },
      })
    ).toMatchObject({
      completeness: "unavailable",
      reason: "unsupported_currency",
    });
  });

  it("ignores an invalid reported amount instead of trusting it", () => {
    for (const amountUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        priceModelCall({
          reported: { amountUsd, source: "provider_reported" },
          usage: { uncachedInputTokens: 1_000, outputTokens: 100 },
          rate: sonnet,
        }).source
      ).toBe("list_price");
      expect(
        priceModelCall({ reported: { amountUsd, source: "runner_reported" } })
      ).toMatchObject({ completeness: "unavailable", reason: "no_usage" });
    }
  });

  it("prices one-hour writes reported without a total write count", () => {
    const cost = priceModelCall({
      usage: {
        uncachedInputTokens: 0,
        outputTokens: 0,
        cacheWrite1hTokens: 1_000,
      },
      rate: sonnet,
    });
    expect(cost).toMatchObject({
      completeness: "complete",
      amountUsd: 0.006,
      parts: { cacheWrite: 0.006 },
    });
  });

  it("does not price tiered tokens from a partial input count", () => {
    const cost = priceModelCall({
      usage: { cacheReadTokens: 250_000, outputTokens: 1_000 },
      rate: sonnet,
    });
    expect(cost).toMatchObject({
      completeness: "unavailable",
      missing: ["input_tokens"],
    });
    expect(
      priceModelCall({
        usage: { cacheReadTokens: 0, outputTokens: 1_000 },
        rate: sonnet,
      }).amountUsd
    ).toBeUndefined();
  });

  it("does not price tiered tokens when the request's input is unknown", () => {
    const cost = priceModelCall({
      usage: { outputTokens: 1_000, webSearchRequests: 1 },
      rate: sonnet,
    });
    expect(cost).toMatchObject({
      completeness: "partial",
      amountUsd: 0.01,
      parts: { webSearch: 0.01 },
      missing: ["input_tokens"],
    });
  });

  it("stores a copy of the rate, not the caller's object", () => {
    const rate: RateEvidence = structuredClone(sonnet);
    const cost = priceModelCall({
      usage: { uncachedInputTokens: 1, outputTokens: 1 },
      rate,
    });
    rate.rates.input = 999;
    for (const tier of rate.rates.tiers ?? []) tier.input = 999;
    rate.assumptions = ["edited later"];
    expect(cost.rate?.rates.input).toBe(3);
    expect(cost.rate?.rates.tiers?.[0].input).toBe(6);
    expect(cost.rate?.assumptions).toBeUndefined();
  });

  it("keeps sub-cent amounts exact", () => {
    const cost = priceModelCall({
      usage: { uncachedInputTokens: 7, outputTokens: 3 },
      rate: {
        ...sonnet,
        rates: { currency: "USD", input: 0.075, output: 0.3 },
      },
    });
    expect(cost.amountUsd).toBe(0.000001425);
  });
});

describe("aggregateModelCallCosts", () => {
  it("reports a known subtotal and coverage when some calls are unpriced", () => {
    const priced = priceModelCall({
      usage: { uncachedInputTokens: 1_000, outputTokens: 100 },
      rate: sonnet,
    });
    const rollup = aggregateModelCallCosts([
      priced,
      priced,
      priceModelCall({ usage: { uncachedInputTokens: 1, outputTokens: 1 } }),
      undefined,
    ]);
    expect(rollup).toEqual({
      currency: "USD",
      knownSubtotalUsd: 0.009,
      completeness: "partial",
      totalCalls: 4,
      completeCalls: 2,
      partialCalls: 0,
      unavailableCalls: 2,
      sources: ["list_price"],
    });
  });

  it("sums many small calls without float drift", () => {
    const tiny = priceModelCall({
      reported: { amountUsd: 0.1, source: "provider_reported" },
    });
    const rollup = aggregateModelCallCosts(
      Array.from({ length: 10 }, () => tiny)
    );
    expect(rollup.knownSubtotalUsd).toBe(1);
  });

  it("is unavailable when nothing is priced and complete when all are", () => {
    expect(aggregateModelCallCosts([priceModelCall({})]).completeness).toBe(
      "unavailable"
    );
    expect(aggregateModelCallCosts([]).completeness).toBe("complete");
  });
});

describe("usdPerTokenToPerMillion", () => {
  it("converts Gateway per-token rates without float noise", () => {
    expect(usdPerTokenToPerMillion(3e-6)).toBe(3);
    expect(usdPerTokenToPerMillion(3.75e-7)).toBe(0.375);
    expect(usdPerTokenToPerMillion(1.25e-7)).toBe(0.125);
  });
});

describe("parseModelCallCostEvidence", () => {
  it("round-trips evidence built from a priced call", () => {
    const cost = priceModelCall({
      usage: {
        uncachedInputTokens: 300_000,
        outputTokens: 10,
        cacheReadTokens: 5,
      },
      rate: sonnet,
    });
    const evidence = toModelCallCostEvidence(cost, {
      usage: {
        uncachedInputTokens: 300_000,
        outputTokens: 10,
        cacheReadTokens: 5,
      },
      usageSource: "provider",
      funding: "customer",
      recordedAt: 1_700_000_000_000,
    });
    const wire = JSON.parse(JSON.stringify(evidence));
    expect(parseModelCallCostEvidence(wire)).toEqual(evidence);
  });

  it("rejects incoherent records instead of showing a wrong number", () => {
    const base = { calculationVersion: 1, currency: "USD" };
    expect(
      parseModelCallCostEvidence({ ...base, completeness: "complete" })
    ).toBeUndefined();
    expect(
      parseModelCallCostEvidence({
        ...base,
        completeness: "unavailable",
        amountUsd: 0,
      })
    ).toBeUndefined();
    expect(
      parseModelCallCostEvidence({
        ...base,
        completeness: "done",
        amountUsd: 1,
      })
    ).toBeUndefined();
    expect(
      parseModelCallCostEvidence({
        ...base,
        currency: "EUR",
        completeness: "complete",
        amountUsd: 1,
      })
    ).toBeUndefined();
  });

  it("rejects an amount that does not say where it came from", () => {
    const priced = {
      calculationVersion: 1,
      currency: "USD",
      amountUsd: 0.0042,
    };
    for (const completeness of ["complete", "partial"]) {
      expect(
        parseModelCallCostEvidence({ ...priced, completeness })
      ).toBeUndefined();
      expect(
        parseModelCallCostEvidence({
          ...priced,
          completeness,
          source: "guessed",
        })
      ).toBeUndefined();
    }
  });

  it("needs no source on an unavailable record", () => {
    expect(
      parseModelCallCostEvidence({
        calculationVersion: 1,
        currency: "USD",
        completeness: "unavailable",
        reason: "no_rate",
      })
    ).toEqual({
      calculationVersion: 1,
      currency: "USD",
      completeness: "unavailable",
      reason: "no_rate",
    });
  });

  it("drops unknown optional enum members and keeps an explicit zero", () => {
    expect(
      parseModelCallCostEvidence({
        calculationVersion: 1,
        currency: "USD",
        completeness: "complete",
        amountUsd: 0,
        source: "provider_reported",
        funding: "guessed",
        usageSource: "guessed",
      })
    ).toEqual({
      calculationVersion: 1,
      currency: "USD",
      completeness: "complete",
      amountUsd: 0,
      source: "provider_reported",
    });
  });
});

describe("parseModelRates", () => {
  it("keeps a full rate card, tiers included", () => {
    expect(parseModelRates(JSON.parse(JSON.stringify(sonnet.rates)))).toEqual(
      sonnet.rates
    );
  });

  it("refuses a card without input and output or in another currency", () => {
    expect(parseModelRates({ currency: "USD", input: 3 })).toBeUndefined();
    expect(
      parseModelRates({ currency: "EUR", input: 3, output: 15 })
    ).toBeUndefined();
    expect(parseModelRates("3/15")).toBeUndefined();
  });

  it("drops an invalid optional rate rather than reading it as zero", () => {
    expect(
      parseModelRates({
        currency: "USD",
        input: 3,
        output: 15,
        cacheRead: -1,
        cacheWrite: "3.75",
      })
    ).toEqual({ currency: "USD", input: 3, output: 15 });
  });
});
