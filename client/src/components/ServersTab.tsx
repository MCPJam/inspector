import { useEffect, useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import {
  Plus,
  FileText,
  Cable,
  Link,
  Loader2,
  Copy,
  Check,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { AddServerModal } from "./connection/AddServerModal";
import { EditServerModal } from "./connection/EditServerModal";
import { JsonImportModal } from "./connection/JsonImportModal";
import {
  TunnelExplanationModal,
  TUNNEL_EXPLANATION_DISMISSED_KEY,
} from "./connection/TunnelExplanationModal";
import { ServerFormData } from "@/shared/types.js";
import { MCPIcon } from "./ui/mcp-icon";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import {
  createTunnel,
  getTunnel,
  closeTunnel,
  cleanupOrphanedTunnels,
} from "@/lib/apis/mcp-tunnels-api";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import { CollapsedPanelStrip } from "./ui/collapsed-panel-strip";
import { LoggerView } from "./logging/logger-view";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";

interface ServersTabProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean },
  ) => void;
  onUpdate: (
    originalServerName: string,
    formData: ServerFormData,
    skipAutoConnect?: boolean,
  ) => void;
  onRemove: (serverName: string) => void;
}

export function ServersTab({
  connectedServerConfigs,
  onConnect,
  onDisconnect,
  onReconnect,
  onUpdate,
  onRemove,
}: ServersTabProps) {
  const posthog = usePostHog();
  const { getAccessToken } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<ServerWithName | null>(null);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(null);
  const [isCreatingTunnel, setIsCreatingTunnel] = useState(false);
  const [isClosingTunnel, setIsClosingTunnel] = useState(false);
  const [isTunnelUrlCopied, setIsTunnelUrlCopied] = useState(false);
  const [showTunnelExplanation, setShowTunnelExplanation] = useState(false);

  useEffect(() => {
    posthog.capture("servers_tab_viewed", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      num_servers: Object.keys(connectedServerConfigs).length,
    });
  }, []);

  // Check for existing tunnel on mount
  useEffect(() => {
    const checkExistingTunnel = async () => {
      try {
        const accessToken = await getAccessToken();
        const existingTunnel = await getTunnel(accessToken);
        if (existingTunnel) {
          setTunnelUrl(existingTunnel.url);
        }
      } catch (err) {
        console.debug("No existing tunnel found:", err);
      }
    };

    checkExistingTunnel();
  }, [getAccessToken]);

  const connectedCount = Object.keys(connectedServerConfigs).length;

  const handleEditServer = (server: ServerWithName) => {
    setServerToEdit(server);
    setIsEditingServer(true);
  };

  const handleCloseEditModal = () => {
    setIsEditingServer(false);
    setServerToEdit(null);
  };

  const handleJsonImport = (servers: ServerFormData[]) => {
    servers.forEach((server) => {
      onConnect(server);
    });
  };

  const handleAddServerClick = () => {
    posthog.capture("add_server_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsAddingServer(true);
    setIsActionMenuOpen(false);
  };

  const handleImportJsonClick = () => {
    posthog.capture("import_json_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsImportingJson(true);
    setIsActionMenuOpen(false);
  };

  const handleCreateTunnel = () => {
    posthog.capture("create_tunnel_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });

    const isDismissed =
      localStorage.getItem(TUNNEL_EXPLANATION_DISMISSED_KEY) === "true";
    if (isDismissed) {
      handleConfirmCreateTunnel();
    } else {
      setShowTunnelExplanation(true);
    }
  };

  const handleConfirmCreateTunnel = async () => {
    setIsCreatingTunnel(true);
    try {
      const accessToken = await getAccessToken();

      // Cleanup orphaned tunnels BEFORE creating new one
      await cleanupOrphanedTunnels(accessToken);

      const result = await createTunnel(accessToken);
      setTunnelUrl(result.url);

      // Cleanup again AFTER creation to catch the tunnel that was just closed
      // (recordTunnel marks the old tunnel as closed)
      await cleanupOrphanedTunnels(accessToken);

      toast.success("Tunnel is ready to use!");

      posthog.capture("tunnel_created", {
        location: "servers_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });

      setShowTunnelExplanation(false);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to create tunnel";
      toast.error(`Tunnel creation failed: ${errorMessage}`);
    } finally {
      setIsCreatingTunnel(false);
    }
  };

  const handleCloseTunnel = async () => {
    setIsClosingTunnel(true);
    try {
      const accessToken = await getAccessToken();
      await closeTunnel(accessToken);
      setTunnelUrl(null);

      toast.success("Tunnel closed successfully");

      posthog.capture("tunnel_closed", {
        location: "servers_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to close tunnel";
      toast.error(`Failed to close tunnel: ${errorMessage}`);
    } finally {
      setIsClosingTunnel(false);
    }
  };

  const copyTunnelUrl = async () => {
    if (!tunnelUrl) return;

    posthog.capture("copy_tunnel_url_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });

    try {
      await navigator.clipboard.writeText(tunnelUrl);
      setIsTunnelUrlCopied(true);
      setTimeout(() => setIsTunnelUrlCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy tunnel URL:", error);
    }
  };

  const renderTunnelButton = () => {
    if (tunnelUrl) {
      return (
        <Button
          variant="destructive"
          size="sm"
          onClick={handleCloseTunnel}
          disabled={isClosingTunnel}
          className="cursor-pointer relative"
        >
          {isClosingTunnel ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Close Tunnel
            </>
          ) : (
            <>
              <span className="relative flex h-2 w-2 mr-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary-foreground opacity-50"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-primary-foreground"></span>
              </span>
              Close Tunnel
            </>
          )}
        </Button>
      );
    }

    const button = (
      <Button
        variant="outline"
        size="sm"
        onClick={handleCreateTunnel}
        disabled={isCreatingTunnel || !isAuthenticated}
        className="cursor-pointer"
      >
        {isCreatingTunnel ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Cable className="h-4 w-4 mr-2" />
        )}
        Create ngrok tunnel
      </Button>
    );

    if (!isAuthenticated) {
      return (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{button}</span>
            </TooltipTrigger>
            <TooltipContent>
              <p>Sign in to create tunnels</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );
    }

    return button;
  };

  const renderServerActionsMenu = () => (
    <HoverCard
      open={isActionMenuOpen}
      onOpenChange={setIsActionMenuOpen}
      openDelay={150}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <Button
          size="sm"
          onClick={handleAddServerClick}
          className="cursor-pointer"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Server
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="end" sideOffset={8} className="w-56 p-3">
        <div className="flex flex-col gap-2">
          <Button
            variant="ghost"
            className="justify-start"
            onClick={handleAddServerClick}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add manually
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            onClick={handleImportJsonClick}
          >
            <FileText className="h-4 w-4 mr-2" />
            Import JSON
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );

  const renderConnectedContent = () => (
    <ResizablePanelGroup direction="horizontal" className="flex-1">
      {/* Main Server List Panel */}
      <ResizablePanel
        defaultSize={isJsonRpcPanelVisible ? 65 : 100}
        minSize={70}
      >
        <div className="space-y-6 p-8 h-full overflow-auto">
          {/* Header Section */}
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <h2 className="text-2xl font-bold tracking-tight">
                  MCP Servers
                </h2>
              </div>
              <div className="flex items-center gap-2">
                {renderTunnelButton()}
                {renderServerActionsMenu()}
              </div>
            </div>
          </div>

          {/* Server Cards Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-1 xl:grid-cols-2 gap-6">
            {Object.entries(connectedServerConfigs).map(([name, server]) => (
              <ServerConnectionCard
                key={name}
                server={server}
                onDisconnect={onDisconnect}
                onReconnect={onReconnect}
                onEdit={handleEditServer}
                onRemove={onRemove}
                sharedTunnelUrl={tunnelUrl}
              />
            ))}
          </div>
        </div>
      </ResizablePanel>

      {/* JSON-RPC Traces Panel */}
      {isJsonRpcPanelVisible ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={35} minSize={20} maxSize={50}>
            <div className="h-full flex flex-col bg-background border-l border-border">
              <LoggerView key={connectedCount} onClose={toggleJsonRpcPanel} />
            </div>
          </ResizablePanel>
        </>
      ) : (
        <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
      )}
    </ResizablePanelGroup>
  );

  const renderEmptyContent = () => (
    <div className="space-y-6 p-8 h-full overflow-auto">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h2 className="text-2xl font-bold tracking-tight">MCP Servers</h2>
          {tunnelUrl && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Tunnel:</span>
              <button
                onClick={copyTunnelUrl}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground bg-muted/20 px-1.5 py-0.5 rounded border border-border/20 transition-colors cursor-pointer"
              >
                <Link className="h-2.5 w-2.5 flex-shrink-0" />
                {isTunnelUrlCopied ? (
                  <>
                    <Check className="h-2.5 w-2.5 text-green-500" />
                    <span className="text-green-500">Copied!</span>
                  </>
                ) : (
                  <Copy className="h-2.5 w-2.5" />
                )}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {renderTunnelButton()}
          {renderServerActionsMenu()}
        </div>
      </div>

      {/* Empty State */}
      <Card className="p-12 text-center">
        <div className="mx-auto max-w-sm">
          <MCPIcon className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">No servers connected</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Get started by connecting to your first MCP server
          </p>
          <Button
            onClick={() => setIsAddingServer(true)}
            className="mt-4 cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Your First Server
          </Button>
        </div>
      </Card>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      {connectedCount > 0 ? renderConnectedContent() : renderEmptyContent()}

      {/* Add Server Modal */}
      <AddServerModal
        isOpen={isAddingServer}
        onClose={() => {
          setIsAddingServer(false);
        }}
        onSubmit={(formData) => {
          posthog.capture("connecting_server", {
            location: "servers_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
          });
          onConnect(formData);
        }}
      />

      {/* Edit Server Modal */}
      {serverToEdit && (
        <EditServerModal
          isOpen={isEditingServer}
          onClose={handleCloseEditModal}
          onSubmit={(formData, originalName) =>
            onUpdate(originalName, formData)
          }
          server={serverToEdit}
        />
      )}

      {/* JSON Import Modal */}
      <JsonImportModal
        isOpen={isImportingJson}
        onClose={() => setIsImportingJson(false)}
        onImport={handleJsonImport}
      />

      {/* Tunnel Explanation Modal */}
      <TunnelExplanationModal
        isOpen={showTunnelExplanation}
        onClose={() => setShowTunnelExplanation(false)}
        onConfirm={handleConfirmCreateTunnel}
        isCreating={isCreatingTunnel}
      />
    </div>
  );
}
