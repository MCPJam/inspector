import { useCallback, useState, useEffect } from "react";
import {
  Package,
  KeyRound,
  ShieldOff,
  CheckCircle2,
  Loader2,
  MoreVertical,
  Unplug,
  MonitorSmartphone,
  MessageSquareText,
  ChevronDown,
  BadgeCheck,
  Star,
} from "lucide-react";
import { Card } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import { Badge } from "@mcpjam/design-system/badge";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { EmptyState } from "./ui/empty-state";
import { SearchInput } from "./ui/search-input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  useRegistryServers,
  getRegistryServerName,
  type EnrichedRegistryServer,
  type EnrichedRegistryCatalogCard,
  type RegistryConnectionStatus,
} from "@/hooks/useRegistryServers";
import {
  useServerDirectory,
  requiresEndpointChoice,
  normalizeDirectoryConnectError,
  describeExistingConnection,
  describeUnavailable,
  isConnectableDirectoryRow,
  sourceHasTiers,
  DIRECTORY_SOURCES,
  DIRECTORY_SOURCE_LABELS,
  DEFAULT_DIRECTORY_SOURCE,
  directorySourceBadge,
  DIRECTORY_TIERS,
  type DirectoryServer,
  type DirectorySource,
  type DirectoryTier,
} from "@/hooks/useServerDirectory";
import { DirectoryEndpointDialog } from "./registry/DirectoryEndpointDialog";
import { toast } from "@/lib/toast";
import { formatRegistryStarCount } from "@/lib/format-registry-star-count";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  clearPendingQuickConnect,
  readPendingQuickConnect,
  writePendingQuickConnect,
  type PendingQuickConnectState,
} from "@/lib/quick-connect-pending";
import { useSurfaceAgentBridge } from "@/lib/webmcp/use-surface-agent-bridge";
import { createInspectorCommandClientError } from "@/lib/inspector-command-handlers";
import type {
  ConnectRegistryServerInspectorCommand,
  DisconnectRegistryServerInspectorCommand,
  SearchRegistryDirectoryInspectorCommand,
  ToggleRegistryStarInspectorCommand,
} from "@/shared/inspector-command.js";

/** Drop stale registry pending when OAuth was abandoned (browser closed) without a terminal callback. */
const REGISTRY_PENDING_OAUTH_STALE_MS = 45 * 60 * 1000;

/** Cap the agent snapshot's server list — state overview, not a data dump. */
const AGENT_SNAPSHOT_MAX_SERVERS = 30;

/**
 * How the agent addresses a catalog entry: display name ("Asana"), registry
 * name ("com.asana.mcp"), or the project server name a variant creates
 * ("Asana (App)"). Exact (case-insensitive) matches only — an unknown name
 * must become `unknown_server`, never a fuzzy guess.
 */
function matchesRegistryServerName(
  variant: EnrichedRegistryServer,
  serverName: string
): boolean {
  const wanted = serverName.trim().toLowerCase();
  return (
    variant.name.toLowerCase() === wanted ||
    variant.displayName.toLowerCase() === wanted ||
    getRegistryServerName(variant).toLowerCase() === wanted
  );
}

/**
 * The registry data layer is gated behind REGISTRY_FEATURE_ENABLED. When it's
 * off (or the catalog simply hasn't loaded) every lookup would fail with a
 * confusing "no server matches" — surface an honest "unavailable" instead so
 * a flag-enabled-route-but-feature-off user gets a clear signal, not a fake
 * failure buried in resolution.
 */
function assertRegistryAvailable(cards: readonly unknown[]): void {
  if (cards.length === 0) {
    throw createInspectorCommandClientError(
      "unsupported_in_mode",
      "The registry catalog is empty or unavailable right now — no servers to act on."
    );
  }
}

/** The curated card a name addresses, or `undefined`. Never throws. */
function findRegistryCard(
  cards: EnrichedRegistryCatalogCard[],
  serverName: string
): EnrichedRegistryCatalogCard | undefined {
  return cards.find((c) =>
    c.variants.some((v) => matchesRegistryServerName(v, serverName))
  );
}

function requireRegistryCard(
  cards: EnrichedRegistryCatalogCard[],
  serverName: unknown
): { card: EnrichedRegistryCatalogCard; serverName: string } {
  if (typeof serverName !== "string" || serverName.trim().length === 0) {
    throw createInspectorCommandClientError(
      "invalid_request",
      "Missing required 'serverName' string."
    );
  }
  const card = findRegistryCard(cards, serverName);
  if (!card) {
    throw createInspectorCommandClientError(
      "unknown_server",
      `No registry server matches "${serverName}". Use a name from the registry catalog on this screen.`
    );
  }
  return { card, serverName };
}

/** Pin down ONE variant to connect; dual-type cards force an explicit pick. */
function resolveConnectVariant(
  card: EnrichedRegistryCatalogCard,
  serverName: string,
  variantType: "text" | "app" | undefined
): EnrichedRegistryServer {
  if (variantType) {
    const variant = card.variants.find((v) => v.clientType === variantType);
    if (!variant) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `"${card.variants[0].displayName}" has no ${variantType} variant.`
      );
    }
    return variant;
  }
  const matching = card.variants.filter((v) =>
    matchesRegistryServerName(v, serverName)
  );
  if (matching.length === 1) return matching[0];
  throw createInspectorCommandClientError(
    "invalid_request",
    `"${card.variants[0].displayName}" has both Text and App variants — pass variant: "text" or "app".`
  );
}

/**
 * Is the directory showing anything other than its default view?
 *
 * ONE definition, used by both the section (which hides itself when nothing is
 * loaded and nothing was asked) and the screen-level empty state. Two copies
 * drifted apart the moment a fourth control was added, and the drift is
 * invisible: the section would vanish while the empty state insisted the
 * screen was filtered, or the reverse.
 */
