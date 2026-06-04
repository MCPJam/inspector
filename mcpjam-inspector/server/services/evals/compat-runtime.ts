/**
 * OpenAI Apps compat resolution + Convex-bound suite hostConfig loader.
 *
 * As of Stage 3 of the hostConfig consolidation, `resolveOpenAiCompatForHostConfig`
 * lives in `@mcpjam/sdk/host-config/internal` (alongside the canonical
 * hostConfig model) and is re-exported here so call sites don't churn.
 *
 * `loadSuiteHostConfig` stays inspector-side — it takes a `ConvexHttpClient`
 * and does Convex queries, so it can't move into the pure SDK module.
 */

import type { ConvexHttpClient } from "convex/browser";

export { resolveOpenAiCompatForHostConfig } from "@mcpjam/sdk/host-config/internal";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export async function loadSuiteHostConfig(
  convexClient: ConvexHttpClient,
  suiteId?: string,
  namedHostId?: string,
): Promise<Record<string, unknown> | null> {
  if (namedHostId) {
    try {
      const host = await convexClient.query("hosts:getHost" as any, {
        hostId: namedHostId,
      });
      return isRecord(host?.config) ? host.config : null;
    } catch {
      return null;
    }
  }
  if (!suiteId) return null;
  try {
    const config = await convexClient.query(
      "hostConfigsV2:getSuiteConfig" as any,
      { suiteId },
    );
    return isRecord(config) ? config : null;
  } catch {
    return null;
  }
}
