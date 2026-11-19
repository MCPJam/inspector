import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDirectCallPricer,
  listPriceModelId,
} from "../direct-call-pricer.js";
import { __resetListPricesForTests } from "../list-price-catalog.js";
import { localRateOverrides } from "../local-rate-overrides.js";

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

const SONNET_PRICE = {
  modelId: "anthropic/claude-sonnet-4.5",
  provider: "anthropic",
  versionId: "price-v7",
  retrievedAt: 1_760_000_000_000,
  rates: {
    currency: "USD",
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
};

const PRICES = {
  catalogVersion: "v7",
  generatedAt: 1_760_000_000_000,
  prices: [SONNET_PRICE],
};

/** AI SDK 7 per-step usage with cache reads and writes. */
const anthropicStepUsage = {
  inputTokens: 1_600,
  inputTokenDetails: {
    noCacheTokens: 1_000,
    cacheReadTokens: 400,
    cacheWriteTokens: 200,
  },
  outputTokens: 500,
  outputTokenDetails: { textTokens: 500, reasoningTokens: 0 },
  totalTokens: 2_100,
};

describe("createDirectCallPricer", () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.CONVEX_HTTP_URL;
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rate-overrides-"));
    process.env.MCPJAM_MODEL_RATE_OVERRIDES_FILE = join(dir, "rates.json");
    process.env.CONVEX_HTTP_URL = "https://convex.example";
    __resetListPricesForTests();
    fetchMock = vi.fn(async () => Response.json(PRICES));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.CONVEX_HTTP_URL;
    else process.env.CONVEX_HTTP_URL = originalUrl;
    delete process.env.MCPJAM_MODEL_RATE_OVERRIDES_FILE;
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  const sonnet = () =>
    createDirectCallPricer({
      providerKey: "anthropic",
      modelId: "claude-sonnet-4-5",
      now: () => NOW,
    });

  it("prices a direct Anthropic call with cache tokens at the list price", async () => {
    const cost = await sonnet()({
      usage: anthropicStepUsage,
      providerMetadata: undefined,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://convex.example/model-prices",
      expect.anything(),
    );
    expect(cost).toMatchObject({
      completeness: "complete",
      source: "list_price",
      funding: "customer",
      usageSource: "provider",
      recordedAt: NOW,
      usage: {
        uncachedInputTokens: 1_000,
        cacheReadTokens: 400,
        cacheWriteTokens: 200,
        outputTokens: 500,
      },
      rate: {
        source: "list_price",
        modelId: "anthropic/claude-sonnet-4.5",
        versionId: "price-v7",
      },
    });
    // 1000 × $3 + 400 × $0.30 + 200 × $3.75 + 500 × $15, per million.
    expect(cost.parts).toEqual({
      input: 0.003,
      cacheRead: 0.00012,
      cacheWrite: 0.00075,
      output: 0.0075,
    });
    expect(cost.amountUsd).toBeCloseTo(0.01137, 12);
  });

  it("keeps dollars OpenRouter reported over any rate", async () => {
    await localRateOverrides.set({
      providerKey: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
      rates: { input: 1, output: 1 },
      effectiveAt: NOW - 30 * DAY,
    });
    const pricer = createDirectCallPricer({
      providerKey: "openrouter",
      modelId: "anthropic/claude-sonnet-4.5",
    });

    const cost = await pricer({
      usage: anthropicStepUsage,
      providerMetadata: { openrouter: { usage: { cost: 0.0123 } } },
    });

    expect(cost).toMatchObject({
      completeness: "complete",
      amountUsd: 0.0123,
      source: "provider_reported",
      reporter: "openrouter",
      funding: "customer",
    });
    expect(cost.rate).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers a local override in force over the list price", async () => {
    const saved = await localRateOverrides.set({
      providerKey: "anthropic",
      modelId: "anthropic/claude-sonnet-4.5",
      rates: { input: 2, output: 10 },
      effectiveAt: NOW - 10 * DAY,
    });

    const cost = await sonnet()({
      usage: { inputTokens: 1_000_000, outputTokens: 100_000 },
      providerMetadata: {},
    });

    expect(cost).toMatchObject({
      completeness: "complete",
      amountUsd: 3,
      source: "customer_rate",
      rate: {
        source: "customer_rate",
        provider: "anthropic",
        versionId: saved.rateId,
        effectiveAt: NOW - 10 * DAY,
      },
    });
  });

  it("records a call that already ran unchanged when its rate is edited", async () => {
    await localRateOverrides.set({
      providerKey: "ollama",
      modelId: "llama3.2",
      rates: { input: 0.1, output: 0.2 },
      effectiveAt: NOW - 10 * DAY,
    });
    const pricer = createDirectCallPricer({
      providerKey: "ollama",
      modelId: "llama3.2",
      now: () => NOW,
    });
    const recorded = await pricer({
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      providerMetadata: undefined,
    });
    const snapshot = structuredClone(recorded);

    await localRateOverrides.set({
      providerKey: "ollama",
      modelId: "llama3.2",
      rates: { input: 5, output: 5 },
      effectiveAt: NOW - 10 * DAY,
    });

    expect(recorded).toEqual(snapshot);
    expect(recorded.amountUsd).toBeCloseTo(0.3, 12);
  });

  it("leaves an Ollama call without an override unavailable, without fetching prices", async () => {
    const pricer = createDirectCallPricer({
      providerKey: "ollama",
      modelId: "llama3.2",
    });

    const cost = await pricer({
      usage: { inputTokens: 10, outputTokens: 5 },
      providerMetadata: undefined,
    });

    expect(cost).toMatchObject({
      completeness: "unavailable",
      reason: "no_rate",
      funding: "customer",
    });
    expect(cost.amountUsd).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the backend answers 500",
      async () => new Response("down", { status: 500 }),
    ],
    ["the fetch throws", async () => Promise.reject(new Error("ECONNRESET"))],
    ["the body is not a price list", async () => Response.json({ items: [] })],
  ])("leaves the call unavailable when %s", async (_case, answer) => {
    fetchMock.mockImplementation(answer);

    const cost = await sonnet()({
      usage: anthropicStepUsage,
      providerMetadata: undefined,
    });

    expect(cost).toMatchObject({
      completeness: "unavailable",
      reason: "no_rate",
    });
  });

  it("stops waiting for a stalled price fetch so the step can finish", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));

    const pending = sonnet()({
      usage: anthropicStepUsage,
      providerMetadata: undefined,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(pending).resolves.toMatchObject({
      completeness: "unavailable",
      reason: "no_rate",
    });
  });
});

describe("listPriceModelId", () => {
  it("maps a reviewed native id to its canonical id", () => {
    expect(listPriceModelId("anthropic", "claude-sonnet-4-5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
    expect(listPriceModelId("openai", "gpt-4o")).toBe("openai/gpt-4o");
    expect(listPriceModelId("anthropic", "anthropic/claude-sonnet-4.5")).toBe(
      "anthropic/claude-sonnet-4.5",
    );
  });

  it.each([
    ["azure", "gpt-4o"],
    ["bedrock", "anthropic.claude-sonnet-4-5"],
    ["openrouter", "anthropic/claude-sonnet-4.5"],
    ["ollama", "llama3.2"],
    ["custom", "my-model"],
    ["anthropic", "claude-unreviewed-9"],
  ])("has no list price for %s %s", (provider, model) => {
    expect(listPriceModelId(provider, model)).toBeUndefined();
  });
});