function isDirectoryFiltered(
  directory: Pick<
    ReturnType<typeof useServerDirectory>,
    "query" | "tier" | "connectableOnly" | "source"
  >
): boolean {
  return (
    directory.query.trim().length > 0 ||
    directory.tier !== "all" ||
    directory.connectableOnly ||
    directory.source !== DEFAULT_DIRECTORY_SOURCE
  );
}

/** Cap the agent snapshot's directory list — a state overview, not a dump. */
const AGENT_SNAPSHOT_MAX_DIRECTORY = 15;

/**
 * How the agent addresses a DIRECTORY entry: its display name ("Asana") or
 * its minted catalog name ("com.mcpjam/anthropic-asana-1a2b3c4d"). Exact
 * (case-insensitive) matches only, same rule as the curated resolver — an
 * unknown name must become `unknown_server`, never a fuzzy guess.
 */
function matchesDirectoryServerName(
  item: DirectoryServer,
  serverName: string
): boolean {
  const wanted = serverName.trim().toLowerCase();
  return (
    item.displayName.toLowerCase() === wanted ||
    item.serverName.toLowerCase() === wanted
  );
}

function readDirectoryTier(value: unknown): DirectoryTier | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (DIRECTORY_TIERS as readonly string[]).includes(value)
  ) {
    return value as DirectoryTier;
  }
  throw createInspectorCommandClientError(
    "invalid_request",
    `'tier' must be one of ${DIRECTORY_TIERS.join(", ")} when provided.`
  );
}

function readDirectorySource(value: unknown): DirectorySource | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value === "string" &&
    (DIRECTORY_SOURCES as readonly string[]).includes(value)
  ) {
    return value as DirectorySource;
  }
  throw createInspectorCommandClientError(
    "invalid_request",
    `'source' must be one of ${DIRECTORY_SOURCES.join(", ")} when provided.`
  );
}

const TIER_LABELS: Record<DirectoryTier, string> = {
  all: "All tiers",
  anthropic: "Anthropic",
  partner: "Partner",
  community: "Community",
};

interface RegistryTabProps {
  projectId: string | null;
  isAuthenticated: boolean;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
  onNavigate?: (tab: string) => void;
  servers?: Record<string, ServerWithName>;
}

