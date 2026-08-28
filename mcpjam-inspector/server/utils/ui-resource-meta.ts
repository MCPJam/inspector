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
  // Canonicalized on the same terms as the SEP-1865 path — a padded or
  // quote-bearing origin declared through the legacy keys reaches the same
  // clamp and the same proxy, so it has the same bypass exposure.
  const readArr = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map(canonicalizeCspSource)
          .filter((x) => x.length > 0)
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

const CSP_DOMAIN_KEYS = [
  "connectDomains",
  "resourceDomains",
  "frameDomains",
  "baseUriDomains",
] as const;

/**
 * Canonicalize one declared CSP source into exactly the string the sandbox
 * proxy will emit, or `""` when the entry can't be represented as a single
 * source (callers drop empties).
 *
 * Every consumer between here and the browser compares these strings
 * verbatim, and two different mismatches have each produced a real bypass of
 * the hosted clamp:
 *
 *   - Padding. `matchesAnyDeny` lower-cases but does NOT trim, so
 *     `" https://mcpjam.com "` matched no deny pattern and survived the
 *     clamp — then the proxy's `sanitizeDomain` trimmed it on the way out and
 *     the browser allowed the protected origin.
 *   - Embedded whitespace. A CSP source list is space-separated, so an entry
 *     like `"https://safe.example https://mcpjam.com"` is ONE value to the
 *     clamp (matching nothing) but TWO sources to the browser once
 *     `buildCSP` joins the list with spaces. Same for a smuggled `*`.
 *
 * Both reduce to the same rule: one array entry must mean one source, spelled
 * the same way here as at the point of enforcement. Whitespace-bearing
 * entries are dropped rather than split — a split would hand the clamp
 * tokens the declaration never legitimately expressed, and a malformed
 * declaration should fail closed.
 *
 * The character strip must stay in lockstep with `sanitizeDomain` in
 * sandbox-proxy.html (`domain.replace(/['"<>;]/g, "").trim()`); if that gains
 * another transform, this has to follow or the gap reopens.
 */
