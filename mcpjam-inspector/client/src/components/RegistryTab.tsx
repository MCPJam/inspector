import { useState, useEffect } from "react";
import {
  Package,
  KeyRound,
  ShieldOff,
  CheckCircle2,
  Loader2,
  MoreVertical,
  Unplug,
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
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  useRegistryServers,
  type EnrichedRegistryServer,
  type RegistryConnectionStatus,
} from "@/hooks/useRegistryServers";
import type { ServerFormData } from "@/shared/types.js";
import type { ServerWithName } from "@/hooks/use-app-state";

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

  const { registryServers, categories, isLoading, connect, disconnect } =
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
    if (!onNavigate) return;
    const pending = localStorage.getItem("registry-pending-redirect");
    if (!pending) return;
    const liveServer = servers?.[pending];
    if (liveServer?.connectionStatus === "connected") {
      localStorage.removeItem("registry-pending-redirect");
      onNavigate("app-builder");
    }
  }, [servers, onNavigate]);

  const filteredServers = registryServers;

  const handleConnect = async (server: EnrichedRegistryServer) => {
    setConnectingIds((prev) => new Set(prev).add(server._id));
    localStorage.setItem("registry-pending-redirect", server.displayName);
    try {
      await connect(server);
    } catch (error) {
      if (
        localStorage.getItem("registry-pending-redirect") === server.displayName
      ) {
        localStorage.removeItem("registry-pending-redirect");
      }
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
    const pending = localStorage.getItem("registry-pending-redirect");
    if (pending === server.displayName) {
      localStorage.removeItem("registry-pending-redirect");
    }
    await disconnect(server);
  };

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (registryServers.length === 0) {
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
            Pre-configured MCP servers you can connect with one click.
          </p>
        </div>

        {/* Server cards grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filteredServers.map((server: EnrichedRegistryServer) => (
            <RegistryServerCard
              key={server._id}
              server={server}
              isConnecting={connectingIds.has(server._id)}
              onConnect={() => handleConnect(server)}
              onDisconnect={() => handleDisconnect(server)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function RegistryServerCard({
  server,
  isConnecting,
  onConnect,
  onDisconnect,
}: {
  server: EnrichedRegistryServer;
  isConnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const effectiveStatus: RegistryConnectionStatus = isConnecting
    ? "connecting"
    : server.connectionStatus;
  const isConnectedOrAdded =
    effectiveStatus === "connected" || effectiveStatus === "added";

  return (
    <Card className="px-4 py-3 flex flex-col gap-2">
      {/* Top row: icon + name + auth pill + action (top-right) */}
      <div className="flex items-center gap-3">
        {server.iconUrl ? (
          <img
            src={server.iconUrl}
            alt={server.displayName}
            className="h-8 w-8 rounded-md object-contain flex-shrink-0"
          />
        ) : (
          <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
            <Package className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <h3 className="text-sm font-semibold truncate">
              {server.displayName}
            </h3>
            <AuthBadge useOAuth={server.transport.useOAuth} />
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {server.category}
            </Badge>
          </div>
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-xs text-muted-foreground">
              {server.publisher}
            </span>
            {server.publisher === "MCPJam" && (
              <svg
                className="h-4 w-4 flex-shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="12" cy="12" r="10" fill="#e87a4a" />
                <path
                  d="M8 12.5l2.5 2.5L16 9.5"
                  stroke="white"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </div>
        </div>
        {/* Top-right action */}
        <div className="flex-shrink-0">
          <TopRightAction
            status={effectiveStatus}
            onConnect={onConnect}
            onDisconnect={onDisconnect}
          />
        </div>
      </div>

      {/* Description */}
      <p className="text-xs text-muted-foreground line-clamp-2">
        {server.description}
      </p>
    </Card>
  );
}

function AuthBadge({ useOAuth }: { useOAuth?: boolean }) {
  if (useOAuth) {
    return (
      <Badge
        variant="outline"
        className="text-[10px] px-1.5 py-0 gap-0.5 text-muted-foreground"
      >
        <KeyRound className="h-2.5 w-2.5" />
        OAuth
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="text-[10px] px-1.5 py-0 gap-0.5 text-muted-foreground"
    >
      <ShieldOff className="h-2.5 w-2.5" />
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
            variant="outline"
            size="sm"
            className="h-7 text-xs cursor-default"
            tabIndex={-1}
          >
            Added
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