export function RegistryTab({
  projectId,
  isAuthenticated,
  onConnect,
  onDisconnect,
  onNavigate,
  servers,
}: RegistryTabProps) {
  // isAuthenticated is passed through to the hook for Convex mutation gating,
  // but the registry is always browsable without auth.
  const [connectingIds, setConnectingIds] = useState<Set<string>>(new Set());
  const [pendingQuickConnect, setPendingQuickConnect] =
    useState<PendingQuickConnectState | null>(() => readPendingQuickConnect());

  const { catalogCards, isLoading, connect, disconnect, toggleStar } =
    useRegistryServers({
      projectId,
      isAuthenticated,
      liveServers: servers,
      onConnect,
      onDisconnect,
    });

  const directory = useServerDirectory({
    projectId,
    isAuthenticated,
    onConnect,
  });

  // Which directory row the endpoint dialog is asking about, and the choices
  // to offer. `options`/`pattern` are seeded from the card and REPLACED by
  // whatever `endpoint_url_required` carried — the error is authoritative,
  // the row may predate the last sync.
  const [endpointPrompt, setEndpointPrompt] = useState<{
    server: DirectoryServer;
    options?: string[];
    pattern?: string;
    error?: string | null;
  } | null>(null);
  const [connectingDirectoryIds, setConnectingDirectoryIds] = useState<
    Set<string>
  >(new Set());

  // Auto-redirect to App Builder when a pending server becomes connected.
  // We persist in localStorage to survive OAuth redirects (page remounts).
  useEffect(() => {
    const pending = pendingQuickConnect;
    if (!pending || pending.sourceTab !== "registry") return;
    const liveServer =
      servers?.[pending.serverName] ??
      Object.entries(servers ?? {}).find(
        ([name, server]) =>
          server.connectionStatus === "connected" &&
          name.startsWith(`${pending.displayName} (`)
      )?.[1];
    if (liveServer?.connectionStatus === "connected") {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
      onNavigate?.("playground");
    }
  }, [pendingQuickConnect, servers, onNavigate]);

  // `useRegistryServers.connect` returns after dispatching OAuth; pending stays for redirect UX.
  // Mirror ServersTab: clear when auth fails or the server is disconnected so the card does not
  // show "Connecting" forever (localStorage would otherwise keep matching pending).
  useEffect(() => {
    if (pendingQuickConnect?.sourceTab !== "registry") return;

    const pending = pendingQuickConnect;
    const pendingServer = servers?.[pending.serverName];
    const age = Date.now() - pending.createdAt;

    if (pendingServer) {
      if (
        pendingServer.connectionStatus === "failed" ||
        pendingServer.connectionStatus === "disconnected"
      ) {
        clearPendingQuickConnect();
        setPendingQuickConnect(null);
        return;
      }
      if (
        pendingServer.connectionStatus === "oauth-flow" &&
        age > REGISTRY_PENDING_OAUTH_STALE_MS
      ) {
        clearPendingQuickConnect();
        setPendingQuickConnect(null);
      }
      return;
    }

    if (age > 48 * 60 * 60 * 1000) {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
  }, [pendingQuickConnect, servers]);

  const handleConnect = async (server: EnrichedRegistryServer) => {
    setConnectingIds((prev) => new Set(prev).add(server._id));
    const serverName = getRegistryServerName(server);
    const nextPendingQuickConnect: PendingQuickConnectState = {
      serverName,
      registryServerId: server._id,
      displayName: server.displayName,
      sourceTab: "registry",
      createdAt: Date.now(),
    };
    writePendingQuickConnect(nextPendingQuickConnect);
    setPendingQuickConnect(nextPendingQuickConnect);
    try {
      await connect(server);
    } catch (error) {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
      throw error;
    } finally {
      setConnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(server._id);
        return next;
      });
    }
  };

  const handleDisconnect = async (server: EnrichedRegistryServer) => {
    const serverName = getRegistryServerName(server);
    if (
      pendingQuickConnect &&
      (pendingQuickConnect.serverName === serverName ||
        pendingQuickConnect.displayName === server.displayName)
    ) {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
    await disconnect(server);
  };

  /**
   * Install a directory entry, and put the dialog up when it needs a URL.
   *
   * The mutation is the authority on whether an endpoint is required and on
   * which endpoints exist: an `options` row rendered before the last sync can
   * be listing a region that no longer resolves. So the card's own values only
   * SEED the first attempt; `endpoint_url_required` re-seeds from the error.
   */
  const runDirectoryConnect = useCallback(
    async (server: DirectoryServer, endpointUrl?: string) => {
      setConnectingDirectoryIds((prev) => new Set(prev).add(server._id));
      try {
        const result = await directory.connect(server, endpointUrl);
        // The hook wrote the marker to localStorage (it has to survive an
        // OAuth redirect); mirror it into state so THIS session's effects —
        // auto-navigate on connect, stale cleanup — see it too, exactly as
        // they do for a curated connect.
        setPendingQuickConnect(result.pending);
        setEndpointPrompt(null);
        // The workspace already talks to this endpoint through the other
        // directory's row. Saying so beats a silent no-op that looks like a
        // click that did nothing.
        const reused = describeExistingConnection(result);
        if (reused) toast.info(reused);
        return { ok: true as const };
      } catch (rawError) {
        const error = normalizeDirectoryConnectError(rawError);
        switch (error.code) {
          case "endpoint_url_required":
            // Not a failure the user should read as one: the row simply
            // cannot be connected without a choice only they can make.
            setEndpointPrompt({
              server,
              options: error.options ?? server.remoteUrlOptions,
              pattern: error.pattern ?? server.remoteUrlRegex,
              error: null,
            });
            break;
          case "endpoint_url_invalid":
          case "endpoint_url_not_allowed":
          case "endpoint_url_not_configurable":
            // Keep the dialog open with the refusal inline — the user is one
            // correction away, and a toast would take the context with it.
            setEndpointPrompt((prev) =>
              prev && prev.server._id === server._id
                ? { ...prev, error: error.message }
                : {
                    server,
                    options: error.options ?? server.remoteUrlOptions,
                    pattern: error.pattern ?? server.remoteUrlRegex,
                    error: error.message,
                  }
            );
            break;
          case "already_connected_to_different_endpoint":
            setEndpointPrompt(null);
            toast.error(
              error.connectedUrl
                ? `${server.displayName} is already connected to ${error.connectedUrl}.`
                : error.message
            );
            break;
          default:
            setEndpointPrompt(null);
            toast.error(error.message);
            break;
        }
        return { ok: false as const, error };
      } finally {
        setConnectingDirectoryIds((prev) => {
          const next = new Set(prev);
          next.delete(server._id);
          return next;
        });
      }
    },
    [directory]
  );

  const handleDirectoryConnect = useCallback(
    async (server: DirectoryServer) => {
      // Ask FIRST for a row we already know needs a choice, rather than
      // spending a round trip to be told so. The mutation still decides.
      if (requiresEndpointChoice(server)) {
        setEndpointPrompt({
          server,
          options: server.remoteUrlOptions,
          pattern: server.remoteUrlRegex,
          error: null,
        });
        return;
      }
      await runDirectoryConnect(server);
    },
    [runDirectoryConnect]
  );

  /**
   * The card's state, from the two facts that answer it.
   *
   * `added` comes from the connection rows the mutation writes; everything
   * after that comes from the LIVE servers map, because a mutation success
   * means installed, never connected.
   */
  const directoryStatusFor = useCallback(
    (server: DirectoryServer): RegistryConnectionStatus | "error" => {
      if (connectingDirectoryIds.has(server._id)) return "connecting";
      const connection = directory.connections.find(
        (c) => c.catalogServerId === server._id
      );
      const liveName = connection?.serverName ?? null;
      const live = liveName ? servers?.[liveName] : undefined;
      if (live?.connectionStatus === "connected") return "connected";
      if (
        live?.connectionStatus === "connecting" ||
        live?.connectionStatus === "oauth-flow"
      ) {
        return "connecting";
      }
      if (live?.connectionStatus === "failed") return "error";
      // Coming back from an OAuth redirect, `connectingDirectoryIds` is gone
      // (the component remounted) and the live map has not caught up yet — so
      // without this the card would briefly offer Connect again on a server
      // the user has just authorized. This is what `catalogServerId` on the
      // pending marker is for; localStorage is the only thing that survived
      // the navigation.
      if (
        pendingQuickConnect?.sourceTab === "registry" &&
        pendingQuickConnect.catalogServerId === server._id
      ) {
        return "connecting";
      }
      return connection ? "added" : "not_connected";
    },
    [
      connectingDirectoryIds,
      directory.connections,
      pendingQuickConnect,
      servers,
    ]
  );

  /**
   * Answer a connect command for a DIRECTORY entry, or `null` if none matches.
   *
   * Every outcome is a report, never a redirect. Two honest refusals:
   *
   *   endpoint_choice_required — an `options` or `tenant` row. The URL is the
   *     user's to pick or type; a model guessing a region (or inventing a
   *     tenant hostname) would connect them somewhere they did not ask for.
   *
   *   authorization_required — the row is not KNOWN to be authless. Mirrors
   *     `connectCatalogServer`'s own posture: absent means "expect auth". A
   *     directory connect runs `authMethod: "auto"`, so even a surprise 401
   *     asks before redirecting — but queuing that prompt behind the model's
   *     back is not better than saying so.
   */
  const resolveDirectoryCommandTarget = useCallback(
    (rawName: unknown) => {
      if (typeof rawName !== "string" || rawName.trim().length === 0) {
        return null;
      }
      const item = directory.items.find((candidate) =>
        matchesDirectoryServerName(candidate, rawName)
      );
      if (!item) return null;

      const serverName = item.displayName;
      if (!isConnectableDirectoryRow(item)) {
        // Keyed on the row, not on the kind: `none` means "a local desktop
        // extension" on one source and "a hosted server whose endpoint the
        // directory will not publish" on the other, and the model relays this
        // text to a person who would go looking for an installer.
        return {
          status: "not_connectable",
          serverName,
          message: describeUnavailable(item),
          ...(item.unavailableReason ? { reason: item.unavailableReason } : {}),
        };
      }
      const status = directoryStatusFor(item);
      if (status === "connected") {
        return { status: "already_connected", serverName };
      }
      if (status === "connecting") return { status: "connecting", serverName };
      if (requiresEndpointChoice(item)) {
        return {
          status: "endpoint_choice_required",
          serverName,
          endpointKind: item.endpointKind,
          message:
            item.endpointKind === "options"
              ? "This connector publishes several endpoints. Ask the user to click Connect on its card and pick one — do not guess."
              : "This connector runs on the user's own instance. Ask the user to click Connect on its card and enter their URL — do not invent one.",
        };
      }
      if (item.isAuthless !== true) {
        return {
          status: "authorization_required",
          serverName,
          message:
            "This connector expects authorization, which redirects the browser and would end this turn. Ask the user to click Connect on its card and authorize on screen.",
        };
      }
      void handleDirectoryConnect(item);
      return { status: "connecting", serverName };
    },
    [directory.items, directoryStatusFor, handleDirectoryConnect]
  );

  const readCommandVariant = (value: unknown): "text" | "app" | undefined => {
    if (value === undefined) return undefined;
    if (value === "text" || value === "app") return value;
    throw createInspectorCommandClientError(
      "invalid_request",
      `'variant' must be "text" or "app" when provided.`
    );
  };

  // Agent bridge: the registry tool group plus this screen's command
  // handlers and snapshot. Handlers reuse the EXACT callbacks the buttons
  // use (handleConnect / handleDisconnect / toggleStar) — same billing and
  // OAuth posture, nothing re-implemented.
  useSurfaceAgentBridge({
    surfaceId: "registry",
    handlers: {
      connectRegistryServer: async (command) => {
        const { payload } = command as ConnectRegistryServerInspectorCommand;
        // CURATED FIRST. A curated card shadows its directory twin everywhere
        // else on this screen (`curatedOverlap` hides the duplicate row), so
        // resolving the other way round would install the mirrored copy of a
        // server we curate — with none of the transport config we maintain
        // for it. The directory only answers names the curated catalog does
        // not know.
        const curatedName =
          typeof payload.serverName === "string" ? payload.serverName : "";
        if (!curatedName || !findRegistryCard(catalogCards, curatedName)) {
          const directoryMatch = resolveDirectoryCommandTarget(
            payload.serverName
          );
          if (directoryMatch) return directoryMatch;
        }

        // Neither catalog knows it. "Unavailable" is only honest when there
        // is nothing loaded at all — with a populated directory on screen, an
        // unmatched name is an unknown name, not an empty registry.
        if (directory.items.length === 0) assertRegistryAvailable(catalogCards);
        const { card, serverName } = requireRegistryCard(
          catalogCards,
          payload.serverName
        );
        const variant = resolveConnectVariant(
          card,
          serverName,
          readCommandVariant(payload.variant)
        );
        const name = getRegistryServerName(variant);
        if (variant.connectionStatus === "connected") {
          return { status: "already_connected", serverName: name };
        }
        if (
          variant.connectionStatus === "connecting" ||
          connectingIds.has(variant._id)
        ) {
          return { status: "connecting", serverName: name };
        }
        if (variant.transport.useOAuth) {
          // NEVER start the OAuth flow from here: connecting an OAuth
          // server redirects the browser, which would kill the chat turn
          // mid-call. Report the state and leave the Authorize click — and
          // the redirect — to the user, mirroring ui_connect_server.
          return {
            status: "authorization_required",
            serverName: name,
            message:
              "This server requires OAuth authorization, which redirects the browser. Ask the user to click Connect on its card and complete authorization on screen.",
          };
        }
        await handleConnect(variant);
        return { status: "connecting", serverName: name };
      },
      disconnectRegistryServer: async (command) => {
        assertRegistryAvailable(catalogCards);
        const { payload } = command as DisconnectRegistryServerInspectorCommand;
        const { card } = requireRegistryCard(catalogCards, payload.serverName);
        const variantType = readCommandVariant(payload.variant);
        // Idempotent (idempotentHint: true): a retry after a successful
        // disconnect finds nothing connected/added — that is the desired end
        // state, not an error, so report it as already disconnected.
        const candidates = variantType
          ? card.variants.filter((v) => v.clientType === variantType)
          : card.variants;
        const active =
          candidates.find((v) => v.connectionStatus === "connected") ??
          candidates.find((v) => v.connectionStatus === "added");
        if (!active) {
          return {
            status: "already_disconnected",
            serverName: getRegistryServerName(card.variants[0]),
          };
        }
        await handleDisconnect(active);
        return {
          status: "disconnected",
          serverName: getRegistryServerName(active),
        };
      },
      toggleRegistryStar: async (command) => {
        assertRegistryAvailable(catalogCards);
        const { payload } = command as ToggleRegistryStarInspectorCommand;
        if (typeof payload.starred !== "boolean") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "Missing required 'starred' boolean."
          );
        }
        const { card } = requireRegistryCard(catalogCards, payload.serverName);
        // Consistent with connect/disconnect: getRegistryServerName appends the
        // (App)/(Text) suffix on dual-type cards, so a name echoed back here can
        // be passed straight to a connect call without ambiguous resolution.
        const serverName = getRegistryServerName(card.variants[0]);
        if (card.isStarred === payload.starred) {
          return { status: "unchanged", serverName, starred: card.isStarred };
        }
        // toggleStar catches failures, rolls the optimistic update back, and
        // returns void — so we can't confirm persistence here. Report the
        // action as REQUESTED (not done) and point at the snapshot for the
        // authoritative resulting state, rather than claiming a success that
        // may have been rolled back.
        await toggleStar(card.registryCardKey);
        return {
          status: "star_requested",
          serverName,
          requestedStarred: payload.starred,
          note: "Verify the resulting starred state with ui_snapshot_app; a failed request is rolled back.",
        };
      },
      searchRegistryDirectory: async (command) => {
        const { payload } = command as SearchRegistryDirectoryInspectorCommand;
        if (payload.query !== undefined && typeof payload.query !== "string") {
          throw createInspectorCommandClientError(
            "invalid_request",
            "'query' must be a string when provided."
          );
        }
        const tier = readDirectoryTier(payload.tier);
        const source = readDirectorySource(payload.source);
        // DRIVES the screen's own controls rather than running a private
        // query: what the model reads back is what the person is looking at,
        // and the follow-up connect resolves against the same rows.
        directory.setQuery(payload.query ?? "");
        // Source first: it clears a tier the new source does not publish, so
        // setting the tier afterwards is what makes an explicit tier survive
        // an explicit source in the same call.
        if (source) directory.setSource(source);
        if (tier) directory.setTier(tier);
        return {
          status: "searching",
          query: payload.query ?? "",
          source: source ?? directory.source,
          tier: tier ?? directory.tier,
          note: "Results are debounced — read them from ui_snapshot_app's `directory` block.",
        };
      },
    },
    // Redacted STATE, not payloads: names and statuses only — no transport
    // URLs, no OAuth internals, no tokens.
    snapshot: () => ({
      isLoading,
      totalServers: catalogCards.length,
      servers: catalogCards
        .slice(0, AGENT_SNAPSHOT_MAX_SERVERS)
        .map((card) => ({
          name: card.variants[0].displayName,
          registryName: card.variants[0].name,
          starred: card.isStarred,
          starCount: card.starCount,
          requiresOAuth: card.variants[0].transport.useOAuth === true,
          connecting: card.variants.some((v) => connectingIds.has(v._id)),
          variants: card.variants.map((v) => ({
            ...(v.clientType ? { clientType: v.clientType } : {}),
            status: v.connectionStatus,
          })),
        })),
      ...(pendingQuickConnect?.sourceTab === "registry"
        ? { pendingConnect: { serverName: pendingQuickConnect.serverName } }
        : {}),
      // Same redaction rule as `servers` above: names and statuses, never a
      // transport URL. A directory row's URL is the one field that would turn
      // this snapshot into an endpoint list, and `endpointKind` says what the
      // model actually needs (whether a choice is required) without it.
      directory: {
        query: directory.query,
        source: directory.source,
        tier: directory.tier,
        loadedCount: directory.items.length,
        hasMore: directory.canLoadMore,
        ...(directory.lastSyncedAt
          ? { asOf: new Date(directory.lastSyncedAt).toISOString() }
          : {}),
        visible: directory.items
          .slice(0, AGENT_SNAPSHOT_MAX_DIRECTORY)
          .map((item) => ({
            name: item.displayName,
            ...(item.verifiedTier ? { tier: item.verifiedTier } : {}),
            status: directoryStatusFor(item),
            requiresEndpointChoice: requiresEndpointChoice(item),
            // So the model does not offer to install something that cannot be
            // installed. The REASON travels too: "endpoint not published" and
            // "local extension" call for different things to say.
            ...(isConnectableDirectoryRow(item)
              ? {}
              : {
                  connectable: false as const,
                  ...(item.unavailableReason
                    ? { unavailableReason: item.unavailableReason }
                    : {}),
                }),
          })),
      },
    }),
  });

  // Per-SECTION emptiness, not per-screen. The two halves have independent
  // backends: an empty curated catalog must not blank a directory that loaded
  // fine, and vice versa. Only when BOTH are empty and neither is still
  // loading is there genuinely nothing to show.
  const curatedEmpty = !isLoading && catalogCards.length === 0;
  const directoryEmpty =
    !directory.isLoadingFirstPage && directory.items.length === 0;
  const directoryFiltered = isDirectoryFiltered(directory);

  if (isLoading && directory.isLoadingFirstPage) {
    return <LoadingSkeleton />;
  }

  if (curatedEmpty && directoryEmpty && !directoryFiltered) {
    return (
      <EmptyState
        icon={Package}
        title="No servers available"
        description="The registry is empty. Check back soon for pre-configured MCP servers."
      />
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="space-y-8 p-8">
        {/* Header */}
        <div>
          <h2 className="text-lg font-semibold">Registry</h2>
          <p className="text-sm text-muted-foreground">
            Pre-configured MCP servers you can connect quickly.
          </p>
        </div>

        {/* Curated cards grid */}
        {isLoading ? (
          // Same breakpoint as the grid it stands in for, so the page does
          // not reflow the moment the real cards arrive.
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
          </div>
        ) : catalogCards.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {catalogCards.map((card) => (
              <RegistryServerCard
                key={card.registryCardKey}
                card={card}
                connectingIds={connectingIds}
                pendingQuickConnect={pendingQuickConnect}
                onConnect={handleConnect}
                onDisconnect={handleDisconnect}
                onToggleStar={toggleStar}
              />
            ))}
          </div>
        ) : null}

        <ServerDirectorySection
          directory={directory}
          statusFor={directoryStatusFor}
          onConnect={handleDirectoryConnect}
        />
      </div>

      {endpointPrompt && (
        <DirectoryEndpointDialog
          open
          onOpenChange={(open) => {
            if (!open) setEndpointPrompt(null);
          }}
          displayName={endpointPrompt.server.displayName}
          options={endpointPrompt.options}
          pattern={endpointPrompt.pattern}
          error={endpointPrompt.error ?? null}
          submitting={connectingDirectoryIds.has(endpointPrompt.server._id)}
          onSubmit={(endpointUrl) => {
            void runDirectoryConnect(endpointPrompt.server, endpointUrl);
          }}
        />
      )}
    </div>
  );
}

