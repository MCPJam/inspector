import { useState } from "react";
import { ServerWithName } from "@/hooks/use-app-state";
import { cn } from "@/lib/utils";
import { ServerModal } from "./connection/ServerModal";
import { ServerFormData } from "@/shared/types.js";
import { Check } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { hasOAuthConfig } from "@/lib/mcp-oauth";
interface ActiveServerSelectorProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[];
  isMultiSelectEnabled: boolean;
  onServerChange: (server: string) => void;
  onMultiServerToggle: (server: string) => void;
  onConnect: (formData: ServerFormData) => void;
  showOnlyOAuthServers?: boolean; // Only show servers that use OAuth
}

function getStatusColor(status: string): string {
  switch (status) {
    case "connected":
      return "bg-green-500 dark:bg-green-400";
    case "connecting":
      return "bg-yellow-500 dark:bg-yellow-400 animate-pulse";
    case "failed":
      return "bg-red-500 dark:bg-red-400";
    case "disconnected":
      return "bg-muted-foreground";
    default:
      return "bg-muted-foreground";
  }
}

function getStatusText(status: string): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting...";
    case "failed":
      return "Failed";
    case "disconnected":
      return "Disconnected";
    default:
      return "Unknown";
  }
}

export function ActiveServerSelector({
  connectedServerConfigs,
  selectedServer,
  selectedMultipleServers,
  isMultiSelectEnabled,
  onServerChange,
  onMultiServerToggle,
  onConnect,
  showOnlyOAuthServers = false,
}: ActiveServerSelectorProps) {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const posthog = usePostHog();

  // Helper function to check if a server uses OAuth
  const isOAuthServer = (server: ServerWithName): boolean => {
    const isHttpServer = "url" in server.config;
    if (!isHttpServer) return false;

    // Check if server has OAuth tokens, OAuth config in localStorage, or is in oauth-flow state
    return !!(
      server.oauthTokens ||
      hasOAuthConfig(server.name) ||
      server.connectionStatus === "oauth-flow"
    );
  };

  const servers = Object.entries(connectedServerConfigs).filter(
    ([, server]) => {
      if (server.enabled === false) return false;

      // If we only want OAuth servers, filter for those
      if (showOnlyOAuthServers && !isOAuthServer(server)) return false;

      // For non-OAuth filtering, only show connected servers
      if (!showOnlyOAuthServers && server.connectionStatus !== "connected")
        return false;

      return true;
    },
  );

  return (
    <div>
      <div className="flex flex-wrap">
        {servers.map(([name, serverConfig]) => {
          const isSelected = isMultiSelectEnabled
            ? selectedMultipleServers.includes(name)
            : selectedServer === name;

          return (
            <button
              key={name}
              onClick={() =>
                isMultiSelectEnabled
                  ? onMultiServerToggle(name)
                  : onServerChange(name)
              }
              className={cn(
                "group relative flex items-center gap-3 px-4 py-3 border-r border-b border-border transition-all duration-200 cursor-pointer",
                "hover:bg-accent hover:text-accent-foreground",
                isSelected
                  ? "bg-muted text-foreground"
                  : "bg-background text-foreground",
              )}
            >
              {isMultiSelectEnabled && (
                <div
                  className={cn(
                    "w-4 h-4 rounded border-2 flex items-center justify-center transition-colors",
                    isSelected
                      ? "bg-primary border-primary text-primary-foreground"
                      : "border-muted-foreground/30 hover:border-primary/50",
                  )}
                >
                  {isSelected && <Check className="w-3 h-3" />}
                </div>
              )}
              <div
                className={cn(
                  "w-2 h-2 rounded-full",
                  getStatusColor(serverConfig.connectionStatus),
                )}
                title={getStatusText(serverConfig.connectionStatus)}
              />
              <span className="text-sm font-medium truncate max-w-36">
                {name}
              </span>
              <div className="text-xs opacity-70">
                {serverConfig.config.command ? "STDIO" : "HTTP"}
              </div>
            </button>
          );
        })}

        {/* Add Server Button */}
        <button
          onClick={() => {
            setIsAddModalOpen(true);
          }}
          className={cn(
            "group relative flex items-center gap-3 px-4 py-3 border-r border-b border-border transition-all duration-200 cursor-pointer",
            "hover:bg-accent hover:text-accent-foreground",
            "bg-background text-muted-foreground border-dashed",
          )}
        >
          {isMultiSelectEnabled && (
            <div className="w-4 h-4" /> // Spacer for alignment
          )}
          <span className="text-sm font-medium">Add Server</span>
          <div className="text-xs opacity-70">+</div>
        </button>
      </div>

      <ServerModal
        mode="add"
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSubmit={(formData) => {
          posthog.capture("connecting_server", {
            location: "active_server_selector",
            platform: detectPlatform(),
            environment: detectEnvironment(),
          });
          onConnect(formData);
        }}
      />
    </div>
  );
}