function canonicalizeCspSource(value: string): string {
  const stripped = value.replace(/['"<>;]/g, "").trim();
  // Any interior whitespace means this entry would fan out into multiple
  // CSP sources at emit time, past whatever the clamp inspected.
  if (/\s/.test(stripped)) return "";
  if (hasTrailingDotHost(stripped)) return "";
  return stripped;
}

/**
 * True when the source's host ends in the root-zone dot (`https://localhost.`,
 * `*.mcpjam.com.`).
 *
 * A terminal dot spells the same host to DNS and to the browser, but not to
 * the clamp: `isDangerousHostname` tests `host === "localhost"` and
 * `host.endsWith(".localhost")`, and `matchesAnyDeny` compares deny patterns
 * as plain strings — the dotted spelling matches neither, so `https://localhost.`
 * survives the loopback clamp and `https://mcpjam.com.` survives the MCPJam
 * clamp, while the browser resolves both to the protected target. (IPv4
 * literals are safe: the URL parser already strips the dot from `127.0.0.1.`.)
 *
 * Dropped rather than rewritten, on the same reasoning as whitespace: a
 * declaration has no legitimate need for the root-dot spelling, and rewriting
 * it would mean this helper deciding what the App "meant".
 */
function hasTrailingDotHost(source: string): boolean {
  try {
    return new URL(source).hostname.endsWith(".");
  } catch {
    // Schemeless / wildcard forms (`*.example.com.`, `example.com.`) don't
    // parse as URLs. Fall back to the host-ish prefix before any path.
    const hostish = source.split("/")[0];
    return hostish.endsWith(".") && hostish !== ".";
  }
}

/**
 * A plain `{}` — not an array, not a `Date`/`Map`/class instance.
 *
 * Over MCP, `_meta` arrives as parsed JSON, so exotic objects can't reach
 * here on the live path; this keeps the predicate honest about what it
 * claims to check rather than closing a reachable hole.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Coerce a resource-declared `_meta.ui.csp` into a shape the downstream CSP
 * builders can actually consume.
 *
 * `_meta` is server-controlled and unvalidated. The consumers assume every
 * domain field is a `string[]`: the SDK resolver spreads them
 * (`[...(value.connectDomains ?? [])]`, which THROWS on a number) and the
 * sandbox proxy's `buildCSP` iterates them. A truthy-but-malformed
 * declaration would therefore take down the render rather than degrade.
 *
 * That path matters more now that the routes report the declaration even for
 * `cspMode: "permissive"` requests — scenario / minimal surfaces used to be
 * shielded from a malformed declaration by the withholding this PR removed.
 *
 * Any plain object counts as a declaration, and emptiness is meaningful:
 * `{ connectDomains: [] }` and a bare `{}` both say "allow nothing here",
 * which is a real deny-by-default choice rather than a missing one. Treating
 * either as absent would let a lower-precedence source (the listing entry or
 * legacy keys) supply a BROADER policy than the content item asked for —
 * inverting the precedence SEP-1865 requires, in the widening direction.
 *
 * Only a structurally invalid value — a string, number, array, or null —
 * is rejected outright, so resolution falls through rather than reporting a
 * phantom declaration. Within a valid object, non-array fields and
 * non-string entries are dropped individually; a field that survives as
 * nothing is deny-by-default, again the safe direction.
 */
function normalizeCsp(value: unknown): McpUiResourceCsp | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const src = value as Record<string, unknown>;
  const out: McpUiResourceCsp = {};
  for (const key of CSP_DOMAIN_KEYS) {
    const list = src[key];
    if (!Array.isArray(list)) continue;
    out[key] = list
      .filter((d): d is string => typeof d === "string")
      .map(canonicalizeCspSource)
      .filter((d) => d.length > 0);
  }
  return out;
}

/**
 * Normalize `_meta.ui.permissions`. SEP-1865 declares each requested
 * permission as an empty object (`{}`), and the renderer grants on plain
 * truthiness (`if (v) resourcePermsMap[k] = true`) — so a malformed
 * `{ camera: "yes" }` would be read as a genuine camera request. Marker
 * values are checked individually and anything that isn't a plain object is
 * dropped rather than granted.
 *
 * Deliberately key-agnostic: every surviving marker is rewritten to the
 * canonical `{}`, but the key set is not enumerated. Hard-coding today's four
 * permissions would silently discard any the spec adds later, trading a
 * malformed-input bug for a spec-drift one.
 */
function normalizePermissions(
  value: unknown
): McpUiResourcePermissions | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, Record<string, never>> = {};
  for (const [key, marker] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (isPlainObject(marker)) {
      out[key] = {};
    }
  }
  return out as McpUiResourcePermissions;
}

interface NormalizedUiMeta {
  csp?: McpUiResourceCsp;
  permissions?: McpUiResourcePermissions;
  prefersBorder?: boolean;
}

