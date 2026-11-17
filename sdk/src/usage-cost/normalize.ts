import type { NormalizedModelUsage, ReportedCost } from "./types.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeDifference(
  total: number | undefined,
  ...parts: Array<number | undefined>
): number | undefined {
  if (total === undefined) return undefined;
  const rest = parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
  return Math.max(0, total - rest);
}

function compact(
  usage: NormalizedModelUsage
): NormalizedModelUsage | undefined {
  const entries = Object.entries(usage).filter(
    ([, value]) => value !== undefined
  );
  return entries.length > 0
    ? (Object.fromEntries(entries) as NormalizedModelUsage)
    : undefined;
}

/**
 * Extras only the provider's raw usage carries: Anthropic's one-hour cache
 * writes and billed web searches. The AI SDK keeps the raw object on
 * `usage.raw`, so a per-step usage still has them.
 */
function rawExtras(raw: UnknownRecord | undefined): {
  cacheWrite1hTokens?: number;
  webSearchRequests?: number;
} {
  if (!raw) return {};
  return {
    cacheWrite1hTokens: count(
      asRecord(raw.cache_creation)?.ephemeral_1h_input_tokens
    ),
    webSearchRequests: count(
      asRecord(raw.server_tool_use)?.web_search_requests
    ),
  };
}

/** AI SDK 6/7 `LanguageModelUsage`: `inputTokens` includes cache reads and writes. */
function fromAiSdkUsage(
  usage: UnknownRecord
): NormalizedModelUsage | undefined {
  const inputDetails = asRecord(usage.inputTokenDetails);
  const outputDetails = asRecord(usage.outputTokenDetails);
  const totalInput = count(usage.inputTokens);
  const cacheReadTokens = count(inputDetails?.cacheReadTokens);
  const cacheWriteTokens = count(inputDetails?.cacheWriteTokens);
  const uncachedInputTokens =
    count(inputDetails?.noCacheTokens) ??
    nonNegativeDifference(totalInput, cacheReadTokens, cacheWriteTokens);
  return compact({
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens: count(usage.outputTokens),
    reasoningTokens:
      count(outputDetails?.reasoningTokens) ?? count(usage.reasoningTokens),
    ...rawExtras(asRecord(usage.raw)),
  });
}

/**
 * The flat shape older AI SDK versions, the backend's usage rows and SDK eval
 * reports use: `inputTokens` (all input) includes `cachedInputTokens`; cache writes are
 * not reported.
 */
function fromFlatUsage(usage: UnknownRecord): NormalizedModelUsage | undefined {
  const totalInput = count(
    usage.inputTokens ?? usage.promptTokens ?? usage.input
  );
  const cacheReadTokens = count(usage.cachedInputTokens);
  return compact({
    uncachedInputTokens: nonNegativeDifference(totalInput, cacheReadTokens),
    cacheReadTokens,
    outputTokens: count(
      usage.outputTokens ?? usage.completionTokens ?? usage.output
    ),
    reasoningTokens: count(usage.reasoningTokens),
  });
}

/**
 * Normalize ONE request's usage into exclusive buckets. Accepts the AI SDK's
 * per-step usage (never `totalUsage`, which merges requests that may sit in
 * different price tiers) or the flat legacy shape. Provider-native usage is
 * the caller's to map: the AI SDK already does it for every route the
 * Inspector runs. Returns undefined when nothing usable was reported.
 */
export function normalizeModelUsage(
  value: unknown
): NormalizedModelUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  return asRecord(usage.inputTokenDetails) || asRecord(usage.outputTokenDetails)
    ? fromAiSdkUsage(usage)
    : fromFlatUsage(usage);
}

const USAGE_KEYS = [
  "uncachedInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "cacheWrite1hTokens",
  "outputTokens",
  "reasoningTokens",
  "webSearchRequests",
] as const satisfies ReadonlyArray<keyof NormalizedModelUsage>;

/**
 * Validate an already-normalized usage object read from storage or the wire.
 * Drops unknown keys and invalid numbers; keeps explicit zeros.
 */
export function parseNormalizedModelUsage(
  value: unknown
): NormalizedModelUsage | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const parsed: NormalizedModelUsage = {};
  for (const key of USAGE_KEYS) {
    const parsedCount = count(usage[key]);
    if (parsedCount !== undefined) parsed[key] = parsedCount;
  }
  return compact(parsed);
}

/** Total input for context-tier selection: fresh, cache read and cache write. */
export function totalInputTokens(
  usage: NormalizedModelUsage | undefined
): number | undefined {
  if (
    !usage ||
    (usage.uncachedInputTokens === undefined &&
      usage.cacheReadTokens === undefined &&
      usage.cacheWriteTokens === undefined &&
      usage.cacheWrite1hTokens === undefined)
  ) {
    return undefined;
  }
  return (
    (usage.uncachedInputTokens ?? 0) +
    (usage.cacheReadTokens ?? 0) +
    Math.max(usage.cacheWriteTokens ?? 0, usage.cacheWrite1hTokens ?? 0)
  );
}

function parseAmount(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return count(parsed);
}

/**
 * The dollar amount a gateway returned for this request, from AI SDK
 * `providerMetadata`. Vercel AI Gateway sends `gateway.cost` as a numeric
 * string; OpenRouter sends `openrouter.usage.cost`. Funding is decided by the
 * caller: a reported amount on a customer key is still the customer's spend.
 */
export function extractReportedProviderCost(
  providerMetadata: unknown
): ReportedCost | undefined {
  const metadata = asRecord(providerMetadata);
  const gatewayCost = parseAmount(asRecord(metadata?.gateway)?.cost);
  if (gatewayCost !== undefined) {
    return {
      amountUsd: gatewayCost,
      source: "provider_reported",
      reporter: "gateway",
    };
  }
  const openRouterCost = parseAmount(
    asRecord(asRecord(metadata?.openrouter)?.usage)?.cost
  );
  if (openRouterCost !== undefined) {
    return {
      amountUsd: openRouterCost,
      source: "provider_reported",
      reporter: "openrouter",
    };
  }
  return undefined;
}
