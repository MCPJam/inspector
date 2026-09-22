import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaginatedQuery, useQuery, useMutation } from "convex/react";
import { ConvexError } from "convex/values";
import type { ServerFormData } from "@/shared/types.js";
import { REGISTRY_FEATURE_ENABLED } from "@/hooks/useRegistryServers";
import {
  parseDirectoryServerDetail,
  type DirectoryServerDetail,
} from "@/lib/claude-directory-detail";
import {
  clearPendingQuickConnect,
  writePendingQuickConnect,
  type PendingQuickConnectState,
} from "@/lib/quick-connect-pending";

/**
 * The upstream-directory half of the Registry tab.
 *
 * Two mirrors, one surface: Anthropic's Claude connectors directory (~2,000
 * entries, synced daily) and OpenAI's ChatGPT app directory (~2,900 entries,
 * uploaded weekly). These sit beside the organization's own shelf as the
 * public catalogs on the Registry tab.
 *
 * ONE SOURCE AT A TIME, Claude by default. The backend's browse and search are
 * source-scoped index reads, so a "both" mode would be a second query and a
 * merge with no defensible ordering — and the facet is how a person says which
 * catalog they are looking at, which is information the cards themselves
 * cannot carry as clearly.
 *
 * Gated by the same `REGISTRY_FEATURE_ENABLED` switch as the rest of the
 * Registry tab, so a directory that queries while the route is dark cannot
 * half-light the screen. The constant still lives in `useRegistryServers`.
 */

/** How many cards a page carries. Matches the grid's two-column rhythm. */
const DIRECTORY_PAGE_SIZE = 24;

/** Long enough that typing a word is one query, short enough to feel live. */
const SEARCH_DEBOUNCE_MS = 250;

export const DIRECTORY_TIERS = [
  "all",
  "anthropic",
  "partner",
  "community",
] as const;
export type DirectoryTier = (typeof DIRECTORY_TIERS)[number];

export const DIRECTORY_SOURCES = [
  "anthropic-directory",
  "chatgpt-directory",
] as const;
export type DirectorySource = (typeof DIRECTORY_SOURCES)[number];

/** Claude's directory is the daily, reliable one; it is what opens. */
export const DEFAULT_DIRECTORY_SOURCE: DirectorySource = "anthropic-directory";

export const DIRECTORY_SOURCE_LABELS: Record<DirectorySource, string> = {
  "anthropic-directory": "Claude directory",
  "chatgpt-directory": "ChatGPT directory",
};

/**
 * The card badge. "Listed in ChatGPT" is PROVENANCE, deliberately not a
 * quality claim: OpenAI accepting a submission is not a verification tier of
 * ours, and their own docs distinguish connectors they maintain from
 * third-party remote servers.
 */
export const DIRECTORY_SOURCE_BADGES: Record<DirectorySource, string> = {
  "anthropic-directory": "From Claude directory",
  "chatgpt-directory": "Listed in ChatGPT",
};

/**
 * Verification tiers are a CLAUDE concept. The ChatGPT directory publishes no
 * equivalent, so the facet is hidden there rather than shown filtering nothing
 * — an always-empty filter reads as "no partners listed", which is false.
 */
export function sourceHasTiers(source: DirectorySource): boolean {
  return source === "anthropic-directory";
}

/**
 * Is this string one of the sources we have copy for?
 *
 * `Object.hasOwn`, not `in`: a row's `source` is a plain string off the wire,
 * and `in` walks the prototype chain — a source named `toString` would "match"
 * and index to a function, rendering "the function toString() { [native code]
 * }" into the UI. Own-property is the check the fallbacks below assume.
 */
function isKnownSource(source: string): source is DirectorySource {
  return Object.hasOwn(DIRECTORY_SOURCE_LABELS, source);
}

/** The directory's name, or a generic phrase for a source we do not know. */
export function directorySourceLabel(source: string): string {
  return isKnownSource(source)
    ? DIRECTORY_SOURCE_LABELS[source]
    : "another catalog";
}

