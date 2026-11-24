import { beforeEach, describe, expect, it, vi } from "vitest";

const prices = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("../../../utils/call-cost/list-price-catalog.js", () => ({ getListPrices: async () => ({ get: prices.get }) }));
vi.mock("../../../utils/call-cost/direct-call-pricer.js", () => ({ listPriceModelId: (_provider: string, model: string) => (model.startsWith("claude") ? model : undefined) }));

import { estimateTurnSpend } from "../picker-spend.js";

const rate = { source: "list_price" as const, modelId: "claude-haiku-4.5", rates: { currency: "USD" as const, input: 1, output: 5 } };
const llm = (amountUsd?: number) => ({ category: "llm", ...(amountUsd === undefined ? {} : { cost: { amountUsd } }) });

describe("what a picker turn cost", () => {
  beforeEach(() => prices.get.mockReset());

  it("adds the prices on the turn's own calls, and its tokens", async () => {
    const spend = await estimateTurnSpend({ usage: { inputTokens: 900, outputTokens: 100 }, turnTrace: { spans: [llm(0.01), llm(0.03), { category: "tool" }] } } as never, "anthropic/claude-haiku-4.5");
    expect(spend).toEqual({ tokens: 1000, estimatedCostUsd: 0.04 });
    expect(prices.get).not.toHaveBeenCalled();
  });

  it("prices a call that carries no price from the model's list price", async () => {
    prices.get.mockReturnValue(rate);
    const spend = await estimateTurnSpend({ usage: { inputTokens: 1_000_000, outputTokens: 100_000 }, turnTrace: { spans: [llm()] } } as never, "anthropic/claude-haiku-4.5");
    expect(prices.get).toHaveBeenCalledWith("claude-haiku-4.5");
    expect(spend.tokens).toBe(1_100_000);
    expect(spend.estimatedCostUsd).toBeCloseTo(1.5, 5);
  });

  it("reports tokens at zero dollars, never a guess, when nothing can price the turn", async () => {
    const spend = await estimateTurnSpend({ usage: { inputTokens: 500, outputTokens: 50 }, turnTrace: { spans: [llm()] } } as never, "someone/unlisted-model");
    expect(spend).toEqual({ tokens: 550, estimatedCostUsd: 0 });
  });

  it("reports nothing for a turn that used nothing", async () => {
    expect(await estimateTurnSpend({} as never, "anthropic/claude-haiku-4.5")).toEqual({ tokens: 0, estimatedCostUsd: 0 });
  });
});
