import {
  type Femto,
  femtoToUsd,
  requestCostFemto,
  tokenCostFemto,
  usdToFemto,
} from "./fixed-point.js";
import { totalInputTokens } from "./normalize.js";
import {
  type CostParts,
  type CostSource,
  MODEL_CALL_COST_CALCULATION_VERSION,
  type MissingCostComponent,
  type ModelCallCost,
  type ModelCostRollup,
  type ModelRates,
  type NormalizedModelUsage,
  type RateEvidence,
  type RateTier,
  type ReportedCost,
  type TokenRates,
} from "./types.js";

export interface PriceModelCallInput {
  usage?: NormalizedModelUsage;
  /** A dollar amount returned for this request, if any. */
  reported?: ReportedCost;
  /** The rate to estimate from: the caller resolves customer before list price. */
  rate?: RateEvidence | null;
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validRates(rates: ModelRates): boolean {
  if (rates.currency !== "USD") return false;
  if (!isRate(rates.input) || !isRate(rates.output)) return false;
  const optional = [
    rates.cacheRead,
    rates.cacheWrite,
    rates.cacheWrite1h,
    rates.webSearchPerThousand,
  ];
  if (optional.some((rate) => rate !== undefined && !isRate(rate))) {
    return false;
  }
  return (rates.tiers ?? []).every(
    (tier) =>
      isRate(tier.aboveInputTokens) &&
      [
        tier.input,
        tier.output,
        tier.cacheRead,
        tier.cacheWrite,
        tier.cacheWrite1h,
      ].every((rate) => rate === undefined || isRate(rate))
  );
}

/** The highest tier this request's own input crossed, if any. */
function selectTier(
  rates: ModelRates,
  usage: NormalizedModelUsage
): RateTier | undefined {
  const input = totalInputTokens(usage);
  if (input === undefined || !rates.tiers?.length) return undefined;
  return [...rates.tiers]
    .sort((a, b) => b.aboveInputTokens - a.aboveInputTokens)
    .find((tier) => input > tier.aboveInputTokens);
}

function effectiveRates(
  rates: ModelRates,
  tier: RateTier | undefined
): TokenRates {
  if (!tier) return rates;
  return {
    input: tier.input ?? rates.input,
    output: tier.output ?? rates.output,
    cacheRead: tier.cacheRead ?? rates.cacheRead,
    cacheWrite: tier.cacheWrite ?? rates.cacheWrite,
    cacheWrite1h: tier.cacheWrite1h ?? rates.cacheWrite1h,
  };
}

/**
 * A copy of the rate the result was priced from. The result is stored as
 * history, so it must not share nested objects with a rate the caller may
 * later edit.
 */
function snapshotRate(rate: RateEvidence): RateEvidence {
  return {
    ...rate,
    rates: {
      ...rate.rates,
      ...(rate.rates.tiers
        ? { tiers: rate.rates.tiers.map((tier) => ({ ...tier })) }
        : {}),
    },
    ...(rate.assumptions ? { assumptions: [...rate.assumptions] } : {}),
  };
}

function base(): Pick<ModelCallCost, "calculationVersion" | "currency"> {
  return {
    calculationVersion: MODEL_CALL_COST_CALCULATION_VERSION,
    currency: "USD",
  };
}

function fromReported(reported: ReportedCost): ModelCallCost {
  return {
    ...base(),
    completeness: "complete",
    amountUsd: reported.amountUsd,
    source: reported.source,
    ...(reported.reporter ? { reporter: reported.reporter } : {}),
  };
}

function unavailable(
  reason: ModelCallCost["reason"],
  missing: MissingCostComponent[],
  rate?: RateEvidence
): ModelCallCost {
  return {
    ...base(),
    completeness: "unavailable",
    reason,
    missing,
    ...(rate ? { rate: snapshotRate(rate) } : {}),
  };
}

function estimate(
  usage: NormalizedModelUsage,
  rate: RateEvidence
): ModelCallCost {
  const tier = selectTier(rate.rates, usage);
  const rates = effectiveRates(rate.rates, tier);
  const missing: MissingCostComponent[] = [];
  const partFemto: Partial<Record<keyof CostParts, Femto>> = {};
  const add = (part: keyof CostParts, femto: Femto) => {
    partFemto[part] = (partFemto[part] ?? 0n) + femto;
  };
  // Uncached input is the bulk of a request's input. Without it the request's
  // context tier is unknown, so every tiered token rate is unknown too: base
  // rates would understate a request that crossed a threshold.
  const tierUnknown =
    (rate.rates.tiers?.length ?? 0) > 0 &&
    usage.uncachedInputTokens === undefined;

  if (usage.uncachedInputTokens === undefined) missing.push("input_tokens");
  else add("input", tokenCostFemto(usage.uncachedInputTokens, rates.input));

  if (usage.outputTokens === undefined) missing.push("output_tokens");
  else if (!tierUnknown) {
    add("output", tokenCostFemto(usage.outputTokens, rates.output));
  }

  if (usage.cacheReadTokens && !tierUnknown) {
    if (rates.cacheRead === undefined) missing.push("cache_read_rate");
    else
      add("cacheRead", tokenCostFemto(usage.cacheReadTokens, rates.cacheRead));
  }

  // One-hour writes are a subset of all writes; a provider that reports only
  // the subset still wrote at least that many tokens.
  const cacheWrites = Math.max(
    usage.cacheWriteTokens ?? 0,
    usage.cacheWrite1hTokens ?? 0
  );
  if (cacheWrites > 0 && !tierUnknown) {
    const oneHour = Math.min(usage.cacheWrite1hTokens ?? 0, cacheWrites);
    const defaultWrites = cacheWrites - oneHour;
    if (defaultWrites > 0) {
      if (rates.cacheWrite === undefined) missing.push("cache_write_rate");
      else add("cacheWrite", tokenCostFemto(defaultWrites, rates.cacheWrite));
    }
    if (oneHour > 0) {
      if (rates.cacheWrite1h === undefined) missing.push("cache_write_1h_rate");
      else add("cacheWrite", tokenCostFemto(oneHour, rates.cacheWrite1h));
    }
  }

  if (usage.webSearchRequests) {
    if (rate.rates.webSearchPerThousand === undefined) {
      missing.push("web_search_rate");
    } else {
      add(
        "webSearch",
        requestCostFemto(
          usage.webSearchRequests,
          rate.rates.webSearchPerThousand
        )
      );
    }
  }

  const pricedParts = Object.entries(partFemto) as Array<
    [keyof CostParts, Femto]
  >;
  if (pricedParts.length === 0) return unavailable("no_usage", missing, rate);
  const parts: CostParts = {};
  let total: Femto = 0n;
  for (const [part, femto] of pricedParts) {
    parts[part] = femtoToUsd(femto);
    total += femto;
  }
  return {
    ...base(),
    completeness: missing.length === 0 ? "complete" : "partial",
    amountUsd: femtoToUsd(total),
    source: rate.source,
    parts,
    ...(missing.length > 0 ? { missing } : {}),
    ...(tier ? { tierAboveInputTokens: tier.aboveInputTokens } : {}),
    rate: snapshotRate(rate),
  };
}

/**
 * Price one provider request. Precedence follows the spec: a provider-reported
 * amount, then an estimate from the supplied rate (the caller passes a
 * customer rate before a list price), then a runner-reported amount. Unknown
 * components never price as zero: they make the result partial, and no usable
 * evidence makes it unavailable.
 */
export function priceModelCall(input: PriceModelCallInput): ModelCallCost {
  const { usage, rate } = input;
  // An invalid amount is no evidence at all: it falls through to the rate.
  const reported =
    input.reported &&
    Number.isFinite(input.reported.amountUsd) &&
    input.reported.amountUsd >= 0
      ? input.reported
      : undefined;
  if (reported?.source === "provider_reported") return fromReported(reported);

  const runnerFallback =
    reported?.source === "runner_reported" ? fromReported(reported) : undefined;

  if (!usage) return runnerFallback ?? unavailable("no_usage", ["usage"]);
  if (!rate) return runnerFallback ?? unavailable("no_rate", ["rate"]);
  if (!validRates(rate.rates)) {
    return (
      runnerFallback ??
      unavailable(
        rate.rates.currency === "USD" ? "invalid_rate" : "unsupported_currency",
        ["rate"],
        rate
      )
    );
  }
  const estimated = estimate(usage, rate);
  return estimated.completeness === "unavailable" && runnerFallback
    ? runnerFallback
    : estimated;
}

const SOURCE_ORDER: CostSource[] = [
  "provider_reported",
  "customer_rate",
  "list_price",
  "runner_reported",
];

/**
 * Sum priced calls. Each call must appear once: pass request-level results,
 * never a request and the parent total that already includes it. A call
 * without an amount, or a partial one, makes the rollup partial; no amounts at
 * all make it unavailable. An empty list is complete at $0 only because there
 * was nothing to price.
 */
export function aggregateModelCallCosts(
  calls: ReadonlyArray<ModelCallCost | undefined>
): ModelCostRollup {
  let total: Femto = 0n;
  let completeCalls = 0;
  let partialCalls = 0;
  let unavailableCalls = 0;
  const sources = new Set<CostSource>();

  for (const call of calls) {
    if (!call || call.amountUsd === undefined || call.currency !== "USD") {
      unavailableCalls += 1;
      continue;
    }
    total += usdToFemto(call.amountUsd);
    if (call.source) sources.add(call.source);
    if (call.completeness === "complete") completeCalls += 1;
    else partialCalls += 1;
  }

  const totalCalls = calls.length;
  const completeness =
    completeCalls === totalCalls
      ? "complete"
      : completeCalls + partialCalls === 0
        ? "unavailable"
        : "partial";

  return {
    currency: "USD",
    knownSubtotalUsd: femtoToUsd(total),
    completeness,
    totalCalls,
    completeCalls,
    partialCalls,
    unavailableCalls,
    sources: SOURCE_ORDER.filter((source) => sources.has(source)),
  };
}

/**
 * Convert a per-token USD rate (the unit the Gateway pricing rows and
 * models.dev-style feeds use) to USD per million tokens, without the float
 * noise `3e-6 * 1e6` would carry into stored evidence.
 */
export function usdPerTokenToPerMillion(usdPerToken: number): number {
  return Number((usdPerToken * 1_000_000).toPrecision(12));
}
