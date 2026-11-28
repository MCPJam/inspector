/**
 * Per-call model cost evidence: the contract the Inspector, the SDK and the
 * backend share so a trace, a prompt total and an eval total all read the same
 * numbers. One record describes one provider request (one attempt). Totals are
 * sums of records, never a run-wide rate applied to run-wide tokens, because
 * context tiers are decided per request: five 50K-token calls are not one
 * 250K-token call.
 *
 * Every token bucket is EXCLUSIVE of the others except where a field says it is
 * a subset. Absent means "not reported"; 0 means "reported as zero".
 */
export interface NormalizedModelUsage {
  /**
   * Input tokens neither read from nor written to a cache. Named apart from
   * the AI SDK's `inputTokens`, which includes cache tokens, so an adapter
   * cannot pass one for the other and double-count cache reads.
   */
  uncachedInputTokens?: number;
  /** Input tokens read from a prompt cache. */
  cacheReadTokens?: number;
  /** Input tokens written to a prompt cache, all retention periods. */
  cacheWriteTokens?: number;
  /**
   * Subset of `cacheWriteTokens` written with one-hour retention (Anthropic).
   * The rest of `cacheWriteTokens` is priced at the default write rate.
   */
  cacheWrite1hTokens?: number;
  /** Output tokens, including reasoning. */
  outputTokens?: number;
  /** Subset of `outputTokens` the provider reports as reasoning. */
  reasoningTokens?: number;
  /** Server-side web search requests the provider billed per request. */
  webSearchRequests?: number;
}

/** How the token counts were obtained. */
export type UsageSource =
  /** The provider's own usage object for this request. */
  | "provider"
  /** Reported by the SDK runner on the customer's machine; not verified. */
  | "runner"
  /** Estimated because the stream ended before the provider reported usage. */
  | "interrupted_estimate";

/** Who pays the provider for the call. Independent of how cost was obtained. */
export type CostFunding = "mcpjam" | "customer";

/** How the dollar amount was obtained. */
export type CostSource =
  /** The provider or gateway returned a dollar amount for this request. */
  | "provider_reported"
  /** Usage priced from a public price list. */
  | "list_price"
  /** Usage priced from a rate the customer entered. */
  | "customer_rate"
  /** The SDK runner supplied an amount the server cannot verify. */
  | "runner_reported";

export type CostCompleteness = "complete" | "partial" | "unavailable";

/** A charge component the estimate could not price. */
export type MissingCostComponent =
  | "usage"
  | "input_tokens"
  | "output_tokens"
  | "rate"
  | "cache_read_rate"
  | "cache_write_rate"
  | "cache_write_1h_rate"
  | "web_search_rate";

export type UnavailableCostReason =
  "no_usage" | "no_rate" | "invalid_rate" | "unsupported_currency";

/**
 * Rates in US dollars per million tokens (and per thousand web searches), the
 * unit providers publish. A missing optional rate is unknown, never zero: a
 * call that used that bucket becomes partial.
 */
export interface TokenRates {
  input: number;
  output: number;
  cacheRead?: number;
  /** Default (Anthropic: five-minute) cache-write rate. */
  cacheWrite?: number;
  /** One-hour cache-write rate (Anthropic). */
  cacheWrite1h?: number;
}

/**
 * A context tier. When one request's total input (fresh + cache read + cache
 * write) exceeds `aboveInputTokens`, the tier's rates replace the base rates
 * for that whole request. Anthropic and Google long-context pricing work this
 * way.
 */
export interface RateTier extends Partial<TokenRates> {
  aboveInputTokens: number;
}

export interface ModelRates extends TokenRates {
  currency: "USD";
  webSearchPerThousand?: number;
  tiers?: RateTier[];
}

/** Where a rate came from, kept with every priced call so history never moves. */
export interface RateEvidence {
  source: "list_price" | "customer_rate";
  rates: ModelRates;
  /** The model key the rate is published or entered for. */
  modelId: string;
  provider?: string;
  /** Immutable price-version or rate-revision id. */
  versionId?: string;
  /** When the rate took effect, ms since epoch. */
  effectiveAt?: number;
  /** When a public price was retrieved, ms since epoch. */
  retrievedAt?: number;
  /** Documented provider defaults applied to fill a rate, stated in words. */
  assumptions?: string[];
}

export interface ReportedCost {
  amountUsd: number;
  source: "provider_reported" | "runner_reported";
  /** Who reported it, for example `gateway` or `openrouter`. */
  reporter?: string;
}

export interface CostParts {
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  webSearch?: number;
}

/** Bumped when the calculation changes so stored results stay explainable. */
export const MODEL_CALL_COST_CALCULATION_VERSION = 1;

/**
 * The priced result for one call. `amountUsd` is the known subtotal when
 * `completeness` is `partial`, and absent when it is `unavailable`.
 */
export interface ModelCallCost {
  calculationVersion: number;
  currency: "USD";
  completeness: CostCompleteness;
  amountUsd?: number;
  source?: CostSource;
  parts?: CostParts;
  missing?: MissingCostComponent[];
  reason?: UnavailableCostReason;
  /** The context tier the request crossed, when one applied. */
  tierAboveInputTokens?: number;
  /** Rate snapshot used, for estimates. Never re-resolved on read. */
  rate?: RateEvidence;
  reporter?: string;
}

/** Totals over a set of calls. */
export interface ModelCostRollup {
  currency: "USD";
  /** Sum of every known amount, including partial calls' known subtotals. */
  knownSubtotalUsd: number;
  completeness: CostCompleteness;
  totalCalls: number;
  completeCalls: number;
  partialCalls: number;
  unavailableCalls: number;
  /** Distinct sources across the priced calls, in a stable order. */
  sources: CostSource[];
}

/**
 * What a trace span, a usage row or a stream finish carries for one call: the
 * priced result plus the usage and funding it was priced from. Stored once at
 * capture and read back as-is; nothing re-prices it on display.
 */
export interface ModelCallCostEvidence extends ModelCallCost {
  funding?: CostFunding;
  usage?: NormalizedModelUsage;
  usageSource?: UsageSource;
  /** When the evidence was recorded, ms since epoch. */
  recordedAt?: number;
}
