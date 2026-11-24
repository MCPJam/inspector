/**
 * What one picker turn cost, in the two numbers the backend adds to the climb's
 * credits: dollars and tokens. The prices come from the turn itself when it
 * carries them (each model call's cost evidence on its trace span); a call with
 * none is priced from the public list price of its model. A turn nothing could
 * price reports its tokens at zero dollars and says so, because a guess would
 * be believed.
 */
import { normalizeModelUsage, priceModelCall } from "@mcpjam/sdk";
import type { UnifiedTurnResult } from "../../utils/turn-execution.js";
import { listPriceModelId } from "../../utils/call-cost/direct-call-pricer.js";
import { getListPrices } from "../../utils/call-cost/list-price-catalog.js";
import { logger } from "../../utils/logger.js";

export type TurnSpend = { estimatedCostUsd: number; tokens: number };

type Priced = Pick<UnifiedTurnResult, "usage" | "turnTrace">;

const finite = (value: number | undefined): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

export async function estimateTurnSpend(result: Priced, modelId: string): Promise<TurnSpend> {
  const inputTokens = finite(result.usage?.inputTokens);
  const outputTokens = finite(result.usage?.outputTokens);
  const tokens = inputTokens + outputTokens;
  const spans = (result.turnTrace?.spans ?? []).filter((span) => span.category === "llm");
  const priced = spans.filter((span) => typeof span.cost?.amountUsd === "number");
  if (priced.length > 0 && priced.length === spans.length) {
    return { tokens, estimatedCostUsd: priced.reduce((sum, span) => sum + finite(span.cost?.amountUsd), 0) };
  }
  if (tokens === 0) return { tokens, estimatedCostUsd: 0 };
  const [provider, ...rest] = modelId.split("/");
  const canonical = rest.length > 0 ? listPriceModelId(provider!, rest.join("/")) : undefined;
  const rate = canonical ? (await getListPrices())?.get(canonical) : undefined;
  if (!rate) {
    logger.warn("[climbs] a picker turn could not be priced, so its spend is reported in tokens only", { modelId, tokens });
    return { tokens, estimatedCostUsd: 0 };
  }
  const known = priced.reduce((sum, span) => sum + finite(span.cost?.amountUsd), 0);
  const cost = priceModelCall({ usage: normalizeModelUsage({ inputTokens, outputTokens }), rate });
  return { tokens, estimatedCostUsd: Math.max(known, finite(cost.amountUsd)) };
}
