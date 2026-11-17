import { parseNormalizedModelUsage } from "./normalize.js";
import type {
  CostFunding,
  ModelCallCost,
  ModelCallCostEvidence,
  ModelRates,
  NormalizedModelUsage,
  RateEvidence,
  RateTier,
  UsageSource,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;

const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[]
): T | undefined {
  return (allowed as readonly unknown[]).includes(value)
    ? (value as T)
    : undefined;
}

/** Copy the listed keys whose values pass `read`, dropping everything else. */
function pick<T extends object>(
  raw: UnknownRecord,
  keys: ReadonlyArray<keyof T & string>,
  read: (value: unknown) => unknown
): Partial<T> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    const parsed = read(raw[key]);
    if (parsed !== undefined) picked[key] = parsed;
  }
  return picked as Partial<T>;
}

const RATE_KEYS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "cacheWrite1h",
] as const;

/**
 * Read a rate card from the wire or storage: a public price row, an
 * organization rate or a local override. Returns undefined unless it is in US
 * dollars with input and output rates; invalid optional rates are dropped, so
 * the tokens they would price count as unpriced, never as free.
 */
export function parseModelRates(value: unknown): ModelRates | undefined {
  const raw = asRecord(value);
  if (!raw || raw.currency !== "USD") return undefined;
  const rates = pick<ModelRates>(
    raw,
    [...RATE_KEYS, "webSearchPerThousand"],
    amount
  );
  if (rates.input === undefined || rates.output === undefined) return undefined;
  const tiers = (Array.isArray(raw.tiers) ? raw.tiers : [])
    .map(asRecord)
    .filter(
      (tier): tier is UnknownRecord =>
        amount(tier?.aboveInputTokens) !== undefined
    )
    .map(
      (tier) =>
        pick<RateTier>(
          tier,
          ["aboveInputTokens", ...RATE_KEYS],
          amount
        ) as RateTier
    );
  return {
    ...(rates as ModelRates),
    currency: "USD",
    ...(tiers.length > 0 ? { tiers } : {}),
  };
}

function parseRateEvidence(value: unknown): RateEvidence | undefined {
  const raw = asRecord(value);
  const source = oneOf(raw?.source, ["list_price", "customer_rate"] as const);
  const rates = parseModelRates(raw?.rates);
  const modelId = text(raw?.modelId);
  if (!raw || !source || !rates || !modelId) return undefined;
  const assumptions = Array.isArray(raw.assumptions)
    ? raw.assumptions.filter((item): item is string => typeof item === "string")
    : [];
  return {
    source,
    rates,
    modelId,
    ...pick<RateEvidence>(raw, ["provider", "versionId"], text),
    ...pick<RateEvidence>(raw, ["effectiveAt", "retrievedAt"], amount),
    ...(assumptions.length > 0 ? { assumptions } : {}),
  };
}

/**
 * Read cost evidence from the wire or storage. Returns undefined for anything
 * that is not a coherent record (unknown completeness, an amount on an
 * unavailable result, no amount on a complete one, an amount with no known
 * source), so a malformed value shows as "no cost evidence" rather than a
 * wrong number. An amount must say where it came from: without a source the
 * UI could not tell a report from an estimate.
 */
export function parseModelCallCostEvidence(
  value: unknown
): ModelCallCostEvidence | undefined {
  const raw = asRecord(value);
  if (!raw || raw.currency !== "USD") return undefined;
  const completeness = oneOf(raw.completeness, [
    "complete",
    "partial",
    "unavailable",
  ] as const);
  const calculationVersion = amount(raw.calculationVersion);
  const amountUsd = amount(raw.amountUsd);
  const source = oneOf(raw.source, [
    "provider_reported",
    "list_price",
    "customer_rate",
    "runner_reported",
  ] as const);
  if (!completeness || calculationVersion === undefined) return undefined;
  if ((completeness === "unavailable") !== (amountUsd === undefined))
    return undefined;
  if (amountUsd !== undefined && !source) return undefined;

  const parts = pick<NonNullable<ModelCallCost["parts"]>>(
    asRecord(raw.parts) ?? {},
    ["input", "cacheRead", "cacheWrite", "output", "webSearch"],
    amount
  );
  const missing = (Array.isArray(raw.missing) ? raw.missing : []).filter(
    (item): item is NonNullable<ModelCallCost["missing"]>[number] =>
      oneOf(item, [
        "usage",
        "input_tokens",
        "output_tokens",
        "rate",
        "cache_read_rate",
        "cache_write_rate",
        "cache_write_1h_rate",
        "web_search_rate",
      ] as const) !== undefined
  );
  const reason = oneOf(raw.reason, [
    "no_usage",
    "no_rate",
    "invalid_rate",
    "unsupported_currency",
  ] as const);
  const funding = oneOf<CostFunding>(raw.funding, ["mcpjam", "customer"]);
  const usageSource = oneOf<UsageSource>(raw.usageSource, [
    "provider",
    "runner",
    "interrupted_estimate",
  ]);
  const usage = parseNormalizedModelUsage(raw.usage);
  const rate = parseRateEvidence(raw.rate);

  return {
    calculationVersion,
    currency: "USD",
    completeness,
    ...(amountUsd !== undefined ? { amountUsd } : {}),
    ...(source ? { source } : {}),
    ...(Object.keys(parts).length > 0 ? { parts } : {}),
    ...(missing.length > 0 ? { missing } : {}),
    ...(reason ? { reason } : {}),
    ...pick<ModelCallCost>(raw, ["tierAboveInputTokens"], amount),
    ...(rate ? { rate } : {}),
    ...pick<ModelCallCost>(raw, ["reporter"], text),
    ...(funding ? { funding } : {}),
    ...(usage ? { usage } : {}),
    ...(usageSource ? { usageSource } : {}),
    ...pick<ModelCallCostEvidence>(raw, ["recordedAt"], amount),
  };
}

/** Attach the usage and funding a cost was priced from. */
export function toModelCallCostEvidence(
  cost: ModelCallCost,
  context: {
    usage?: NormalizedModelUsage;
    usageSource?: UsageSource;
    funding?: CostFunding;
    recordedAt?: number;
  }
): ModelCallCostEvidence {
  const defined = Object.entries(context).filter(
    ([, value]) => value !== undefined
  );
  return { ...cost, ...Object.fromEntries(defined) };
}
