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
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Skeleton } from "./ui/skeleton";
import { EmptyState } from "./ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
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

/** Drop stale registry pending when OAuth was abandoned (browser closed) without a terminal callback. */
const REGISTRY_PENDING_OAUTH_STALE_MS = 45 * 60 * 1000;

interface RegistryTabProps {
  workspaceId: string | null;
  isAuthenticated: boolean;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
  onNavigate?: (tab: string) => void;
  servers?: Record<string, ServerWithName>;
}

export function RegistryTab({
  workspaceId,
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
      workspaceId,
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
      onNavigate?.("app-builder");
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
              <span
                className="inline-flex shrink-0"
                title="Verified publisher"
              >
                <BadgeCheck
                  className="h-4 w-4 shrink-0 [&>path:first-of-type]:fill-orange-500 [&>path:first-of-type]:stroke-none [&>path:last-of-type]:stroke-white [&>path:last-of-type]:stroke-[2.5] [&>path:last-of-type]:[stroke-linecap:round] [&>path:last-of-type]:[stroke-linejoin:round]"
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
            className="h-7 text-xs bg-green-600 hover:bg-green-600 text-white cursor-default"
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
            title="Server is in your workspace — click to connect"
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
                  <MonitorSmartphone className="h-3.5 w-3.5 mr-2 text-blue-400" />
                ) : (
                  <MessageSquareText className="h-3.5 w-3.5 mr-2 text-violet-400" />
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
              <MonitorSmartphone className="h-3.5 w-3.5 mr-2 text-blue-400" />
            ) : (
              <MessageSquareText className="h-3.5 w-3.5 mr-2 text-violet-400" />
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
        className="text-[11px] px-1.5 py-0.5 gap-1 border-blue-500/40 text-blue-400"
      >
        <MonitorSmartphone className="h-3 w-3" />
        App
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[11px] px-1.5 py-0.5 gap-1 border-violet-500/40 text-violet-400"
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
        className="text-[11px] px-1.5 py-0.5 gap-1 border-emerald-500/40 text-emerald-400"
      >
        <KeyRound className="h-3 w-3" />
        OAuth
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[11px] px-1.5 py-0.5 gap-1 border-amber-500/40 text-amber-400"
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
            className="h-7 text-xs bg-green-600 hover:bg-green-600 text-white cursor-default"
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
            title="Server is in your workspace — click to connect"
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
