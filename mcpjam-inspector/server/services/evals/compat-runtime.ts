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
import {
  DEFAULT_HOST_STYLE_V2,
  emptyHostConfigInputV2,
} from "@mcpjam/sdk/host-config/templates";
import { ErrorCode, WebRouteError } from "../../routes/web/errors.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Resolve the host config a run executes under. The invariant is that a run is
 * NEVER hostless — every caller receives a real host config:
 *
 * - **A `namedHostId` was requested** (the user picked an attached host): the
 *   host's config MUST exist. A miss throws — silently falling back to a default
 *   would mis-attribute the run (the UI says "Claude"/"ChatGPT" but it would run
 *   as MCPJam). Fail fast so the run is rejected, not lied about.
 * - **No `namedHostId`** (attachment-less suite, the suite's own config): use
 *   `hostConfigsV2:getSuiteConfig`, falling back to the default MCPJam host when
 *   the suite never wrote a v2 config — so the run still has a concrete host
 *   rather than executing with null/emulated metadata.
 */
export async function loadSuiteHostConfig(
  convexClient: ConvexHttpClient,
  suiteId?: string,
  namedHostId?: string,
  options?: {
    /**
     * Refuse, rather than fall back to the default host, when the suite's
     * config cannot be read. For a caller that enforces the host's
     * authorization policy from this config: the default host has none, so a
     * failed read would connect without it. A suite with no config on record
     * still gets the default host.
     */
    failClosed?: boolean;
  },
): Promise<Record<string, unknown>> {
  if (namedHostId) {
    let host: { config?: unknown } | null;
    try {
      host = await convexClient.query("hosts:getHost" as any, {
        hostId: namedHostId,
      });
    } catch {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Attached host "${namedHostId}" could not be loaded.`,
      );
    }
    if (!isRecord(host?.config)) {
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        `Attached host "${namedHostId}" was not found for this run.`,
      );
    }
    return host.config;
  }

  if (suiteId) {
    try {
      const config = await convexClient.query(
        "hostConfigsV2:getSuiteConfig" as any,
        { suiteId },
      );
      if (isRecord(config)) return config;
    } catch (error) {
      if (options?.failClosed) {
        const refusal = new WebRouteError(
          502,
          ErrorCode.INTERNAL_ERROR,
          "Couldn't load this suite's host settings, so the run was stopped to avoid connecting with the wrong authorization policy.",
        );
        refusal.cause = error;
        throw refusal;
      }
      // Fall through to the default host below.
    }
  }

  // No named host and no suite config on record: default to the MCPJam house
  // host so the run is never hostless. "mcpjam" carries no `harness`, so this
  // stays an emulated run — it just gives downstream policy/context resolution
  // a real host instead of null.
  return emptyHostConfigInputV2({
    hostStyle: DEFAULT_HOST_STYLE_V2,
  }) as Record<string, unknown>;
}
