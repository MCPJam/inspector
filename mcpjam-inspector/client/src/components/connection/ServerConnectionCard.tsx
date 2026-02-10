import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { Switch } from "../ui/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import {
  MoreVertical,
  Link2Off,
  RefreshCw,
  Loader2,
  Copy,
  Download,
  Check,
  Edit,
  ExternalLink,
  Cable,
  Trash2,
  AlertCircle,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
} from "./server-card-utils";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { ServerInfoModal } from "./ServerInfoModal";
import { downloadJsonFile } from "@/lib/json-config-parser";
import {
  TunnelExplanationModal,
  TUNNEL_EXPLANATION_DISMISSED_KEY,
} from "./TunnelExplanationModal";
import {
  cleanupOrphanedTunnels,
  closeServerTunnel,
  createServerTunnel,
  getServerTunnel,
} from "@/lib/apis/mcp-tunnels-api";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "@/lib/config";
interface ServerConnectionCardProps {
  server: ServerWithName;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean },
  ) => void;
  onEdit: (server: ServerWithName) => void;
  onRemove?: (serverName: string) => void;
  serverTunnelUrl?: string | null;
}

export function ServerConnectionCard({
  server,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
  serverTunnelUrl,
}: ServerConnectionCardProps) {
  const posthog = usePostHog();
  const { getAccessToken } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(
    serverTunnelUrl ?? null,
  );
  const [isCreatingTunnel, setIsCreatingTunnel] = useState(false);
  const [isClosingTunnel, setIsClosingTunnel] = useState(false);
  const [showTunnelExplanation, setShowTunnelExplanation] = useState(false);

  const { label: connectionStatusLabel, indicatorColor } =
    getConnectionStatusMeta(server.connectionStatus);
  const commandDisplay = getServerCommandDisplay(server.config);

  const initializationInfo = server.initializationInfo;

  // Extract server info from initializationInfo
  const serverIcon = initializationInfo?.serverVersion?.icons?.[0];
  const version = initializationInfo?.serverVersion?.version;
  const serverTitle = initializationInfo?.serverVersion?.title;
  const websiteUrl = initializationInfo?.serverVersion?.websiteUrl;
  const protocolVersion = initializationInfo?.protocolVersion;
  const instructions = initializationInfo?.instructions;
  const serverCapabilities = initializationInfo?.serverCapabilities;

  // Build capabilities list
  const capabilities: string[] = [];
  if (serverCapabilities?.tools) capabilities.push("Tools");
  if (serverCapabilities?.prompts) capabilities.push("Prompts");
  if (serverCapabilities?.resources) capabilities.push("Resources");

  const hasInitInfo =
    initializationInfo &&
    (capabilities.length > 0 ||
      protocolVersion ||
      websiteUrl ||
      instructions ||
      serverCapabilities ||
      serverTitle);

  const isConnected = server.connectionStatus === "connected";
  const isTunnelEnabled = !HOSTED_MODE;
  const canManageTunnels = isAuthenticated;
  const showTunnelActions = isConnected && isTunnelEnabled;
  const hasTunnel = Boolean(tunnelUrl);
  const hasError =
    server.connectionStatus === "failed" && Boolean(server.lastError);

  // Load tools when server is connected
  useEffect(() => {
    const loadTools = async () => {
      if (server.connectionStatus !== "connected") {
        setToolsData(null);
        return;
      }
      try {
        const result = await listTools({ serverId: server.name });
        setToolsData(result);
      } catch (err) {
        // Silently fail - tools metadata is optional
        console.error("Failed to load tools metadata:", err);
        setToolsData(null);
      }
    };

    loadTools();
  }, [server.name, server.connectionStatus]);

  useEffect(() => {
    if (serverTunnelUrl !== undefined) {
      setTunnelUrl(serverTunnelUrl);
    }
  }, [serverTunnelUrl]);

  useEffect(() => {
    let isCancelled = false;

    const checkExistingTunnel = async () => {
      if (!showTunnelActions) {
        return;
      }
      try {
        const accessToken = await getAccessToken();
        const existingTunnel = await getServerTunnel(server.name, accessToken);
        if (!isCancelled) {
          setTunnelUrl(existingTunnel?.url ?? null);
        }
      } catch (err) {
        if (!isCancelled && serverTunnelUrl === undefined) {
          setTunnelUrl(null);
        }
      }
    };

    checkExistingTunnel();
    return () => {
      isCancelled = true;
    };
  }, [getAccessToken, server.name, serverTunnelUrl, showTunnelActions]);

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000); // Reset after 2 seconds
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  };

  const handleReconnect = async (options?: { forceOAuthFlow?: boolean }) => {
    setIsReconnecting(true);
    try {
      onReconnect(server.name, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to reconnect to ${server.name}: ${errorMessage}`);
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const toastId = toast.loading(`Exporting ${server.name}…`);
      const data = await exportServerApi(server.name);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `mcp-server-export_${server.name}_${ts}.json`;
      downloadJsonFile(filename, data);
      toast.success(`Exported ${server.name} info to ${filename}`, {
        id: toastId,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to export ${server.name}: ${errorMessage}`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleCreateTunnel = () => {
    posthog.capture("create_tunnel_button_clicked", {
      location: "server_connection_card",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      server_id: server.name,
    });

    const isDismissed =
      localStorage.getItem(TUNNEL_EXPLANATION_DISMISSED_KEY) === "true";
    if (isDismissed) {
      void handleConfirmCreateTunnel();
    } else {
      setShowTunnelExplanation(true);
    }
  };

  const handleConfirmCreateTunnel = async () => {
    setIsCreatingTunnel(true);
    try {
      const accessToken = await getAccessToken();
      await cleanupOrphanedTunnels(accessToken);

      const result = await createServerTunnel(server.name, accessToken);
      setTunnelUrl(result.url);

      await cleanupOrphanedTunnels(accessToken);
      toast.success("Tunnel is ready to use!");
      posthog.capture("tunnel_created", {
        location: "server_connection_card",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
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
      await closeServerTunnel(server.name, accessToken);
      setTunnelUrl(null);
      toast.success("Tunnel closed successfully");
      posthog.capture("tunnel_closed", {
        location: "server_connection_card",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to close tunnel";
      toast.error(`Failed to close tunnel: ${errorMessage}`);
    } finally {
      setIsClosingTunnel(false);
    }
  };

  return (
    <>
      <Card className="group rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm transition-all duration-200 hover:border-border hover:shadow-md">
        <div className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {serverIcon?.src && (
                  <img
                    src={serverIcon.src}
                    alt={`${server.name} icon`}
                    className="h-5 w-5 flex-shrink-0 rounded"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                )}
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {server.name}
                </h3>
                {version && (
                  <span className="text-xs text-muted-foreground">
                    v{version}
                  </span>
                )}
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {hasError && (
                  <button
                    onClick={() => setIsErrorExpanded(true)}
                    className="inline-flex items-center gap-1 rounded-full border border-red-300/60 bg-red-500/10 px-2 py-0.5 text-[11px] text-red-700 dark:text-red-300 cursor-pointer"
                  >
                    <AlertCircle className="h-3 w-3" />
                    Error
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col items-end gap-1.5">
              <div
                className="flex items-center gap-1.5"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: indicatorColor }}
                  />
                  <span>
                    {server.connectionStatus === "failed"
                      ? `${connectionStatusLabel} (${server.retryCount})`
                      : connectionStatusLabel}
                  </span>
                </span>

                <Switch
                  checked={server.connectionStatus === "connected"}
                  onCheckedChange={(checked) => {
                    posthog.capture("connection_switch_toggled", {
                      location: "server_connection_card",
                      platform: detectPlatform(),
                      environment: detectEnvironment(),
                    });
                    if (!checked) {
                      onDisconnect(server.name);
                    } else {
                      handleReconnect();
                    }
                  }}
                  className="cursor-pointer scale-75"
                />

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-muted-foreground/70 hover:text-foreground cursor-pointer"
                    >
                      <MoreVertical className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    <DropdownMenuItem
                      onClick={() => {
                        posthog.capture("reconnect_server_clicked", {
                          location: "server_connection_card",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                        });
                        const shouldForceOAuth =
                          server.useOAuth === true ||
                          server.oauthTokens != null;
                        handleReconnect(
                          shouldForceOAuth
                            ? { forceOAuthFlow: true }
                            : undefined,
                        );
                      }}
                      disabled={
                        isReconnecting ||
                        server.connectionStatus === "connecting" ||
                        server.connectionStatus === "oauth-flow"
                      }
                      className="text-xs cursor-pointer"
                    >
                      {isReconnecting ? (
                        <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                      ) : (
                        <RefreshCw className="h-3 w-3 mr-2" />
                      )}
                      {isReconnecting ? "Reconnecting..." : "Reconnect"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        posthog.capture("edit_server_clicked", {
                          location: "server_connection_card",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                        });
                        onEdit(server);
                      }}
                      className="text-xs cursor-pointer"
                    >
                      <Edit className="h-3 w-3 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        posthog.capture("export_server_clicked", {
                          location: "server_connection_card",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                        });
                        handleExport();
                      }}
                      disabled={
                        isExporting || server.connectionStatus !== "connected"
                      }
                      className="text-xs cursor-pointer"
                    >
                      {isExporting ? (
                        <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-3 w-3 mr-2" />
                      )}
                      {isExporting ? "Exporting..." : "Export server info"}
                    </DropdownMenuItem>
                    <Separator />
                    <DropdownMenuItem
                      className="text-destructive text-xs cursor-pointer"
                      onClick={() => {
                        posthog.capture("remove_server_clicked", {
                          location: "server_connection_card",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                        });
                        onDisconnect(server.name);
                        onRemove?.(server.name);
                      }}
                    >
                      <Link2Off className="h-3 w-3 mr-2" />
                      Remove server
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          </div>

          <div
            className="relative mt-2 rounded-md border border-border/50 bg-muted/30 p-2 pr-8 font-mono text-xs text-muted-foreground"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="break-all">{commandDisplay}</div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                copyToClipboard(commandDisplay, "command");
              }}
              className="absolute right-1 top-1 p-1 text-muted-foreground/60 transition-colors hover:text-foreground cursor-pointer"
            >
              {copiedField === "command" ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>

          <div className="mt-3 flex items-center justify-between">
            <div>
              {hasInitInfo && (
                <button
                  onClick={() => setIsInfoModalOpen(true)}
                  className="text-xs text-muted-foreground transition-colors hover:text-foreground cursor-pointer"
                >
                  View server info
                </button>
              )}
            </div>
            {showTunnelActions && (
              <div onClick={(e) => e.stopPropagation()}>
                {hasTunnel ? (
                  <div className="inline-flex items-center overflow-hidden rounded-full border border-border/70 bg-muted/30 text-foreground">
                    <button
                      onClick={() => copyToClipboard(tunnelUrl!, "tunnel")}
                      className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] transition-colors hover:bg-accent/60 cursor-pointer"
                    >
                      {copiedField === "tunnel" ? (
                        <>
                          <Check className="h-3 w-3" />
                          <span>Copied</span>
                        </>
                      ) : (
                        <>
                          <Cable className="h-3 w-3" />
                          <span>Copy ngrok URL</span>
                        </>
                      )}
                    </button>
                    <span className="h-4 w-px bg-border/80" />
                    <button
                      onClick={handleCloseTunnel}
                      disabled={isClosingTunnel}
                      className="inline-flex items-center justify-center px-1.5 py-0.5 text-destructive transition-colors hover:bg-destructive/15 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                      aria-label="Close tunnel"
                      title="Close tunnel"
                    >
                      {isClosingTunnel ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Trash2 className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleCreateTunnel}
                    disabled={isCreatingTunnel || !canManageTunnels}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                  >
                    {isCreatingTunnel ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Cable className="h-3 w-3" />
                    )}
                    <span>
                      {canManageTunnels
                        ? "Create ngrok tunnel"
                        : "Sign in for tunnel"}
                    </span>
                  </button>
                )}
              </div>
            )}
          </div>

          {hasError && (
            <div className="mt-3 rounded-md border border-red-300/40 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300">
              <div className="break-all">
                {isErrorExpanded
                  ? server.lastError
                  : server.lastError!.length > 140
                    ? `${server.lastError!.substring(0, 140)}...`
                    : server.lastError}
              </div>
              {server.lastError!.length > 140 && (
                <button
                  onClick={() => setIsErrorExpanded((prev) => !prev)}
                  className="mt-1 underline cursor-pointer"
                >
                  {isErrorExpanded ? "Show less" : "Show more"}
                </button>
              )}
              {server.retryCount > 0 && (
                <div className="mt-1 opacity-80">
                  {server.retryCount} retry attempt
                  {server.retryCount !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}

          {server.connectionStatus === "failed" && (
            <div className="mt-2 text-xs text-muted-foreground">
              Having trouble?{" "}
              <a
                href="https://docs.mcpjam.com/troubleshooting/common-errors"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                Check troubleshooting
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
        </div>
      </Card>
      <ServerInfoModal
        isOpen={isInfoModalOpen}
        onClose={() => setIsInfoModalOpen(false)}
        server={server}
        toolsData={toolsData}
      />
      <TunnelExplanationModal
        isOpen={showTunnelExplanation}
        onClose={() => setShowTunnelExplanation(false)}
        onConfirm={handleConfirmCreateTunnel}
        isCreating={isCreatingTunnel}
      />
    </>
  );
}
