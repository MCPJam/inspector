import type { ModelRates } from "@mcpjam/sdk/browser";
import { revisionInForce } from "@/shared/model-rate-revision";

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

/**
 * When the price in force for these revisions next changes after `now`: the
 * earliest start or retirement still ahead, or Infinity when none is.
 */
export function nextRateChange(
  revisions: readonly Pick<ModelRateRow, "effectiveAt" | "retiredAt">[],
  now: number,
): number {
  return Math.min(
    ...revisions
      .flatMap((row) => [row.effectiveAt, row.retiredAt ?? 0])
      .filter((at) => at > now),
  );
}

/**
 * The revision of one series in force at `now`, or null when none is, and
 * when the next one starts: the earliest start after `now`, which can be a
 * scheduled revision older than the one the list shows.
 */
export function inForceUntilNext(
  revisions: readonly ModelRateRow[],
  now: number,
): { revision: ModelRateRow | null; until: number } {
  return {
    revision: revisionInForce(revisions, now) ?? null,
    until: Math.min(
      ...revisions.map((row) => row.effectiveAt).filter((at) => at > now),
    ),
  };
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
