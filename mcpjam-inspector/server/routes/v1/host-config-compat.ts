/**
 * `x-mcpjam-host-config-features` — which host-config keys a `/v1` caller
 * understands.
 *
 * Released SDKs canonicalize a fetched client's config with their own
 * canonicalizer (`EvalSuite.runWithClient`), and it rejects a key it doesn't
 * know inside `modelVisibleMcpToolResults`. `structuredContent` (KES-1007) is
 * such a key, so a caller that doesn't list the feature gets the config
 * without it and keeps the projection it had before the key existed. SDKs
 * from this release on send the header with every request.
 */

import type { Context } from "hono";

export const HOST_CONFIG_FEATURES_HEADER = "x-mcpjam-host-config-features";
export const MODEL_VISIBLE_STRUCTURED_CONTENT_FEATURE =
  "model-visible-structured-content";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Whether the caller listed the feature in the header (comma-separated). */
export function acceptsModelVisibleStructuredContent(c: Context): boolean {
  const raw = c.req.header(HOST_CONFIG_FEATURES_HEADER);
  if (!raw) return false;
  return raw
    .split(",")
    .map((feature) => feature.trim())
    .includes(MODEL_VISIBLE_STRUCTURED_CONTENT_FEATURE);
}

/** The config without `modelVisibleMcpToolResults.structuredContent`. */
export function withoutModelVisibleStructuredContent(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const policy = config.modelVisibleMcpToolResults;
  if (!isRecord(policy) || !("structuredContent" in policy)) return config;
  const { structuredContent: _rule, ...rest } = policy;
  const { modelVisibleMcpToolResults: _policy, ...others } = config;
  return Object.keys(rest).length > 0
    ? { ...others, modelVisibleMcpToolResults: rest }
    : others;
}

/** The stored config as this caller can read it. */
export function hostConfigForCaller(
  c: Context,
  config: Record<string, unknown>,
): Record<string, unknown> {
  c.header("Vary", HOST_CONFIG_FEATURES_HEADER, { append: true });
  return acceptsModelVisibleStructuredContent(c)
    ? config
    : withoutModelVisibleStructuredContent(config);
}
