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
 * The Claude connectors directory half of the Registry tab.
 *
 * This is a MIRROR of Anthropic's public directory (~2,000 entries), synced
 * daily into Convex and read here through `serverCatalogQueries`. It sits
 * beside — never instead of — the hand-curated catalog `useRegistryServers`
 * serves: those are cards MCPJam stands behind, these are upstream facts.
 *
 * Gated by the SAME `REGISTRY_FEATURE_ENABLED` switch as the curated half. A
 * directory that queries while the curated catalog is dark is precisely the
 * half-lit state that flag exists to prevent, so there is one constant and it
 * lives in `useRegistryServers`.
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
  /** A curated card already covers this row; filtered out of `items`. */
  curatedOverlap: boolean;
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

export interface UseClaudeDirectoryOptions {
  enabled?: boolean;
  projectId: string | null;
  isAuthenticated: boolean;
  onConnect: (formData: ServerFormData) => void;
}

export function useClaudeDirectory({
  enabled: callerEnabled = true,
  projectId,
  isAuthenticated,
  onConnect,
}: UseClaudeDirectoryOptions) {
  const enabled = REGISTRY_FEATURE_ENABLED && callerEnabled;

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [tier, setTier] = useState<DirectoryTier>("all");

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
      ...(debouncedQuery ? { q: debouncedQuery } : {}),
      ...(tier === "all" ? {} : { verifiedTier: tier }),
    }),
    [debouncedQuery, tier]
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

  const connectMutation = useMutation(
    "serverCatalogConnect:connectCatalogServer" as any
  );

  // Canonical-wins: a curated card shadows its directory twin. The backend
  // flags the row rather than dropping it, so the filter lives here and the
  // "show duplicates" affordance stays one boolean away.
  const items = useMemo(
    () =>
      enabled
        ? ((results ?? []) as DirectoryServer[]).filter(
            (item) => !item.curatedOverlap
          )
        : [],
    [enabled, results]
  );

  const connectedCatalogIds = useMemo(
    () => new Set((connections ?? []).map((c) => c.catalogServerId)),
    [connections]
  );

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
    async (server: DirectoryServer, endpointUrl?: string) => {
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

      let result: { serverId: string; serverName: string };
      try {
        result = (await connectMutation({
          catalogServerId: server._id,
          projectId,
          ...(endpointUrl ? { endpointUrl } : {}),
        } as any)) as { serverId: string; serverName: string };
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
          url: resolveDirectoryEndpointUrl(server, endpointUrl),
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
    [connectMutation, onConnect, projectId]
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
    connect,
    connections: connections ?? [],
    connectedCatalogIds,
  };
}
