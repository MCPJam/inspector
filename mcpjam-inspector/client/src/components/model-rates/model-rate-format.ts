import type { ModelRates } from "@mcpjam/sdk/browser";

/**
 * One saved revision of a model price, as both the organization's rates and
 * this machine's overrides return it.
 */
export type ModelRateRow = {
  rateId: string;
  modelId: string;
  providerKey?: string;
  rates: ModelRates;
  effectiveAt: number;
  revision: number;
  createdBy?: { name?: string; email?: string };
  note?: string;
  retiredAt?: number;
};

/** A price per million tokens, as entered: `$3`, `$0.3`, `$3.75`. */
export function formatRate(usdPerMillion: number | undefined): string {
  if (usdPerMillion === undefined) return "Not set";
  return `$${usdPerMillion.toLocaleString("en-US", { maximumFractionDigits: 4 })}`;
}

export function formatDay(at: number): string {
  return new Date(at).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The public list price as one line under a rate. */
export function listPriceLine(rates: ModelRates): string {
  const cache =
    rates.cacheRead !== undefined
      ? `, ${formatRate(rates.cacheRead)} cache read`
      : "";
  return `List price: ${formatRate(rates.input)} input, ${formatRate(rates.output)} output${cache} per 1M tokens`;
}

/** A date input's `YYYY-MM-DD`, as the start of that day here. */
export function dayInputToTime(value: string): number | undefined {
  if (!value) return undefined;
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : undefined;
}
