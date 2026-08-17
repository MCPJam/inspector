/**
 * SEP-1865 effective UI metadata resolution, shared by both widget-content
 * routes (local `routes/apps/mcp-apps/index.ts` and hosted
 * `routes/web/apps.ts`).
 *
 * The spec allows `_meta.ui` to appear on the `resources/list` entry, on the
 * `resources/read` content item, or on both, and requires that "Hosts MUST
 * check both locations, preferring the content item and falling back to the
 * listing entry." Resolution order per field:
 *
 *   1. content-item `_meta.ui` from `resources/read`   (canonical)
 *   2. listing `_meta.ui` from `resources/list`        (fallback)
 *   3. legacy Apps SDK `openai/widget*` keys on either  (last resort)
 *
 * The fallback chain is per-field, not all-or-nothing: a widget that
 * publishes only `csp` at the content level and only `prefersBorder` at the
 * listing level should see both honored.
 *
 * This is a plain server module rather than an `@mcpjam/sdk` export on
 * purpose — the SDK's `dist` vs `src` resolution would couple the server to
 * an SDK rebuild for a change that only the two routes consume.
 */

import type {
  McpUiResourceCsp,
  McpUiResourceMeta,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps";

/** Where a single resolved field came from. */
export type MetadataFieldSource = "content" | "listing" | "legacy" | "none";

/**
 * Summary across all fields. `"mixed"` when two fields resolved from
 * different sources — reported alongside the per-field breakdown so the
 * conformance view can tell "content won everywhere" from "content won for
 * csp, listing won for prefersBorder".
 */
export type MetadataSource = MetadataFieldSource | "mixed";

export interface UiResourceMetaSources {
  csp: MetadataFieldSource;
  permissions: MetadataFieldSource;
  prefersBorder: MetadataFieldSource;
}

export interface ResolvedUiResourceMeta {
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  prefersBorder?: boolean;
  /** Per-field breakdown of which source won. */
  metadataSources: UiResourceMetaSources;
  /** Summary of `metadataSources` — `"mixed"` when they disagree. */
  metadataSource: MetadataSource;
}

export interface ResolveUiResourceMetaArgs {
  /** `_meta` from the `resources/read` content item. */
  contentMeta?: Record<string, unknown>;
  /**
   * `_meta` from the matching `resources/list` entry. Best-effort: servers
   * that don't implement `resources/list` (or don't return the URI) simply
   * leave this undefined and the content source wins.
   */
  listingMeta?: Record<string, unknown>;
}

/**
 * Fallback CSP extraction for legacy Apps SDK widgets that declare CSP via
 * `_meta["openai/widgetCSP"]` (snake_case fields: `connect_domains`,
 * `resource_domains`, `frame_domains`) instead of the SEP-1865 `_meta.ui.csp`
 * shape (camelCase). Returns the camelCase shape the sandbox proxy's buildCSP
 * expects, or undefined when no legacy CSP is set or it only contains
 * non-array values.
 */
export function extractLegacyOpenAICsp(
  resourceMeta: Record<string, unknown> | undefined
): McpUiResourceCsp | undefined {
  if (!resourceMeta) return undefined;
  const legacy = resourceMeta["openai/widgetCSP"];
  if (!legacy || typeof legacy !== "object") return undefined;
  const src = legacy as Record<string, unknown>;
  const readArr = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
      : undefined;
  const out: McpUiResourceCsp = {};
  const connect = readArr(src.connect_domains);
  const resource = readArr(src.resource_domains);
  const frame = readArr(src.frame_domains);
  if (connect && connect.length > 0) out.connectDomains = connect;
  if (resource && resource.length > 0) out.resourceDomains = resource;
  if (frame && frame.length > 0) out.frameDomains = frame;
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractLegacyPrefersBorder(
  resourceMeta: Record<string, unknown> | undefined
): boolean | undefined {
  return typeof resourceMeta?.["openai/widgetPrefersBorder"] === "boolean"
    ? (resourceMeta["openai/widgetPrefersBorder"] as boolean)
    : undefined;
}

function readUiMeta(
  meta: Record<string, unknown> | undefined
): McpUiResourceMeta | undefined {
  return (meta as { ui?: McpUiResourceMeta } | undefined)?.ui;
}

/**
 * Resolve the effective `csp` / `permissions` / `prefersBorder` for a UI
 * resource from its content-item and listing `_meta`, per SEP-1865
 * precedence. See the module docstring for the ordering.
 */
export function resolveUiResourceMeta(
  args: ResolveUiResourceMetaArgs
): ResolvedUiResourceMeta {
  const { contentMeta, listingMeta } = args;
  const contentUiMeta = readUiMeta(contentMeta);
  const listingUiMeta = readUiMeta(listingMeta);

  const metadataSources: UiResourceMetaSources = {
    csp: "none",
    permissions: "none",
    prefersBorder: "none",
  };

  // ── csp ──────────────────────────────────────────────────────────────
  const contentLegacyCsp = extractLegacyOpenAICsp(contentMeta);
  const listingLegacyCsp = extractLegacyOpenAICsp(listingMeta);
  let csp: McpUiResourceCsp | undefined;
  if (contentUiMeta?.csp) {
    csp = contentUiMeta.csp;
    metadataSources.csp = "content";
  } else if (listingUiMeta?.csp) {
    csp = listingUiMeta.csp;
    metadataSources.csp = "listing";
  } else if (contentLegacyCsp) {
    csp = contentLegacyCsp;
    metadataSources.csp = "legacy";
  } else if (listingLegacyCsp) {
    csp = listingLegacyCsp;
    metadataSources.csp = "legacy";
  }

  // ── permissions ──────────────────────────────────────────────────────
  // No legacy equivalent: the Apps SDK never shipped a `openai/widget*`
  // permissions key, so this is a two-source chain.
  let permissions: McpUiResourcePermissions | undefined;
  if (contentUiMeta?.permissions) {
    permissions = contentUiMeta.permissions;
    metadataSources.permissions = "content";
  } else if (listingUiMeta?.permissions) {
    permissions = listingUiMeta.permissions;
    metadataSources.permissions = "listing";
  }

  // ── prefersBorder ────────────────────────────────────────────────────
  const contentLegacyPrefersBorder = extractLegacyPrefersBorder(contentMeta);
  const listingLegacyPrefersBorder = extractLegacyPrefersBorder(listingMeta);
  let prefersBorder: boolean | undefined;
  if (contentUiMeta?.prefersBorder !== undefined) {
    prefersBorder = contentUiMeta.prefersBorder;
    metadataSources.prefersBorder = "content";
  } else if (listingUiMeta?.prefersBorder !== undefined) {
    prefersBorder = listingUiMeta.prefersBorder;
    metadataSources.prefersBorder = "listing";
  } else if (contentLegacyPrefersBorder !== undefined) {
    prefersBorder = contentLegacyPrefersBorder;
    metadataSources.prefersBorder = "legacy";
  } else if (listingLegacyPrefersBorder !== undefined) {
    prefersBorder = listingLegacyPrefersBorder;
    metadataSources.prefersBorder = "legacy";
  }

  const usedMetadataSources = new Set(
    Object.values(metadataSources).filter((source) => source !== "none")
  );
  const metadataSource: MetadataSource =
    usedMetadataSources.size === 0
      ? "none"
      : usedMetadataSources.size === 1
      ? (Array.from(usedMetadataSources)[0] as MetadataFieldSource)
      : "mixed";

  return { csp, permissions, prefersBorder, metadataSources, metadataSource };
}
