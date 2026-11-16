import { z } from "zod";
import { parseModelRates, type ModelRates } from "@mcpjam/sdk/browser";

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

const rowZ = z.object({
  rateId: z.string().min(1),
  modelId: z.string().min(1),
  providerKey: z.string().optional(),
  rates: z.unknown(),
  effectiveAt: z.number(),
  revision: z.number(),
  note: z.string().optional(),
  retiredAt: z.number().optional(),
});

/** One revision from an unchecked response, or undefined when it is malformed. */
export function parseModelRateRow(value: unknown): ModelRateRow | undefined {
  const parsed = rowZ.safeParse(value);
  const rates = parsed.success ? parseModelRates(parsed.data.rates) : undefined;
  return parsed.success && rates ? { ...parsed.data, rates } : undefined;
}

/**
 * The revision in force at `at`, from one series' revisions newest first:
 * the newest one already effective, unless it or a newer one was retired by
 * then. The same rule the server prices a call with.
 */
export function revisionInForce(
  revisions: readonly ModelRateRow[],
  at: number,
): ModelRateRow | undefined {
  let retiredFrom = Number.POSITIVE_INFINITY;
  for (const row of revisions) {
    retiredFrom = Math.min(retiredFrom, row.retiredAt ?? retiredFrom);
    if (row.effectiveAt <= at) return retiredFrom <= at ? undefined : row;
  }
  return undefined;
}

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

/** `at` as a date input's `YYYY-MM-DD`, in local time. */
export function timeToDayInput(at: number): string {
  const date = new Date(at);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A date input's `YYYY-MM-DD`, as the start of that day here. */
export function dayInputToTime(value: string): number | undefined {
  if (!value) return undefined;
  const time = new Date(`${value}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : undefined;
}
