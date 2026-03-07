import { useQuery } from "convex/react";
import { Package, Loader2, CheckCircle2, Unplug } from "lucide-react";
import { Card } from "./ui/card";
import { Skeleton } from "./ui/skeleton";
import { EmptyState } from "./ui/empty-state";
import type { ServerFormData } from "@/shared/types";
import type { ServerWithName } from "@/state/app-types";
import { useState } from "react";

interface RegistryServer {
  _id: string;
  slug: string;
  name: string;
  description: string;
  iconUrl: string;
  url: string;
  useOAuth: boolean;
  oauthScopes?: string[];
  clientId?: string;
  sortOrder: number;
}

interface RegistryTabProps {
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
  servers?: Record<string, ServerWithName>;
}

function RegistryServerCard({
  server,
  onConnect,
  onDisconnect,
  connectionStatus,
}: {
  server: RegistryServer;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect?: (serverName: string) => void;
  connectionStatus?: string;
}) {
  const [isConnecting, setIsConnecting] = useState(false);
  const isConnected = connectionStatus === "connected";
  const isInProgress =
    connectionStatus === "connecting" || connectionStatus === "oauth-flow";

  const handleConnect = () => {
    setIsConnecting(true);
    const formData: ServerFormData = {
      name: server.name,
      type: "http",
      url: server.url,
      useOAuth: server.useOAuth,
      oauthScopes: server.oauthScopes,
      clientId: server.clientId,
      registryManaged: true,
      registrySlug: server.slug,
    };
    onConnect(formData);
    setTimeout(() => setIsConnecting(false), 2000);
  };

  const handleDisconnect = () => {
    onDisconnect?.(server.name);
  };

  return (
    <Card className="group h-full rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm transition-all duration-200 hover:border-border hover:shadow-md">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            <img
              src={server.iconUrl}
              alt={`${server.name} icon`}
              className="h-8 w-8 rounded"
              onError={(e) => {
                e.currentTarget.style.display = "none";
              }}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {server.name}
              </h3>
              {isConnected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-3 w-3" />
                  Connected
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
              {server.description}
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-md border border-border/50 bg-muted/30 p-2 font-mono text-xs text-muted-foreground">
          <div className="truncate">{server.url}</div>
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          {isConnected ? (
            <button
              onClick={handleDisconnect}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 cursor-pointer"
            >
              <Unplug className="h-3 w-3" />
              <span>Disconnect</span>
            </button>
          ) : (
            <button
              onClick={handleConnect}
              disabled={isConnecting || isInProgress}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
            >
              {isConnecting || isInProgress ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Connecting...</span>
                </>
              ) : (
                <span>Connect</span>
              )}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

function LoadingSkeleton() {
  return (
    <div className="h-full w-full overflow-auto">
      <div className="space-y-6 p-8">
        <div>
          <Skeleton className="h-6 w-40 mb-2" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-xl" />
          ))}
        </div>
      </div>
    </div>
  );
}

export function RegistryTab({
  onConnect,
  onDisconnect,
  servers,
}: RegistryTabProps) {
  const registryServers = useQuery(
    "registryServers:listEnabled" as any,
    {} as any,
  ) as RegistryServer[] | undefined;

  const isLoading = registryServers === undefined;

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  if (!registryServers || registryServers.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title="No Registry Servers"
        description="No servers are available in the registry at this time."
      />
    );
  }

  return (
    <div className="h-full w-full overflow-auto">
      <div className="space-y-6 p-8">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            Server Registry
          </h2>
          <p className="text-sm text-muted-foreground">
            Connect to popular MCP servers with one click.
          </p>
        </div>
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {registryServers.map((server) => {
            const serverState = servers?.[server.name];
            return (
              <RegistryServerCard
                key={server._id}
                server={server}
                onConnect={onConnect}
                onDisconnect={onDisconnect}
                connectionStatus={serverState?.connectionStatus}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
