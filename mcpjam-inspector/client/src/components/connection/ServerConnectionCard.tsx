import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { TooltipProvider } from "../ui/tooltip";
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
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerTransportLabel,
} from "./server-card-utils";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { ServerInfoModal } from "./ServerInfoModal";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
interface ServerConnectionCardProps {
  server: ServerWithName;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean },
  ) => void;
  onEdit: (server: ServerWithName) => void;
  onRemove?: (serverName: string) => void;
  sharedTunnelUrl?: string | null;
}

export function ServerConnectionCard({
  server,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
  sharedTunnelUrl,
}: ServerConnectionCardProps) {
  const posthog = usePostHog();
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);

  const { label: connectionStatusLabel, indicatorColor } =
    getConnectionStatusMeta(server.connectionStatus);
  const transportLabel = getServerTransportLabel(server.config);
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

  // Check if this is an MCP App (has tools with ui.resourceUri metadata)
  const isMCPAppServer = isMCPApp(toolsData);

  // Check if this is an OpenAI app (has tools with openai/outputTemplate metadata)
  const isOpenAIAppServer = isOpenAIApp(toolsData);

  // Check if this is an OpenAI app and MCP app (has tools with openai/outputTemplate and ui.resourceUri metadata)
  const isOpenAIAppAndMCPAppServer = isOpenAIAppAndMCPApp(toolsData);

  // Compute the server-specific tunnel URL from the shared tunnel
  // Only show tunnel URL if server is connected
  const serverTunnelUrl =
    sharedTunnelUrl && server.connectionStatus === "connected"
      ? `${sharedTunnelUrl}/api/mcp/adapter-http/${server.name}`
      : null;

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

  const downloadJson = (filename: string, data: any) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const toastId = toast.loading(`Exporting ${server.name}…`);
      const data = await exportServerApi(server.name);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `mcp-server-export_${server.name}_${ts}.json`;
      downloadJson(filename, data);
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

  return (
    <TooltipProvider>
      <Card className="border border-border/50 bg-card/50 backdrop-blur-sm hover:border-primary/50 hover:shadow-md hover:bg-card/70 transition-all duration-200 px-2 py-2">
        <div className="p-3 space-y-2">
          {/* Header Row - Split Left/Right */}
          <div className="flex items-start justify-between gap-4">
            {/* Left Side: Icon + Name/Transport/Version */}
            <div className="flex items-center gap-2 flex-1 min-w-0 pb-2">
              {/* Server Icon */}
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

              {/* Name, Transport, Version */}
              <div className="flex flex-col gap-0 min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <h3 className="font-medium text-sm text-foreground truncate">
                    {server.name}
                  </h3>
                  {version && (
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      v{version}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {transportLabel}
                </p>
              </div>
            </div>

            {/* Right Side: Status + Toggle + Menu */}
            <div
              className="flex items-center gap-2 flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Connection Status */}
              <div className="flex items-center gap-1.5">
                <div
                  className="h-1.5 w-1.5 rounded-full flex-shrink-0"
                  style={{
                    backgroundColor: indicatorColor,
                  }}
                />
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  {server.connectionStatus === "failed"
                    ? `${connectionStatusLabel} (${server.retryCount})`
                    : connectionStatusLabel}
                </span>
              </div>

              {/* Toggle Switch */}
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

              {/* Dropdown Menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 w-6 p-0 text-muted-foreground/50 hover:text-foreground cursor-pointer"
                  >
                    <MoreVertical className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem
                    onClick={() => {
                      posthog.capture("reconnect_server_clicked", {
                        location: "server_connection_card",
                        platform: detectPlatform(),
                        environment: detectEnvironment(),
                      });
                      // Only force OAuth flow for servers that actually use OAuth
                      const shouldForceOAuth =
                        server.useOAuth === true || server.oauthTokens != null;
                      handleReconnect(
                        shouldForceOAuth ? { forceOAuthFlow: true } : undefined,
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

          {/* Command/URL Display */}
          <div
            className="font-mono text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/30 break-all relative group"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="pr-8">{commandDisplay}</div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                copyToClipboard(commandDisplay, "command");
              }}
              className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
            >
              {copiedField === "command" ? (
                <Check className="h-3 w-3" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>

          {/* Server Info and Tunnel URL Row */}
          {(hasInitInfo || serverTunnelUrl) && (
            <div className="flex items-center justify-between gap-4">
              {hasInitInfo && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsInfoModalOpen(true);
                  }}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <span>{"View server info"}</span>
                  {(isOpenAIAppServer || isOpenAIAppAndMCPAppServer) && (
                    <img
                      src="/openai_logo.png"
                      alt="OpenAI App"
                      className="h-4 w-4 flex-shrink-0"
                      title="OpenAI App"
                    />
                  )}
                  {(isMCPAppServer || isOpenAIAppAndMCPAppServer) && (
                    <img
                      src="/mcp.svg"
                      alt="MCP App"
                      className="h-4 w-4 flex-shrink-0 dark:invert"
                      title="MCP App"
                    />
                  )}
                </button>
              )}
              {serverTunnelUrl && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    copyToClipboard(serverTunnelUrl, "tunnel");
                  }}
                  className="flex items-center gap-1.5 text-xs text-primary hover:underline cursor-pointer"
                >
                  {copiedField === "tunnel" ? (
                    <>
                      <Check className="h-3 w-3" />
                      <span>Copied!</span>
                    </>
                  ) : (
                    <>
                      <Cable className="h-3 w-3" />
                      <span>Copy Tunnel Url</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}

          {/* Error Alert for Failed Connections */}
          {server.connectionStatus === "failed" && server.lastError && (
            <div className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 p-2 rounded border border-red-200 dark:border-red-800/30">
              <div className="break-all">
                {isErrorExpanded
                  ? server.lastError
                  : server.lastError.length > 100
                    ? `${server.lastError.substring(0, 100)}...`
                    : server.lastError}
              </div>
              {server.lastError.length > 100 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsErrorExpanded(!isErrorExpanded);
                  }}
                  className="text-red-500/70 hover:text-red-500 mt-1 underline text-xs cursor-pointer"
                >
                  {isErrorExpanded ? "Show less" : "Show more"}
                </button>
              )}
              {server.retryCount > 0 && (
                <div className="text-red-500/70 mt-1">
                  {server.retryCount} retry attempt
                  {server.retryCount !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}

          {server.connectionStatus === "failed" && (
            <div className="text-muted-foreground text-xs">
              Having trouble?{" "}
              <a
                href="https://docs.mcpjam.com/troubleshooting/common-errors"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
              >
                Check out our troubleshooting page
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
    </TooltipProvider>
  );
}
