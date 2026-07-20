import { useState, useEffect } from "react";
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
import { EmptyState } from "./ui/empty-state";
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
  serverName: string,
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
      "The registry catalog is empty or unavailable right now — no servers to act on.",
    );
  }
}

function requireRegistryCard(
  cards: EnrichedRegistryCatalogCard[],
  serverName: unknown,
): { card: EnrichedRegistryCatalogCard; serverName: string } {
  if (typeof serverName !== "string" || serverName.trim().length === 0) {
    throw createInspectorCommandClientError(
      "invalid_request",
      "Missing required 'serverName' string.",
    );
  }
  const card = cards.find((c) =>
    c.variants.some((v) => matchesRegistryServerName(v, serverName)),
  );
  if (!card) {
    throw createInspectorCommandClientError(
      "unknown_server",
      `No registry server matches "${serverName}". Use a name from the registry catalog on this screen.`,
    );
  }
  return { card, serverName };
}

/** Pin down ONE variant to connect; dual-type cards force an explicit pick. */
function resolveConnectVariant(
  card: EnrichedRegistryCatalogCard,
  serverName: string,
  variantType: "text" | "app" | undefined,
): EnrichedRegistryServer {
  if (variantType) {
    const variant = card.variants.find((v) => v.clientType === variantType);
    if (!variant) {
      throw createInspectorCommandClientError(
        "invalid_request",
        `"${card.variants[0].displayName}" has no ${variantType} variant.`,
      );
    }
    return variant;
  }
  const matching = card.variants.filter((v) =>
    matchesRegistryServerName(v, serverName),
  );
  if (matching.length === 1) return matching[0];
  throw createInspectorCommandClientError(
    "invalid_request",
    `"${card.variants[0].displayName}" has both Text and App variants — pass variant: "text" or "app".`,
  );
}

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
          name.startsWith(`${pending.displayName} (`),
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

  const readCommandVariant = (value: unknown): "text" | "app" | undefined => {
    if (value === undefined) return undefined;
    if (value === "text" || value === "app") return value;
    throw createInspectorCommandClientError(
      "invalid_request",
      `'variant' must be "text" or "app" when provided.`,
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
        assertRegistryAvailable(catalogCards);
        const { payload } = command as ConnectRegistryServerInspectorCommand;
        const { card, serverName } = requireRegistryCard(
          catalogCards,
          payload.serverName,
        );
        const variant = resolveConnectVariant(
          card,
          serverName,
          readCommandVariant(payload.variant),
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
        const { payload } =
          command as DisconnectRegistryServerInspectorCommand;
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
            "Missing required 'starred' boolean.",
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
    }),
  });

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (catalogCards.length === 0) {
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
      <div className="space-y-5 p-8">
        {/* Header */}
        <div>
          <h2 className="text-lg font-semibold">Registry</h2>
          <p className="text-sm text-muted-foreground">
            Pre-configured MCP servers you can connect quickly.
          </p>
        </div>

        {/* Server cards grid */}
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
      </div>
    </div>
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
    (v) => v.publishStatus === "verified",
  );

  const isConnecting =
    variants.some((v) => connectingIds.has(v._id)) ||
    (pendingQuickConnect?.sourceTab === "registry" &&
      variants.some(
        (variant) =>
          variant._id === pendingQuickConnect.registryServerId ||
          getRegistryServerName(variant) === pendingQuickConnect.serverName ||
          variant.displayName === pendingQuickConnect.displayName,
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
            {isPublisherVerified && (
              <span className="inline-flex shrink-0" title="Verified publisher">
                <BadgeCheck
                  className="h-4 w-4 shrink-0 [&>path:first-of-type]:fill-[#ae5630] [&>path:first-of-type]:stroke-none [&>path:last-of-type]:stroke-white [&>path:last-of-type]:stroke-[2.5] [&>path:last-of-type]:[stroke-linecap:round] [&>path:last-of-type]:[stroke-linejoin:round]"
                  aria-label="Verified publisher"
                />
              </span>
            )}
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
              className={`h-4 w-4 shrink-0 ${card.isStarred ? "fill-amber-400 text-amber-400" : ""}`}
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
    (v) => v.connectionStatus === "connected",
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