/** The card's provenance line, same rule. */
export function directorySourceBadge(source: string): string {
  return isKnownSource(source)
    ? DIRECTORY_SOURCE_BADGES[source]
    : "From an upstream directory";
}

/** Why a REMOTE row cannot be connected. See `catalogServers` in the schema. */
export type DirectoryUnavailableReason =
  | "endpoint_hidden"
  | "endpoint_unverified"
  | "oauth_no_resource";

/**
 * The OAuth-registration probe verdict on a summary row — OUR derivation
 * from the server's public authorization metadata, never part of the
 * upstream listing. Written only by the backend's nightly sweep.
 */
export interface DirectoryOAuthProbe {
  probedAt: number;
  /** The URL the verdict is about; a changed endpoint voids it. */
  endpointUrl: string;
  outcome: "resolved" | "no_metadata" | "unreachable";
  /** Present only when `outcome` is `resolved`. */
  supportsDcr?: boolean;
  supportsCimd?: boolean;
  authorizationServerUrl?: string;
}

/** One row of `serverCatalogQueries:searchCatalogServers`. */
export interface DirectoryServer {
  _id: string;
  source: string;
  sourceId: string;
  serverName: string;
  displayName: string;
  description?: string;
  iconUrl?: string;
  verifiedTier?: string;
  rowType: "remote" | "local";
  endpointKind: "fixed" | "options" | "tenant" | "none";
  remoteUrl?: string;
  remoteUrlOptions?: string[];
  remoteUrlRegex?: string;
  isAuthless?: boolean;
  /** The published OAuth resource. NOT an endpoint — provenance only. */
  oauthResourceUrl?: string;
  endpointConfidence?: "explicit" | "resource_verified" | "probe_verified";
  unavailableReason?: DirectoryUnavailableReason;
  authPosture?: string;
  oauthProbe?: DirectoryOAuthProbe;
  /** A curated card already covers this row; filtered out of `items`. */
  curatedOverlap: boolean;
}

/**
 * Should this row carry the "Requires pre-registered client" badge?
 *
 * `resolved` verdicts ONLY. A `no_metadata` or `unreachable` outcome is
 * indistinguishable from a server that does not do OAuth discovery at all,
 * so those render nothing rather than an accusation the probe cannot back.
 *
 * The verdict is about ONE URL (`probe.endpointUrl`), and the ETL never
 * touches `oauthProbe` — so between an endpoint move and the next sweep
 * (≤1 day) a row can hold a verdict about a URL it no longer points at.
 * Badging that would present a fact about the wrong server, so the check
 * mirrors the backend's `probeTargetFor`: `fixed` rows probe `remoteUrl`,
 * `options` rows probe their first published endpoint, and anything else
 * has no probe target and never badges.
 */
export function requiresPreregisteredClient(
  server: Pick<
    DirectoryServer,
    "oauthProbe" | "endpointKind" | "remoteUrl" | "remoteUrlOptions"
  >
): boolean {
  const probe = server.oauthProbe;
  if (probe?.outcome !== "resolved") return false;
  if (probe.supportsDcr || probe.supportsCimd) return false;
  const target =
    server.endpointKind === "fixed"
      ? server.remoteUrl
      : server.endpointKind === "options"
        ? server.remoteUrlOptions?.[0]
        : undefined;
  return target !== undefined && probe.endpointUrl === target;
}

/**
 * Can this row be connected at all?
 *
 * Keyed on `endpointKind`, but the COPY beside it must not be — see
 * `describeUnavailable`. A `none` row is a local desktop extension on one
 * source and a hosted server with a hidden endpoint on the other.
 */
export function isConnectableDirectoryRow(
  server: Pick<DirectoryServer, "endpointKind">
): boolean {
  return server.endpointKind !== "none";
}

