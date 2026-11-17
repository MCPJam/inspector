import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRateRow } from "../model-rate-format";
import { ModelRatesTable } from "../model-rates-panel";

// No list prices, so nothing but the clock re-renders the table.
vi.mock("../use-list-prices", () => ({ useListPrices: () => new Map() }));

const MINUTE = 60_000;
const start = Date.UTC(2026, 10, 17, 12);
const rates = { currency: "USD" as const, input: 1, output: 2 };
const today: ModelRateRow = {
  rateId: "r1",
  modelId: "gpt-4.1",
  providerKey: "openai",
  rates,
  effectiveAt: start - 10 * MINUTE,
  revision: 1,
};
const scheduled: ModelRateRow = {
  ...today,
  rateId: "r2",
  rates: { ...rates, input: 3 },
  effectiveAt: start + MINUTE,
  revision: 2,
};

describe("ModelRatesTable", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("drops the in-force row and the Scheduled badge once a scheduled price starts", async () => {
    vi.useFakeTimers({ now: start });
    render(
      <ModelRatesTable
        rates={[scheduled]}
        providers={[]}
        defaultAuthor="You"
        inForce={
          new Map([
            [
              scheduled.rateId,
              { revision: today, until: scheduled.effectiveAt },
            ],
          ])
        }
      />,
    );
    expect(screen.getByText(/^In force until/)).toBeTruthy();
    expect(screen.getByText("Scheduled")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(MINUTE + 1);
    });
    expect(screen.queryByText(/^In force until/)).toBeNull();
    expect(screen.queryByText("Scheduled")).toBeNull();
  });
});