/**
 * The mirrored upstream directories, beneath the curated catalog.
 *
 * Thousands of entries per source, so it is search-first: no all-at-once grid,
 * a debounced query, a source facet, a tier filter, and an explicit Load more.
 * Rows a curated card already covers are filtered out upstream in the hook —
 * one connector, one card.
 *
 * ONE SOURCE AT A TIME (Claude by default). Cross-directory listing overlap
 * stays visible when someone switches — a connector listed in both is a
 * signal, not a duplicate to hide — and only CONNECT collapses the two, in the
 * backend.
 */
function ServerDirectorySection({
  directory,
  statusFor,
  onConnect,
}: {
  directory: ReturnType<typeof useServerDirectory>;
  statusFor: (server: DirectoryServer) => RegistryConnectionStatus | "error";
  onConnect: (server: DirectoryServer) => void;
}) {
  const { items, query, setQuery, tier, setTier, source, setSource } =
    directory;
  const filtering = isDirectoryFiltered(directory);

  // Nothing loaded and nothing asked for: the section stays out of the way
  // rather than advertising an empty directory (the gated-off case).
  if (!filtering && items.length === 0 && !directory.isLoadingFirstPage) {
    return null;
  }

  return (
    <section className="space-y-4" data-testid="server-directory-section">
      <div>
        <h3 className="text-sm font-semibold">Connector directories</h3>
        <p className="text-xs text-muted-foreground">
          Connectors mirrored from a public directory. Search to find one, then
          connect it into this project.
          {directory.lastSyncedAt ? (
            <>
              {" "}
              <span data-testid="directory-as-of">
                {DIRECTORY_SOURCE_LABELS[source]} as of{" "}
                {new Date(directory.lastSyncedAt).toLocaleDateString()}.
              </span>
            </>
          ) : null}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onValueChange={setQuery}
          placeholder={`Search the ${DIRECTORY_SOURCE_LABELS[source]}…`}
          className="w-full sm:w-72"
        />
        <Select
          value={source}
          onValueChange={(value) => setSource(value as DirectorySource)}
        >
          <SelectTrigger
            data-testid="directory-source-filter"
            className="h-8 w-[min(100%,11rem)] text-xs"
            aria-label="Choose which directory to browse"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DIRECTORY_SOURCES.map((value) => (
              <SelectItem key={value} value={value}>
                {DIRECTORY_SOURCE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant={directory.connectableOnly ? "default" : "outline"}
          size="sm"
          className="h-8 text-xs"
          aria-pressed={directory.connectableOnly}
          data-testid="directory-connectable-filter"
          onClick={() =>
            directory.setConnectableOnly(!directory.connectableOnly)
          }
        >
          Connectable only
        </Button>
        {/* Verification tiers are a Claude concept. Rendering the filter for a
            source that publishes none would offer a control that can only ever
            empty the list. */}
        {sourceHasTiers(source) && (
          <Select
            value={tier}
            onValueChange={(value) => setTier(value as DirectoryTier)}
          >
            <SelectTrigger
              data-testid="directory-tier-filter"
              className="h-8 w-[min(100%,9rem)] text-xs"
              aria-label="Filter the directory by tier"
            >
              <SelectValue placeholder="All tiers" />
            </SelectTrigger>
            <SelectContent>
              {DIRECTORY_TIERS.map((value) => (
                <SelectItem key={value} value={value}>
                  {TIER_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {directory.isLoadingFirstPage ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-28 w-full rounded-lg" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No directory connectors match that search.
        </p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {items.map((item) => (
            <DirectoryServerCard
              key={item._id}
              server={item}
              status={statusFor(item)}
              onConnect={() => onConnect(item)}
            />
          ))}
        </div>
      )}

      {directory.canLoadMore && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => directory.loadMore()}
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

function DirectoryServerCard({
  server,
  status,
  onConnect,
}: {
  server: DirectoryServer;
  status: RegistryConnectionStatus | "error";
  onConnect: () => void;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  const showIcon = Boolean(server.iconUrl) && !iconFailed;
  const connectable = isConnectableDirectoryRow(server);
  const unavailable = connectable ? null : describeUnavailable(server);

  return (
    <Card className="px-4 py-3 flex flex-col gap-2">
      <div className="flex items-center gap-3">
        {showIcon ? (
          <img
            src={server.iconUrl}
            alt=""
            // Third-party image on someone else's CDN: lazy so a long list
            // does not fetch 2,000 of them, no referrer so browsing the
            // directory does not tell every publisher which page you are on,
            // and a fallback because a dead icon must not leave a hole.
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={() => setIconFailed(true)}
            className="h-8 w-8 rounded-md object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
            <Package className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-semibold truncate flex items-center gap-1">
            <span className="truncate">{server.displayName}</span>
            {server.verifiedTier === "anthropic" && <VerifiedBadge />}
          </h4>
          {/* PROVENANCE, not endorsement: "Listed in ChatGPT" says OpenAI
              accepted a submission, which is not a tier of ours. */}
          <p className="text-xs text-muted-foreground">
            {directorySourceBadge(server.source)}
          </p>
        </div>
        <div className="flex-shrink-0">
          {connectable ? (
            <DirectoryAction status={status} onConnect={onConnect} />
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs cursor-default"
              disabled
              title={unavailable ?? undefined}
            >
              Not connectable
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1.5 flex-wrap">
        <TierBadge tier={server.verifiedTier} />
        {requiresEndpointChoice(server) && (
          <Badge
            variant="outline"
            className="text-[11px] px-1.5 py-0.5 gap-1 border-muted-foreground/30 text-muted-foreground"
          >
            {server.endpointKind === "options"
              ? "Choose endpoint"
              : "Your instance"}
          </Badge>
        )}
      </div>

      {/* Why, in the row's own terms. A hidden hosted endpoint and a desktop
          extension are different situations and were both `endpointKind:
          'none'`; one line of wrong copy here sends someone hunting for an
          installer that does not exist. */}
      {unavailable && (
        <p
          className="text-xs text-muted-foreground italic"
          data-testid="directory-unavailable-reason"
        >
          {unavailable}
        </p>
      )}

      {server.description && (
        <p className="text-xs text-muted-foreground line-clamp-2">
          {server.description}
        </p>
      )}
    </Card>
  );
}

function TierBadge({ tier }: { tier?: string }) {
  if (!tier) return null;
  const label = tier.charAt(0).toUpperCase() + tier.slice(1);
  // Semantic tokens, not literal colors: these badges have to stay legible in
  // both themes, and a hex here would only be right in one of them.
  const className =
    tier === "anthropic"
      ? "border-primary/30 text-primary"
      : tier === "partner"
      ? "border-success/30 text-success"
      : "border-muted-foreground/30 text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={`text-[11px] px-1.5 py-0.5 gap-1 ${className}`}
    >
      {label}
    </Badge>
  );
}

function DirectoryAction({
  status,
  onConnect,
}: {
  status: RegistryConnectionStatus | "error";
  onConnect: () => void;
}) {
  switch (status) {
    case "connected":
      return (
        <Button
          size="sm"
          className="h-7 text-xs bg-primary/10 hover:bg-primary/10 text-primary border border-primary/20 cursor-default"
          tabIndex={-1}
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Connected
        </Button>
      );
    case "connecting":
      return (
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Connecting
        </Button>
      );
    case "error":
      return (
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs text-destructive border-destructive/30"
          onClick={onConnect}
        >
          Retry
        </Button>
      );
    case "added":
      return (
        <Button
          size="sm"
          className="h-7 text-xs"
          onClick={onConnect}
          title="Server is in your project — click to connect"
        >
          Connect
        </Button>
      );
    default:
      return (
        <Button size="sm" className="h-7 text-xs" onClick={onConnect}>
          Connect
        </Button>
      );
  }
}

/**
 * The verified check, shared by a curated card's verified publisher and a
 * directory card's Anthropic tier.
 *
 * The fill was a literal `#ae5630`, which is a light-theme brand color pasted
 * into a component that renders in both themes — it does not track the token
 * it was copied from, and it does not darken. `fill-primary` is the same mark
 * in both themes and moves with the palette.
 */
function VerifiedBadge() {
  return (
    <span className="inline-flex shrink-0" title="Verified publisher">
      <BadgeCheck
        className="h-4 w-4 shrink-0 [&>path:first-of-type]:fill-primary [&>path:first-of-type]:stroke-none [&>path:last-of-type]:stroke-background [&>path:last-of-type]:stroke-[2.5] [&>path:last-of-type]:[stroke-linecap:round] [&>path:last-of-type]:[stroke-linejoin:round]"
        aria-label="Verified publisher"
      />
    </span>
  );
}

function RegistryServerCard({
  card,
  connectingIds,
  pendingQuickConnect,
  onConnect,
  onDisconnect,
  onToggleStar,
}: {
  card: EnrichedRegistryCatalogCard;
  connectingIds: Set<string>;
  pendingQuickConnect: PendingQuickConnectState | null;
  onConnect: (server: EnrichedRegistryServer) => void;
  onDisconnect: (server: EnrichedRegistryServer) => void;
  onToggleStar: (registryCardKey: string) => void | Promise<void>;
}) {
  const { variants, hasDualType } = card;
  const first = variants[0];
  const isPublisherVerified = variants.some(
    (v) => v.publishStatus === "verified"
  );

  const isConnecting =
    variants.some((v) => connectingIds.has(v._id)) ||
    (pendingQuickConnect?.sourceTab === "registry" &&
      variants.some(
        (variant) =>
          variant._id === pendingQuickConnect.registryServerId ||
          getRegistryServerName(variant) === pendingQuickConnect.serverName ||
          variant.displayName === pendingQuickConnect.displayName
      ));
  const effectiveStatus: RegistryConnectionStatus = isConnecting
    ? "connecting"
    : first.connectionStatus;

  return (
    <Card className="px-4 py-3 flex flex-col gap-2">
      {/* Top row: icon + name + action (top-right) */}
      <div className="flex items-center gap-3">
        {first.iconUrl ? (
          <img
            src={first.iconUrl}
            alt={first.displayName}
            className="h-8 w-8 rounded-md object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
            <Package className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold truncate">
            {first.displayName}
          </h3>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-xs text-muted-foreground">
              {first.publisher}
            </span>
            {isPublisherVerified && <VerifiedBadge />}
          </div>
        </div>
        {/* Top-right action */}
        <div className="flex-shrink-0 flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => void onToggleStar(card.registryCardKey)}
            aria-label={
              card.isStarred ? "Remove from starred" : "Star this server"
            }
            aria-pressed={card.isStarred}
          >
            <Star
              className={`h-4 w-4 shrink-0 ${
                card.isStarred ? "fill-amber-400 text-amber-400" : ""
              }`}
            />
            <span className="text-xs tabular-nums">
              {formatRegistryStarCount(card.starCount)}
            </span>
          </Button>
          {hasDualType ? (
            <DualTypeAction
              variants={variants}
              connectingIds={connectingIds}
              onConnect={onConnect}
              onDisconnect={onDisconnect}
            />
          ) : (
            <TopRightAction
              status={effectiveStatus}
              onConnect={() => onConnect(first)}
              onDisconnect={() => onDisconnect(first)}
            />
          )}
        </div>
      </div>

      {/* Tags row — show badges for all variants */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {variants.map((v) => (
          <ClientTypeBadge key={v._id} clientType={v.clientType} />
        ))}
        <AuthBadge useOAuth={first.transport.useOAuth} />
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground line-clamp-2">
        {first.description}
      </p>
    </Card>
  );
}

function DualTypeAction({
  variants,
  connectingIds,
  onConnect,
  onDisconnect,
}: {
  variants: EnrichedRegistryServer[];
  connectingIds: Set<string>;
  onConnect: (server: EnrichedRegistryServer) => void;
  onDisconnect: (server: EnrichedRegistryServer) => void;
}) {
  // Check if any variant is connecting
  const connectingVariant = variants.find((v) => connectingIds.has(v._id));
  if (connectingVariant) {
    return (
      <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Connecting
      </Button>
    );
  }

  // Check if any variant is connected/added
  const connectedVariant = variants.find(
    (v) => v.connectionStatus === "connected"
  );
  const addedVariant = variants.find((v) => v.connectionStatus === "added");
  const activeVariant = connectedVariant ?? addedVariant;

  if (activeVariant) {
    const disconnectLabel =
      activeVariant.connectionStatus === "connected" ? "Disconnect" : "Remove";

    // Show connected state + dropdown for remaining variants
    const remainingVariants = variants.filter((v) => v !== activeVariant);

    return (
      <div className="flex items-center gap-1.5">
        {activeVariant.connectionStatus === "connected" ? (
          <Button
            size="sm"
            className="h-7 text-xs bg-primary/10 hover:bg-primary/10 text-primary border border-primary/20 cursor-default"
            tabIndex={-1}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected
          </Button>
        ) : (
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => onConnect(activeVariant)}
            title="Server is in your project — click to connect"
          >
            Connect
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
              <MoreVertical className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {remainingVariants.map((v) => (
              <DropdownMenuItem key={v._id} onClick={() => onConnect(v)}>
                {v.clientType === "app" ? (
                  <MonitorSmartphone className="h-3.5 w-3.5 mr-2 text-primary" />
                ) : (
                  <MessageSquareText className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
                )}
                Connect as {v.clientType === "app" ? "App" : "Text"}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onDisconnect(activeVariant)}>
              <Unplug className="h-3.5 w-3.5 mr-2" />
              {disconnectLabel}{" "}
              {activeVariant.clientType === "app" ? "App" : "Text"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  // Neither variant connected — show split Connect button with dropdown
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className="h-7 text-xs gap-1"
          data-testid="connect-dropdown-trigger"
        >
          Connect
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {variants.map((v) => (
          <DropdownMenuItem key={v._id} onClick={() => onConnect(v)}>
            {v.clientType === "app" ? (
              <MonitorSmartphone className="h-3.5 w-3.5 mr-2 text-primary" />
            ) : (
              <MessageSquareText className="h-3.5 w-3.5 mr-2 text-muted-foreground" />
            )}
            Connect as {v.clientType === "app" ? "App" : "Text"}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ClientTypeBadge({ clientType }: { clientType?: "text" | "app" }) {
  if (clientType === "app") {
    return (
      <Badge
        variant="outline"
        className="text-[11px] px-1.5 py-0.5 gap-1 border-primary/30 text-primary"
      >
        <MonitorSmartphone className="h-3 w-3" />
        App
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[11px] px-1.5 py-0.5 gap-1 border-muted-foreground/30 text-muted-foreground"
    >
      <MessageSquareText className="h-3 w-3" />
      Text
    </Badge>
  );
}

function AuthBadge({ useOAuth }: { useOAuth?: boolean }) {
  if (useOAuth) {
    return (
      <Badge
        variant="outline"
        className="text-[11px] px-1.5 py-0.5 gap-1 border-success/30 text-success"
      >
        <KeyRound className="h-3 w-3" />
        OAuth
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[11px] px-1.5 py-0.5 gap-1 border-warning/30 text-warning"
    >
      <ShieldOff className="h-3 w-3" />
      No auth
    </Badge>
  );
}

function TopRightAction({
  status,
  onConnect,
  onDisconnect,
}: {
  status: RegistryConnectionStatus;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  switch (status) {
    case "connected":
      return (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 text-xs bg-primary/10 hover:bg-primary/10 text-primary border border-primary/20 cursor-default"
            tabIndex={-1}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Connected
          </Button>
          <OverflowMenu onDisconnect={onDisconnect} label="Disconnect" />
        </div>
      );
    case "connecting":
      return (
        <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Connecting
        </Button>
      );
    case "added":
      return (
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={onConnect}
            title="Server is in your project — click to connect"
          >
            Connect
          </Button>
          <OverflowMenu onDisconnect={onDisconnect} label="Remove" />
        </div>
      );
    default:
      return (
        <Button size="sm" className="h-7 text-xs" onClick={onConnect}>
          Connect
        </Button>
      );
  }
}

function OverflowMenu({
  onDisconnect,
  label,
}: {
  onDisconnect: () => void;
  label: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onDisconnect}>
          <Unplug className="h-3.5 w-3.5 mr-2" />
          {label}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-5 p-8">
      <div>
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-7 w-12 rounded-full" />
        <Skeleton className="h-7 w-28 rounded-full" />
        <Skeleton className="h-7 w-24 rounded-full" />
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}