function readUiMeta(
  meta: Record<string, unknown> | undefined
): NormalizedUiMeta {
  const ui = (meta as { ui?: McpUiResourceMeta } | undefined)?.ui;
  if (!ui || typeof ui !== "object" || Array.isArray(ui)) return {};
  return {
    csp: normalizeCsp(ui.csp),
    permissions: normalizePermissions(ui.permissions),
    // Anything non-boolean is a malformed declaration, not a `false`.
    prefersBorder:
      typeof ui.prefersBorder === "boolean" ? ui.prefersBorder : undefined,
  };
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

/**
 * Page cap for the `resources/list` lookup below.
 *
 * `resources/list` is paginated and the listing declaration can live on any
 * page, so the walk has to follow `nextCursor`. It cannot follow it forever:
 * this runs on every widget render, ahead of the App's HTML, so an unbounded
 * walk makes each render on a large catalog pay that catalog's full
 * enumeration in sequential round-trips.
 *
 * The bound is set high enough to cover realistic catalogs rather than to
 * ration requests — most servers answer on page one, and
 * `canSkipListingLookup` removes the request entirely for the common
 * fully-declared resource. Hitting the cap is reported through `onSkipped`
 * rather than passing silently, so a truncated walk is diagnosable instead of
 * looking like "no declaration".
 */
const LISTING_LOOKUP_MAX_PAGES = 20;

interface ResourceListingClient {
  listResources(
    serverId: string,
    params?: { cursor?: string }
  ): Promise<unknown>;
}

/**
 * True when the content item's canonical `_meta.ui` already supplies every
 * field the resolver reads, so no lower-precedence source could change the
 * outcome and the `resources/list` round-trip is pure cost.
 *
 * Only the canonical block counts. Legacy `openai/widget*` keys rank BELOW
 * the listing's `_meta.ui`, so a content item carrying only legacy metadata
 * must still consult the listing.
 */
export function canSkipListingLookup(
  contentMeta: Record<string, unknown> | undefined
): boolean {
  const ui = readUiMeta(contentMeta);
  return (
    ui.csp !== undefined &&
    ui.permissions !== undefined &&
    ui.prefersBorder !== undefined
  );
}

/**
 * Best-effort lookup of a resource's `resources/list` `_meta`, following
 * pagination and stopping as soon as the URI is found.
 *
 * Returns undefined when the server doesn't implement `resources/list`, the
 * URI isn't listed, or the walk is cut short — all of which leave the caller
 * with the content-item metadata it already had. Never throws: the listing is
 * a fallback, so a failure here must not fail the render.
 */
export async function findListingMetaForUri(
  manager: ResourceListingClient,
  serverId: string,
  resourceUri: string,
  onSkipped?: (reason: string) => void
): Promise<Record<string, unknown> | undefined> {
  try {
    let cursor: string | undefined;
    // A server that keeps handing back a cursor it already issued would
    // otherwise spin until the page cap, turning one broken server into
    // `LISTING_LOOKUP_MAX_PAGES` pointless round-trips on every render.
    const seenCursors = new Set<string>();
    for (let page = 0; page < LISTING_LOOKUP_MAX_PAGES; page++) {
      const listing = (await manager.listResources(
        serverId,
        // Presence, not truthiness: `""` is a valid continuation cursor.
        cursor !== undefined ? { cursor } : undefined
      )) as
        | {
            resources?: Array<{ uri?: unknown; _meta?: unknown }>;
            nextCursor?: unknown;
          }
        | undefined;

      const match = listing?.resources?.find((r) => r?.uri === resourceUri);
      if (match?._meta && typeof match._meta === "object") {
        return match._meta as Record<string, unknown>;
      }

      const nextCursor = listing?.nextCursor;
      // Found the entry but it carries no `_meta`, or the server is done
      // paginating — either way there is nothing further to read. "Done" means
      // NO cursor: MCP 2026-07-28 `server/utilities/pagination` makes `""` a
      // valid cursor that MUST NOT be treated as the end of results, so an
      // empty string keeps the walk going (and joins `seenCursors`, so a
      // server looping on `""` still trips the repeated-cursor guard below).
      if (match || typeof nextCursor !== "string") {
        return undefined;
      }
      if (seenCursors.has(nextCursor)) {
        // Report the fact, not the value: pagination cursors are opaque
        // server-generated tokens and implementations encode internal state
        // in them. "The server repeated a cursor" is the whole diagnostic;
        // the token itself adds nothing and puts server-side identifiers
        // into our debug logs.
        onSkipped?.(
          `resources/list repeated a pagination cursor after ${
            page + 1
          } page(s) — stopping`
        );
        return undefined;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    onSkipped?.(
      `resource not found within the first ${LISTING_LOOKUP_MAX_PAGES} listing pages`
    );
    return undefined;
  } catch (err) {
    onSkipped?.(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
