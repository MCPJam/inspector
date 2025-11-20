import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Card } from "../ui/card";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { TooltipProvider } from "../ui/tooltip";
import { Switch } from "../ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
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
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/mcp-export-api";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerTransportLabel,
} from "./server-card-utils";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/mcp-tools-api";

interface ServerConnectionCardProps {
  server: ServerWithName;
  onDisconnect: (serverName: string) => void;
  onReconnect: (serverName: string) => void;
  onEdit: (server: ServerWithName) => void;
  onRemove?: (serverName: string) => void;
}

export function ServerConnectionCard({
  server,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
}: ServerConnectionCardProps) {
  const posthog = usePostHog();
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [isCapabilitiesExpanded, setIsCapabilitiesExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);
  const [isLoadingTools, setIsLoadingTools] = useState(false);

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

  // Check if this is an OpenAI app (has tools with metadata)
  const isOpenAIApp =
    toolsData?.toolsMetadata && Object.keys(toolsData.toolsMetadata).length > 0;

  // Load tools when server is connected
  useEffect(() => {
    const loadTools = async () => {
      if (server.connectionStatus !== "connected") {
        setToolsData(null);
        return;
      }

      setIsLoadingTools(true);
      try {
        const result = await listTools(server.name);
        setToolsData(result);
      } catch (err) {
        // Silently fail - tools metadata is optional
        console.error("Failed to load tools metadata:", err);
        setToolsData(null);
      } finally {
        setIsLoadingTools(false);
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

  const handleReconnect = async () => {
    setIsReconnecting(true);
    try {
      onReconnect(server.name);
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
          <div className="flex items-center justify-between gap-4">
            {/* Left Side: Icon + Name/Transport/Version */}
            <div className="flex items-center gap-2 flex-1 min-w-0">
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
                      handleReconnect();
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
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>

          {/* Collapsible Capabilities Section */}
          {hasInitInfo && (
            <div onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() =>
                  setIsCapabilitiesExpanded(!isCapabilitiesExpanded)
                }
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors w-full cursor-pointer"
              >
                {isCapabilitiesExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                <span>
                  {isCapabilitiesExpanded
                    ? "Hide details"
                    : isOpenAIApp
                      ? "Server info / OpenAI Metadata"
                      : "Server info"}
                </span>
                {isOpenAIApp && (
                  <img
                    src="/openai_logo.png"
                    alt="OpenAI App"
                    className="h-5 w-5 flex-shrink-0 ml-1"
                    title="OpenAI App"
                  />
                )}
              </button>

              {isCapabilitiesExpanded && (
                <div className="mt-2">
                  {isOpenAIApp ? (
                    <Tabs defaultValue="metadata" className="w-full">
                      <TabsList className="grid w-full grid-cols-2 h-7 p-0.5 mb-2">
                        <TabsTrigger
                          value="info"
                          className="text-[10px] h-6 px-2 data-[state=active]:bg-background"
                        >
                          Info
                        </TabsTrigger>
                        <TabsTrigger
                          value="metadata"
                          className="text-[10px] h-6 px-2 data-[state=active]:bg-background"
                        >
                          OpenAI Tool Metadata
                        </TabsTrigger>
                      </TabsList>

                      <TabsContent value="info" className="mt-0">
                        <div className="p-3 bg-muted/20 rounded border border-border/30 space-y-3">
                          {serverTitle && (
                            <div className="text-xs">
                              <span className="text-muted-foreground/70">
                                Server Name:
                              </span>{" "}
                              <span className="text-foreground">
                                {serverTitle}
                              </span>
                            </div>
                          )}

                          {protocolVersion && (
                            <div className="text-xs">
                              <span className="text-muted-foreground/70">
                                MCP Protocol:
                              </span>{" "}
                              <span className="text-foreground">
                                {protocolVersion}
                              </span>
                            </div>
                          )}

                          {capabilities.length > 0 && (
                            <div className="text-xs">
                              <span className="text-muted-foreground/70">
                                Capabilities:
                              </span>{" "}
                              <span className="text-foreground">
                                {capabilities.join(", ")}
                              </span>
                            </div>
                          )}

                          {instructions && (
                            <div className="text-xs space-y-1">
                              <div className="text-muted-foreground/70 font-medium">
                                Instructions:
                              </div>
                              <div className="text-foreground whitespace-pre-wrap bg-muted/30 p-2 rounded border border-border/20">
                                {instructions}
                              </div>
                            </div>
                          )}

                          {serverCapabilities && (
                            <div className="text-xs space-y-1">
                              <div className="text-muted-foreground/70 font-medium">
                                Server Capabilities (Raw):
                              </div>
                              <div className="relative group/capabilities">
                                <pre className="text-foreground font-mono text-[10px] bg-muted/30 p-2 rounded border border-border/20 overflow-x-auto max-h-48 overflow-y-auto">
                                  {JSON.stringify(serverCapabilities, null, 2)}
                                </pre>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    copyToClipboard(
                                      JSON.stringify(
                                        serverCapabilities,
                                        null,
                                        2,
                                      ),
                                      "capabilities",
                                    );
                                  }}
                                  className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer bg-muted/50 rounded"
                                >
                                  {copiedField === "capabilities" ? (
                                    <Check className="h-3 w-3 text-green-500" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              </div>
                            </div>
                          )}

                          {websiteUrl && (
                            <a
                              href={websiteUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs text-primary hover:underline inline-flex items-center gap-1 cursor-pointer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              Visit documentation
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </TabsContent>

                      <TabsContent value="metadata" className="mt-0">
                        <div className="p-3 bg-muted/20 rounded border border-border/30">
                          {toolsData?.tools && toolsData.toolsMetadata ? (
                            <div className="space-y-3">
                              {toolsData.tools
                                .filter(
                                  (tool: any) =>
                                    toolsData.toolsMetadata?.[tool.name],
                                )
                                .map((tool: any) => {
                                  const metadata =
                                    toolsData.toolsMetadata?.[tool.name];

                                  return (
                                    <div
                                      key={tool.name}
                                      className="bg-muted/30 rounded p-3 space-y-2"
                                    >
                                      <div className="flex items-start justify-between">
                                        <div className="flex-1">
                                          <div className="flex items-center gap-2">
                                            <h4 className="font-medium text-xs">
                                              {tool.name}
                                            </h4>
                                            {metadata.write !== undefined && (
                                              <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded uppercase">
                                                {metadata.write
                                                  ? "WRITE"
                                                  : "READ"}
                                              </span>
                                            )}
                                          </div>
                                          <p className="text-xs text-muted-foreground mt-1">
                                            {tool.description ||
                                              "No description available"}
                                          </p>
                                        </div>
                                      </div>

                                      {/* Metadata Section */}
                                      <div className="mt-2 pt-2 border-t border-border/50">
                                        <div className="text-[10px] text-muted-foreground font-medium mb-2">
                                          METADATA
                                        </div>

                                        {Object.entries(metadata).map(
                                          ([key, value]) => {
                                            if (key === "write") return null;

                                            return (
                                              <div
                                                key={key}
                                                className="space-y-1 mt-2"
                                              >
                                                <div className="text-[10px] text-muted-foreground">
                                                  {key
                                                    .replace(/([A-Z])/g, " $1")
                                                    .trim()}
                                                </div>
                                                <div
                                                  className={`text-[10px] rounded px-2 py-1 ${
                                                    typeof value === "string" &&
                                                    value.includes("://")
                                                      ? "font-mono bg-muted/50"
                                                      : "bg-muted/50"
                                                  }`}
                                                >
                                                  {typeof value === "object"
                                                    ? JSON.stringify(
                                                        value,
                                                        null,
                                                        2,
                                                      )
                                                    : String(value)}
                                                </div>
                                              </div>
                                            );
                                          },
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                            </div>
                          ) : (
                            <div className="text-xs text-muted-foreground text-center py-4">
                              No widget metadata available
                            </div>
                          )}
                        </div>
                      </TabsContent>
                    </Tabs>
                  ) : (
                    <div className="p-3 bg-muted/20 rounded border border-border/30 space-y-3">
                      {serverTitle && (
                        <div className="text-xs">
                          <span className="text-muted-foreground/70">
                            Server Name:
                          </span>{" "}
                          <span className="text-foreground">{serverTitle}</span>
                        </div>
                      )}

                      {protocolVersion && (
                        <div className="text-xs">
                          <span className="text-muted-foreground/70">
                            MCP Protocol:
                          </span>{" "}
                          <span className="text-foreground">
                            {protocolVersion}
                          </span>
                        </div>
                      )}

                      {capabilities.length > 0 && (
                        <div className="text-xs">
                          <span className="text-muted-foreground/70">
                            Capabilities:
                          </span>{" "}
                          <span className="text-foreground">
                            {capabilities.join(", ")}
                          </span>
                        </div>
                      )}

                      {instructions && (
                        <div className="text-xs space-y-1">
                          <div className="text-muted-foreground/70 font-medium">
                            Instructions:
                          </div>
                          <div className="text-foreground whitespace-pre-wrap bg-muted/30 p-2 rounded border border-border/20">
                            {instructions}
                          </div>
                        </div>
                      )}

                      {serverCapabilities && (
                        <div className="text-xs space-y-1">
                          <div className="text-muted-foreground/70 font-medium">
                            Server Capabilities (Raw):
                          </div>
                          <div className="relative group/capabilities">
                            <pre className="text-foreground font-mono text-[10px] bg-muted/30 p-2 rounded border border-border/20 overflow-x-auto max-h-48 overflow-y-auto">
                              {JSON.stringify(serverCapabilities, null, 2)}
                            </pre>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                copyToClipboard(
                                  JSON.stringify(serverCapabilities, null, 2),
                                  "capabilities",
                                );
                              }}
                              className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer bg-muted/50 rounded"
                            >
                              {copiedField === "capabilities" ? (
                                <Check className="h-3 w-3 text-green-500" />
                              ) : (
                                <Copy className="h-3 w-3" />
                              )}
                            </button>
                          </div>
                        </div>
                      )}

                      {websiteUrl && (
                        <a
                          href={websiteUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-primary hover:underline inline-flex items-center gap-1 cursor-pointer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          Visit documentation
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  )}
                </div>
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
    </TooltipProvider>
  );
}