/**
 * Why this particular row cannot be connected, in words that are true of it.
 *
 * About 37% of the ChatGPT directory is a hosted SaaS server whose endpoint
 * OpenAI proxies and never publishes. Telling someone that is a "local desktop
 * extension" sends them looking for an installer that does not exist, so the
 * text keys on `unavailableReason` first and `rowType` only as the fallback.
 */
export function describeUnavailable(
  server: Pick<DirectoryServer, "rowType" | "unavailableReason">
): string {
  switch (server.unavailableReason) {
    case "endpoint_hidden":
      return "Endpoint not published by the directory that lists it.";
    case "endpoint_unverified":
      return "Endpoint unverified — nothing answered as an MCP server.";
    case "oauth_no_resource":
      return "No endpoint published for this listing yet.";
    default:
      return server.rowType === "local"
        ? "Local desktop extension — not a remote MCP server."
        : "No endpoint to connect to.";
  }
}

/** One row of `serverCatalogQueries:getProjectCatalogConnections`. */
export interface DirectoryConnection {
  _id: string;
  catalogServerId: string;
  serverId: string;
  serverName: string | null;
  endpointUrl: string;
  endpointKind: "fixed" | "options" | "tenant";
}

/**
 * What `connectCatalogServer` did.
 *
 * `existing_endpoint` is the cross-source case: this workspace already talks
 * to the same URL through the OTHER directory's row, so the backend hands back
 * that connection rather than installing a duplicate. The UI needs to say so —
 * silently returning someone else's server would look like nothing happened.
 */
export interface DirectoryConnectResult {
  serverId: string;
  serverName: string;
  outcome: "created" | "reconnected" | "existing_endpoint";
  /**
   * Present on `existing_endpoint`: the URL that connection actually holds.
   * The match is CANONICAL, so it can differ from this card's `remoteUrl` in
   * exactly the ways canonicalization forgives, and it is the authoritative
   * one — see `resolveDirectoryEndpointUrl`.
   */
  endpointUrl?: string;
  existing?: {
    catalogServerId: string;
    source: string;
    displayName: string;
  };
}

/** "Already connected via the Claude directory", for an `existing_endpoint`. */
export function describeExistingConnection(
  result: DirectoryConnectResult
): string | null {
  if (result.outcome !== "existing_endpoint") return null;
  // A source we have no label for is still a real connection; naming it "the
  // undefined directory" would be worse than being vague. The article moves
  // with the phrase — "via the Claude directory" but "via another catalog" —
  // so the helper owns both halves rather than the sentence assuming one.
  const source = result.existing?.source;
  const phrase =
    source && isKnownSource(source)
      ? `the ${DIRECTORY_SOURCE_LABELS[source]}`
      : "another catalog";
  return `Already connected via ${phrase}.`;
}

/**
 * Every way `connectCatalogServer` can refuse, plus the two failure modes
 * that never reach it.
 */
export type DirectoryConnectErrorCode =
  | "catalog_server_not_found"
  | "catalog_server_removed"
  | "catalog_server_not_connectable"
  | "endpoint_url_required"
  | "endpoint_url_not_configurable"
  | "endpoint_url_not_allowed"
  | "endpoint_url_invalid"
  | "endpoint_pattern_unusable"
  | "catalog_server_missing_endpoint"
  | "already_connected_to_different_endpoint"
  | "server_name_conflict"
  /** No project selected — nothing to install into. */
  | "project_required"
  /**
   * Raised HERE, never sent by the backend: an `existing_endpoint` result
   * arrived without the URL that connection holds, so there is no
   * authoritative endpoint to connect with. See `resolveConnectedEndpointUrl`.
   */
  | "existing_connection_missing_endpoint"
  /** Anything the backend did not tag, including a plain network failure. */
  | "unknown";

/**
 * A connect refusal in ONE shape, whoever is asking.
 *
 * The card, the endpoint dialog and the agent tool all need the same three
 * facts — which code, what to say, and (for `endpoint_url_required`) what the
 * caller may choose from. Normalizing once means the dialog and the agent
 * cannot drift into disagreeing about what a code means.
 */
