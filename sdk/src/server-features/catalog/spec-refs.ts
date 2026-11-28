/**
 * Pinned specification sources for the feature catalog (KES-886 audit 2).
 * A source refresh is a reviewed change: re-pin here, then update stages and
 * lifecycles in the catalog files. Builds never fetch these.
 */

import type { FeatureSpecRef, FeatureSpecSource } from "../types.js";

export const SPEC_CHECKED_AT = "2026-11-16";

export const SPEC_PINS = {
  core: "modelcontextprotocol@5ea99602",
  "ext-apps": "ext-apps@ea3e9d0e",
  "ext-tasks": "ext-tasks@cc9aaac",
  "ext-skills": "ext-skills@649f7aee8",
  "ext-events": "ext-events@47d95c979",
  "ext-auth": "ext-auth@15ca394e0",
  "ext-server-card": "ext-server-card@526201bbc",
  "openai-mcp-extensions": "openai/mcp-extensions@39f91ad",
  "openai-apps-sdk": "openai-apps-sdk-docs@2026-11-16",
  experimental: "modelcontextprotocol@5ea99602",
} as const satisfies Record<FeatureSpecSource, string>;

const SPEC_SITE = "https://modelcontextprotocol.io";

/** Core specification page for a revision, e.g. ("2025-06-18", "server/tools"). */
export function coreSpec(
  version: string,
  path: string,
  anchor?: string,
): FeatureSpecRef {
  return {
    url: `${SPEC_SITE}/specification/${version}/${path}${anchor ? `#${anchor}` : ""}`,
    source: "core",
    pin: SPEC_PINS.core,
    checkedAt: SPEC_CHECKED_AT,
  };
}

/** Page under modelcontextprotocol.io/extensions/… for an official extension. */
export function extensionSpec(
  source: Exclude<
    FeatureSpecSource,
    "core" | "openai-mcp-extensions" | "openai-apps-sdk" | "experimental"
  >,
  path: string,
  anchor?: string,
): FeatureSpecRef {
  return {
    url: `${SPEC_SITE}/extensions/${path}${anchor ? `#${anchor}` : ""}`,
    source,
    pin: SPEC_PINS[source],
    checkedAt: SPEC_CHECKED_AT,
  };
}

/** Any other pinned document, by absolute URL. */
export function externalSpec(
  source: FeatureSpecSource,
  url: string,
): FeatureSpecRef {
  return { url, source, pin: SPEC_PINS[source], checkedAt: SPEC_CHECKED_AT };
}
