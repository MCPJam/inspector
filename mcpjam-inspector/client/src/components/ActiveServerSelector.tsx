import { useEffect, useRef, useState } from "react";
import { ServerWithName } from "@/hooks/use-app-state";
import { cn } from "@/lib/utils";
import { AddServerModal } from "./connection/AddServerModal";
import { ServerFormData } from "@/shared/types.js";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { hasOAuthConfig } from "@/lib/oauth/mcp-oauth";
import { ConfirmChatResetDialog } from "./chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
export interface ActiveServerSelectorProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServer: string;
  selectedMultipleServers: string[];
  isMultiSelectEnabled: boolean;
  onServerChange: (server: string) => void;
  onMultiServerToggle: (server: string) => void;
  onConnect: (formData: ServerFormData) => void;
  showOnlyOAuthServers?: boolean; // Only show servers that use OAuth
  showOnlyOpenAIAppsServers?: boolean; // Only show servers that have OpenAI apps tools
  openAiAppOrMcpAppsServers?: Set<string>; // Set of server names that have OpenAI apps or MCP apps
  hasMessages?: boolean;
  className?: string;
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
  serverConfigs,
  selectedServer,
  selectedMultipleServers,
  isMultiSelectEnabled,
  onServerChange,
  onMultiServerToggle,
  onConnect,
  showOnlyOAuthServers = false,
  showOnlyOpenAIAppsServers = false,
  openAiAppOrMcpAppsServers,
  hasMessages = false,
  className,
}: ActiveServerSelectorProps) {
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [pendingServer, setPendingServer] = useState<string | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
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

  const servers = Object.entries(serverConfigs).filter(([name, server]) => {
    if (showOnlyOAuthServers && !isOAuthServer(server)) return false;
    if (
      showOnlyOpenAIAppsServers &&
      openAiAppOrMcpAppsServers &&
      !openAiAppOrMcpAppsServers.has(name)
    )
      return false;
    return true;
  });

  // Auto-select first available server if current selection is not in the list
  useEffect(() => {
    if (isMultiSelectEnabled) return; // Don't auto-select in multi-select mode

    const serverNames = servers.map(([name]) => name);
    const isCurrentSelectionValid = serverNames.includes(selectedServer);

    if (!isCurrentSelectionValid && serverNames.length > 0) {
      onServerChange(serverNames[0]);
    }
  }, [servers.length, selectedServer, isMultiSelectEnabled, onServerChange]);

  const handleServerClick = (name: string) => {
    if (isMultiSelectEnabled) {
      if (hasMessages) {
        setPendingServer(name);
        setShowConfirmDialog(true);
        return;
      }
      onMultiServerToggle(name);
    } else {
      const isDifferentServer = selectedServer !== name;
      if (isDifferentServer && hasMessages) {
        setPendingServer(name);
        setShowConfirmDialog(true);
        return;
      }
      onServerChange(name);
    }
  };

  const handleConfirmChange = () => {
    if (pendingServer) {
      if (isMultiSelectEnabled) {
        onMultiServerToggle(pendingServer);
      } else {
        onServerChange(pendingServer);
      }
      setPendingServer(null);
    }
    setShowConfirmDialog(false);
  };

  const handleCancelChange = () => {
    setPendingServer(null);
    setShowConfirmDialog(false);
  };

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;

    const updateScrollState = () => {
      setCanScrollLeft(node.scrollLeft > 0);
      setCanScrollRight(
        node.scrollLeft + node.clientWidth < node.scrollWidth - 1,
      );
    };

    updateScrollState();
    node.addEventListener("scroll", updateScrollState, { passive: true });
    window.addEventListener("resize", updateScrollState);

    return () => {
      node.removeEventListener("scroll", updateScrollState);
      window.removeEventListener("resize", updateScrollState);
    };
  }, [servers.length]);

  const scroll = (direction: "left" | "right") => {
    const node = scrollRef.current;
    if (!node) return;
    // Scroll by approximately 2 tab widths (200px) for smooth incremental navigation
    const scrollAmount = 200;
    const newScrollLeft =
      direction === "left"
        ? Math.max(0, node.scrollLeft - scrollAmount)
        : Math.min(
            node.scrollWidth - node.clientWidth,
            node.scrollLeft + scrollAmount,
          );
    node.scrollTo({
      left: newScrollLeft,
      behavior: "smooth",
    });
  };

  return (
    <div className={cn("relative h-full w-full min-w-0", className)}>
      <div
        ref={scrollRef}
        className={cn(
          "w-full h-full min-w-0 overflow-x-auto scrollbar-hidden",
          "flex justify-start",
        )}
      >
        <div className="flex flex-nowrap min-w-fit h-full">
          {servers.map(([name, serverConfig]) => {
            const isSelected = isMultiSelectEnabled
              ? selectedMultipleServers.includes(name)
              : selectedServer === name;

            return (
              <button
                key={name}
                onClick={() => handleServerClick(name)}
                className={cn(
                  "group relative flex h-full items-center gap-3 px-4 border-r border-border transition-all duration-200 cursor-pointer",
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
              "group relative flex h-full items-center gap-3 px-4 border-r border-border transition-all duration-200 cursor-pointer",
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

        <AddServerModal
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

        <ConfirmChatResetDialog
          open={showConfirmDialog}
          onConfirm={handleConfirmChange}
          onCancel={handleCancelChange}
          message="Changing server selection will cause the chat to reset. This action cannot be undone."
        />

        {canScrollLeft && (
          <button
            className="absolute left-0 top-0 h-full px-3 flex items-center bg-gradient-to-r from-background via-background/95 to-background/40 cursor-pointer"
            onClick={() => scroll("left")}
            aria-label="Scroll left"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        {canScrollRight && (
          <button
            className="absolute right-0 top-0 h-full px-3 flex items-center bg-gradient-to-l from-background via-background/95 to-background/40 cursor-pointer"
            onClick={() => scroll("right")}
            aria-label="Scroll right"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>
    </div>
  );
}
