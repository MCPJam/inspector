import { describe, expect, it } from "vitest";
import {
  EFFECTIVE_AT_WINDOW_MS,
  normalizeModelRateInput,
} from "../model-rate-input";

const now = 1_800_000_000_000;
const local = { now, requireProvider: true };

describe("normalizeModelRateInput", () => {
  it("trims, keeps the rates given and defaults the effective date to now", () => {
    expect(
      normalizeModelRateInput(
        {
          modelId: "  claude-sonnet-4-5 ",
          providerKey: " anthropic ",
          rates: { input: 3, output: 15, cacheRead: 0, cacheWrite: undefined },
          note: "  ",
        },
        local,
      ),
    ).toEqual({
      ok: true,
      value: {
        modelId: "claude-sonnet-4-5",
        providerKey: "anthropic",
        rates: { currency: "USD", input: 3, output: 15, cacheRead: 0 },
        effectiveAt: now,
      },
    });
  });

  it("lets an organization rate apply to any provider", () => {
    const result = normalizeModelRateInput(
      {
        modelId: "anthropic/claude-sonnet-4.5",
        rates: { input: 3, output: 15 },
      },
      { now, requireProvider: false },
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.value).not.toHaveProperty("providerKey");
  });

  it.each([
    [
      { modelId: " ", rates: { input: 1, output: 1 } },
      "Enter a model ID, such as anthropic/claude-sonnet-4.5.",
    ],
    [
      { modelId: "m", providerKey: "p", rates: { output: 1 } },
      "Input price must be zero or more. Enter a dollar amount.",
    ],
    [
      {
        modelId: "m",
        providerKey: "p",
        rates: { input: 1, output: Number.NaN },
      },
      "Output price must be zero or more. Enter a dollar amount.",
    ],
    [
      {
        modelId: "m",
        providerKey: "p",
        rates: { input: 1, output: 1, cacheRead: 250_000 },
      },
      "Cache read price is above $100,000. Enter the price per million tokens.",
    ],
    [
      {
        modelId: "m",
        providerKey: "p",
        rates: { input: 1, output: 1 },
        effectiveAt: now + EFFECTIVE_AT_WINDOW_MS + 1,
      },
      "Pick an effective date within one year of today.",
    ],
    [
      {
        modelId: "m",
        providerKey: "p",
        rates: { input: 1, output: 1 },
        note: "x".repeat(501),
      },
      "Notes can be at most 500 characters. Shorten the note and save again.",
    ],
  ])("refuses %j", (input, message) => {
    expect(normalizeModelRateInput(input, local)).toEqual({
      ok: false,
      message,
    });
  });
});