export class DirectoryConnectError extends Error {
  readonly code: DirectoryConnectErrorCode;
  /** `endpoint_url_required` / `endpoint_url_not_allowed` on an options row. */
  readonly options?: string[];
  /** `endpoint_url_required` / `endpoint_url_not_allowed` on a tenant row. */
  readonly pattern?: string;
  /** `already_connected_to_different_endpoint`: where it is connected now. */
  readonly connectedUrl?: string;
  /** `endpoint_url_not_configurable`: the fixed URL that cannot be overridden. */
  readonly expected?: string;

  constructor(
    code: DirectoryConnectErrorCode,
    message: string,
    extra: {
      options?: string[];
      pattern?: string;
      connectedUrl?: string;
      expected?: string;
    } = {}
  ) {
    super(message);
    this.name = "DirectoryConnectError";
    this.code = code;
    this.options = extra.options;
    this.pattern = extra.pattern;
    this.connectedUrl = extra.connectedUrl;
    this.expected = extra.expected;
  }
}

const CONNECT_ERROR_CODES = new Set<string>([
  "catalog_server_not_found",
  "catalog_server_removed",
  "catalog_server_not_connectable",
  "endpoint_url_required",
  "endpoint_url_not_configurable",
  "endpoint_url_not_allowed",
  "endpoint_url_invalid",
  "endpoint_pattern_unusable",
  "catalog_server_missing_endpoint",
  "already_connected_to_different_endpoint",
  "server_name_conflict",
  "project_required",
]);

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string");
  return strings.length > 0 ? strings : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Turn whatever came back off the wire into a `DirectoryConnectError`.
 *
 * Convex masks a plain `Error`'s message in production, so only a
 * `ConvexError` carries a code worth reading; anything else — a network
 * failure, a masked throw, a bug — is `unknown` with a generic message rather
 * than a guess dressed up as a diagnosis.
 *
 * The `data` payload is read defensively (it crossed a wire) but the codes are
 * NOT re-derived from message text: string-matching a message is how an error
 * mapping silently breaks when someone improves the wording.
 */
