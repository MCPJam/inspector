import { useEffect, useState } from "react";
import { parseModelRates, type ModelRates } from "@mcpjam/sdk/browser";
import { getConvexSiteUrl } from "@/lib/convex-site-url";

type ListPrices = ReadonlyMap<string, ModelRates>;

let shared: Promise<ListPrices> | null = null;

/**
 * Public list prices by canonical model id, from the backend's keyless
 * `GET /model-prices`, fetched once per page load. They are a hint beside
 * the rates people enter, so a failed fetch shows no hint rather than an
 * error.
 */
async function fetchListPrices(): Promise<ListPrices> {
  const site = getConvexSiteUrl();
  if (!site) return new Map();
  try {
    const response = await fetch(`${site.replace(/\/$/, "")}/model-prices`);
    const body: unknown = response.ok ? await response.json() : undefined;
    const rows: Array<{ modelId?: unknown; rates?: unknown } | null> =
      body &&
      typeof body === "object" &&
      "prices" in body &&
      Array.isArray(body.prices)
        ? body.prices
        : [];
    const prices = new Map<string, ModelRates>();
    for (const row of rows) {
      const rates = parseModelRates(row?.rates);
      if (typeof row?.modelId === "string" && rates)
        prices.set(row.modelId, rates);
    }
    return prices;
  } catch (error) {
    console.warn("List prices could not be loaded", error);
    return new Map();
  }
}

export function useListPrices(enabled: boolean): ListPrices {
  const [prices, setPrices] = useState<ListPrices>(() => new Map());
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    shared ??= fetchListPrices();
    void shared.then((loaded) => {
      if (live) setPrices(loaded);
    });
    return () => {
      live = false;
    };
  }, [enabled]);
  return prices;
}

/** Forget the fetched prices. Test-only. */
export function __resetListPricesForTests(): void {
  shared = null;
}
