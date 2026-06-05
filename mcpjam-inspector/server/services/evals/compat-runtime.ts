/**
 * Inspector-side suite hostConfig loader.
 *
 * The OpenAI Apps compat resolution helpers live in
 * `@mcpjam/sdk/host-config/internal` — callers import them directly from
 * the SDK. This file used to re-export them for back-compat; that shim
 * was removed as part of the Stage 4 cleanup.
 *
 * `loadSuiteHostConfig` stays inspector-side because it takes a
 * `ConvexHttpClient` and does Convex queries, which can't move into the
 * pure SDK module.
 */

import type { ConvexHttpClient } from "convex/browser";

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