export function normalizeDirectoryConnectError(
  error: unknown
): DirectoryConnectError {
  if (error instanceof DirectoryConnectError) return error;
  if (error instanceof ConvexError) {
    const data: unknown =
      typeof error.data === "string" ? safeParse(error.data) : error.data;
    const record = (data ?? {}) as Record<string, unknown>;
    const code = optionalString(record.code);
    if (code && CONNECT_ERROR_CODES.has(code)) {
      return new DirectoryConnectError(
        code as DirectoryConnectErrorCode,
        optionalString(record.message) ?? "Could not connect this server.",
        {
          options: stringArray(record.options),
          pattern: optionalString(record.pattern),
          connectedUrl: optionalString(record.connectedUrl),
          expected: optionalString(record.expected),
        }
      );
    }
  }
  return new DirectoryConnectError(
    "unknown",
    error instanceof Error && error.message
      ? error.message
      : "Could not connect this server."
  );
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The URL a connect will actually use, given the row and any user choice. */
export function resolveDirectoryEndpointUrl(
  server: Pick<DirectoryServer, "endpointKind" | "remoteUrl">,
  endpointUrl?: string
): string | undefined {
  return server.endpointKind === "fixed" ? server.remoteUrl : endpointUrl;
}

/**
 * The URL to hand `onConnect` once the mutation has spoken.
 *
 * On `existing_endpoint` the mutation matched an existing connection by
 * CANONICAL URL and returned that connection — so the URL it holds can differ
 * from this card's in the ways canonicalization forgives (a trailing slash,
 * host casing). Connecting with this card's spelling would then rewrite the
 * stored endpoint of a server this click did not create, and the OAuth
 * resource indicator bound to that URL with it. The mutation's answer wins;
 * the card's URL is only the question that was asked.
 */
export function resolveConnectedEndpointUrl(
  server: Pick<DirectoryServer, "endpointKind" | "remoteUrl">,
  result: Pick<DirectoryConnectResult, "outcome" | "endpointUrl">,
  requestedUrl?: string
): string | undefined {
  if (result.outcome === "existing_endpoint") {
    // REFUSE rather than fall through. The fallback below is this card's own
    // spelling — the one value that must never be used for this outcome, since
    // connecting with it rewrites the stored endpoint of a server this click
    // did not create. A result that omits the URL is a backend predating the
    // field, and the two deploy separately, so that window is real rather than
    // theoretical. A refusal is visible; the wrong connect would not be.
    if (!result.endpointUrl) {
      throw new DirectoryConnectError(
        "existing_connection_missing_endpoint",
        "This endpoint is already connected, but the existing connection did not report its URL — it has been left unchanged."
      );
    }
    return result.endpointUrl;
  }
  return resolveDirectoryEndpointUrl(server, requestedUrl);
}

/** True when connecting this row needs the user to supply or pick a URL. */
export function requiresEndpointChoice(
  server: Pick<DirectoryServer, "endpointKind">
): boolean {
  return server.endpointKind === "options" || server.endpointKind === "tenant";
}

/**
 * The full upstream row behind one directory card, parsed for the detail
 * dialog.
 *
 * The card renders from the blob-free summary row; everything richer — tool
 * names, the long description, publisher links, permissions — lives only in
 * the ~5KB `rawJson` payload, fetched here one entry at a time when a card is
 * actually opened. `getCatalogServer` is a public query (the catalog mirrors
 * a public directory), so this needs no auth.
 *
 * Returns:
 *   `undefined` — still loading (or `catalogServerId` is null / feature dark).
 *   `null`      — no such row, or its body failed to parse; the dialog falls
 *                 back to the summary it already has.
 */
export function useDirectoryServerDetail(
  catalogServerId: string | null
): DirectoryServerDetail | null | undefined {
  const enabled = REGISTRY_FEATURE_ENABLED && catalogServerId !== null;
  const result = useQuery(
    "serverCatalogQueries:getCatalogServer" as any,
    // `includeRaw` because the upstream row is what the dialog renders.
    // `serverJson` embeds the same row under `_meta`, but is null for the few
    // entries whose generated server.json failed validation — `rawJson` is
    // authoritative for both.
    enabled ? ({ catalogServerId, includeRaw: true } as any) : "skip"
  ) as { rawJson?: string | null } | null | undefined;

  return useMemo(() => {
    if (!enabled || result === undefined) return undefined;
    if (result === null) return null;
    return parseDirectoryServerDetail(result.rawJson ?? null);
  }, [enabled, result]);
}

export interface UseServerDirectoryOptions {
  enabled?: boolean;
  projectId: string | null;
  isAuthenticated: boolean;
  onConnect: (formData: ServerFormData) => void;
}

/** One entry of `serverCatalogQueries:getCatalogSourceStatus`. */
export interface DirectorySourceStatus {
  source: string;
  lastSyncedAt: number | null;
  liveCount: number | null;
  upstreamFetchedAt: number | null;
}

export function useServerDirectory({
  enabled: callerEnabled = true,
  projectId,
  isAuthenticated,
  onConnect,
}: UseServerDirectoryOptions) {
  const enabled = REGISTRY_FEATURE_ENABLED && callerEnabled;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tier, setTier] = useState<DirectoryTier>("all");
  const [source, setSource] = useState<DirectorySource>(
    DEFAULT_DIRECTORY_SOURCE
  );
  // OFF by default. About 37% of the ChatGPT directory has no published
  // endpoint, and hiding a third of a catalog before anyone asked would make
  // the directory look smaller than it is — the full census is the point.
  const [connectableOnly, setConnectableOnly] = useState(false);

  useEffect(() => {
    const handle = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      SEARCH_DEBOUNCE_MS
    );
    return () => window.clearTimeout(handle);
  }, [query]);

  // A blank query is OMITTED, not sent as "". The backend treats the two the
  // same (blank normalizes to browse), but sending the empty string would make
  // every keystroke-to-empty a different query key and refetch page 1 of a
  // listing we already have.
  const searchArgs = useMemo(
    () => ({
      source,
      ...(debouncedQuery ? { q: debouncedQuery } : {}),
      // A tier the current source does not publish is not sent at all — it
      // would filter every row out and read as an empty directory.
      ...(tier === "all" || !sourceHasTiers(source)
        ? {}
        : { verifiedTier: tier }),
      // `connectableOnly`, NOT `endpointKind: 'fixed'`. `options` (pick a
      // region) and `tenant` (supply your own instance URL) rows are
      // connectable too — they just ask a question first — and filtering to
      // `fixed` would hide every one of them behind a toggle that claims to
      // hide only what cannot be installed.
      //
      // Server-side rather than over `items`, so `canLoadMore` keeps agreeing
      // with what is on screen; filtering in the hook desyncs the two.
      ...(connectableOnly ? { connectableOnly: true } : {}),
    }),
    [connectableOnly, debouncedQuery, source, tier]
  );

  const {
    results,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    "serverCatalogQueries:searchCatalogServers" as any,
    enabled ? (searchArgs as any) : "skip",
    { initialNumItems: DIRECTORY_PAGE_SIZE }
  );

  const connections = useQuery(
    "serverCatalogQueries:getProjectCatalogConnections" as any,
    enabled && isAuthenticated && projectId ? ({ projectId } as any) : "skip"
  ) as DirectoryConnection[] | undefined;

  // Public, so a signed-out browser still sees how fresh each mirror is. One
  // of the two is a manual weekly upload, which makes "as of" a real product
  // fact rather than an operational detail.
  const sourceStatuses = useQuery(
    "serverCatalogQueries:getCatalogSourceStatus" as any,
    enabled ? ({} as any) : "skip"
  ) as DirectorySourceStatus[] | undefined;

  const connectMutation = useMutation(
    "serverCatalogConnect:connectCatalogServer" as any
  );

  // The curated global catalog is retired, so leftover overlap flags no
  // longer hide a directory row. Show every result the page returned.
  const items = useMemo(
    () => (enabled ? ((results ?? []) as DirectoryServer[]) : []),
    [enabled, results]
  );

  const connectedCatalogIds = useMemo(
    () => new Set((connections ?? []).map((c) => c.catalogServerId)),
    [connections]
  );

  /**
   * Switching source clears the tier, because tiers belong to one source and
   * a filter that survives the switch would silently narrow a catalog that
   * never had those tiers to begin with.
   */
  const selectSource = useCallback((next: DirectorySource) => {
    setSource(next);
    if (!sourceHasTiers(next)) setTier("all");
  }, []);

  const status_ = sourceStatuses?.find((entry) => entry.source === source);
  const lastSyncedAt =
    // For a snapshot source the SCRAPE time is the honest answer: ingesting on
    // Friday a sweep taken on Tuesday makes the catalog Tuesday-fresh.
    status_?.upstreamFetchedAt ?? status_?.lastSyncedAt ?? null;

  /**
   * Install a directory entry, then hand it to the app's own connect.
   *
   * MUTATION FIRST, deliberately. The mutation validates the endpoint,
   * refuses a tombstoned row, dedupes against an existing connection, writes
   * the audit event and creates the `servers` row — all before anything can
   * redirect the browser. The curated flow does the reverse (client connect
   * first, provenance from a later effect keyed on React state) and loses its
   * provenance whenever OAuth navigates away mid-flight; this ordering cannot.
   *
   * Its success means INSTALLED, not CONNECTED. `onConnect` returns void and
   * an OAuth server continues asynchronously — possibly through a full page
   * navigation — so the caller learns the outcome from the live-servers map,
   * never from this resolving.
   */
  const connect = useCallback(
    async (
      server: DirectoryServer,
      endpointUrl?: string
    ): Promise<
      DirectoryConnectResult & { pending: PendingQuickConnectState }
    > => {
      // Inert while the feature is dark, not merely unrendered. Nothing can
      // reach this today (the agent handler resolves against `items`, which is
      // empty when gated), and that is exactly why it is cheap to guarantee:
      // a future caller must not be the thing that discovers the gap.
      if (!enabled) {
        throw new DirectoryConnectError(
          "unknown",
          "The server directory is not available."
        );
      }
      if (!projectId) {
        throw new DirectoryConnectError(
          "project_required",
          "Select a project before installing a server from the directory."
        );
      }

      let result: DirectoryConnectResult;
      try {
        result = (await connectMutation({
          catalogServerId: server._id,
          projectId,
          ...(endpointUrl ? { endpointUrl } : {}),
        } as any)) as DirectoryConnectResult;
      } catch (error) {
        throw normalizeDirectoryConnectError(error);
      }

      const pending: PendingQuickConnectState = {
        serverName: result.serverName,
        displayName: server.displayName,
        sourceTab: "registry",
        createdAt: Date.now(),
        catalogServerId: server._id,
      };
      // Written BEFORE `onConnect`, because `onConnect` is where an OAuth
      // redirect happens. localStorage survives that navigation; React state
      // does not, which is exactly the curated flow's bug.
      writePendingQuickConnect(pending);

      try {
        onConnect({
          name: result.serverName,
          type: "http",
          url: resolveConnectedEndpointUrl(server, result, endpointUrl),
          // RUNTIME-PROBED, not metadata-trusted. `authMethod: "auto"` runs
          // the discovery path: connect with a stored token if there is one,
          // otherwise unauthenticated, and on a 401 ASK before escalating to
          // OAuth (`confirmAutoOAuthEscalation` in use-server-state.ts). The
          // directory's `is_authless` is upstream metadata that can be stale,
          // and deriving `useOAuth` from it turns a stale `true` into a server
          // that silently never authorizes.
          authMethod: "auto",
          // The COMPAT MIRROR of "auto", not a claim that this server speaks
          // OAuth — exactly what `use-server-form` emits for authType "auto" on
          // an add flow (`useOAuth = !autoSelectsXaa`, and a brand-new server is
          // never XAA-configured). It is load-bearing: `handleConnect` gates the
          // whole discover-and-escalate branch on `formData.useOAuth`, so
          // sending `authMethod` alone would skip discovery and report a raw
          // transport failure for any server that needs authorization.
          useOAuth: true,
        });
      } catch (error) {
        // The marker only makes sense beside a connect that actually started.
        // Rolling it back here keeps the write and its undo in one place —
        // the caller cannot tell whether the throw came from the mutation
        // (nothing written) or from here (written).
        clearPendingQuickConnect();
        throw normalizeDirectoryConnectError(error);
      }

      return { ...result, pending };
    },
    [connectMutation, enabled, onConnect, projectId]
  );

  const status = enabled ? paginationStatus : "Exhausted";

  return {
    items,
    /** Convex pagination status: LoadingFirstPage | CanLoadMore | ... */
    status,
    isLoadingFirstPage: enabled && paginationStatus === "LoadingFirstPage",
    canLoadMore: enabled && paginationStatus === "CanLoadMore",
    loadMore: useCallback(() => loadMore(DIRECTORY_PAGE_SIZE), [loadMore]),
    query,
    setQuery,
    tier,
    setTier,
    source,
    setSource: selectSource,
    connectableOnly,
    setConnectableOnly,
    /** Whether the current source publishes verification tiers at all. */
    hasTiers: sourceHasTiers(source),
    /** When the current source's catalog was last refreshed upstream. */
    lastSyncedAt,
    connect,
    connections: connections ?? [],
    connectedCatalogIds,
  };
}
