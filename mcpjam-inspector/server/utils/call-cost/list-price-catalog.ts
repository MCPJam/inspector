import { z } from "zod";
import { parseModelRates, type RateEvidence } from "@mcpjam/sdk";
import { logger } from "../logger.js";

/**
 * Public list prices from the backend's keyless `GET /model-prices`, held in
 * memory the way `routes/mcp/models.ts` holds the model catalog: a 60s memo,
 * one shared in-flight fetch, and the last good copy when a refresh fails.
 * A priced call keeps the price version it used, so a minute-old copy only
 * decides which version new calls get.
 */
const PRICES_TTL_MS = 60_000;
/** Bounds the shared fetch so a stalled backend cannot wedge every caller. */
const PRICES_FETCH_TIMEOUT_MS = 10_000;

type ListPrices = ReadonlyMap<string, RateEvidence>;

const priceRowZ = z.object({
  modelId: z.string().min(1),
  provider: z.string().optional(),
  versionId: z.string().optional(),
  retrievedAt: z.number().optional(),
  rates: z.unknown(),
  assumptions: z.array(z.string()).optional(),
});
const priceListZ = z.object({ prices: z.array(z.unknown()) });

let cache: { prices: ListPrices; fetchedAt: number } | null = null;
let inflight: Promise<ListPrices | undefined> | null = null;

/** A row that does not parse is left out: that model reads as unpriced. */
function parseListPrices(body: unknown): ListPrices | undefined {
  const list = priceListZ.safeParse(body);
  if (!list.success) return undefined;
  const prices = new Map<string, RateEvidence>();
  for (const value of list.data.prices) {
    const row = priceRowZ.safeParse(value);
    const rates = row.success ? parseModelRates(row.data.rates) : undefined;
    if (!row.success || !rates) continue;
    prices.set(row.data.modelId, { ...row.data, source: "list_price", rates });
  }
  return prices;
}

/** Never throws: a failed refresh reads as "no prices", which prices nothing. */
async function refreshListPrices(): Promise<ListPrices | undefined> {
  const convexHttpUrl = process.env.CONVEX_HTTP_URL;
  if (!convexHttpUrl) return undefined;
  try {
    const response = await fetch(
      `${convexHttpUrl.replace(/\/$/, "")}/model-prices`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(PRICES_FETCH_TIMEOUT_MS),
      },
    );
    const prices = response.ok
      ? parseListPrices(await response.json())
      : undefined;
    if (!prices) {
      logger.warn("[call-cost] list prices unavailable", {
        httpStatus: response.status,
      });
      return undefined;
    }
    cache = { prices, fetchedAt: Date.now() };
    return prices;
  } catch (error) {
    logger.warn("[call-cost] list prices fetch failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Every list price by canonical model id, or undefined when none are known. */
export async function getListPrices(): Promise<ListPrices | undefined> {
  if (cache && Date.now() - cache.fetchedAt < PRICES_TTL_MS) {
    return cache.prices;
  }
  inflight ??= refreshListPrices().finally(() => {
    inflight = null;
  });
  return (await inflight) ?? cache?.prices;
}

/** Reset the memo and in-flight fetch. Test-only. */
export function __resetListPricesForTests(): void {
  cache = null;
  inflight = null;
}
