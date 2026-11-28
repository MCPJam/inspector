import { z } from "zod";
import { parseModelRates, type ModelRates } from "@mcpjam/sdk/browser";

/**
 * One saved revision of a model price: a local override on this machine or an
 * organization rate. Each save is a new revision of its provider + model
 * series with an effective date.
 */
export const modelRateRevisionZ = z.object({
  rateId: z.string().min(1),
  modelId: z.string().min(1),
  providerKey: z.string().optional(),
  rates: z.unknown(),
  effectiveAt: z.number(),
  revision: z.number(),
  note: z.string().optional(),
  retiredAt: z.number().optional(), // On a series' newest revision only.
});

/** A row `schema` accepts, with its rates checked. */
export type ParsedModelRateRevision<T extends z.ZodType> = Omit<
  z.infer<T>,
  "rates"
> & { rates: ModelRates };

/**
 * One revision from unchecked data, read with `schema` (the base shape or an
 * extension of it), or undefined when it or its rates are malformed.
 */
export function parseModelRateRevision<
  T extends z.ZodType<{ rates?: unknown }>,
>(schema: T, value: unknown): ParsedModelRateRevision<T> | undefined {
  const parsed = schema.safeParse(value);
  const rates = parsed.success ? parseModelRates(parsed.data.rates) : undefined;
  return parsed.success && rates ? { ...parsed.data, rates } : undefined;
}

/**
 * The revision in force at `at`, from one series' revisions newest first: the
 * newest one already effective, unless it or a newer one was retired by then.
 * A series saved again after a retirement starts over. The server prices a
 * call with this rule and the settings page shows the rate it picks.
 */
export function revisionInForce<
  R extends { effectiveAt: number; retiredAt?: number },
>(revisions: readonly R[], at: number): R | undefined {
  let retiredFrom = Number.POSITIVE_INFINITY;
  for (const row of revisions) {
    retiredFrom = Math.min(retiredFrom, row.retiredAt ?? retiredFrom);
    if (row.effectiveAt <= at) return retiredFrom <= at ? undefined : row;
  }
  return undefined;
}
