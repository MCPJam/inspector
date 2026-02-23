import { useState, useEffect } from "react";
import { toast } from "sonner";
import type { MCPClientManager } from "@mcpjam/sdk/browser";
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
  AlertCircle,
} from "lucide-react";
import type { ServerWithName } from "@/types/server-types";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
import type { ListToolsResultWithMetadata } from "@/lib/apis/mcp-tools-api";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
} from "./server-card-utils";
import { ServerInfoModal } from "./ServerInfoModal";
import { downloadJsonFile } from "@/lib/json-config-parser";

interface ServerConnectionCardProps {
  server: ServerWithName;
  manager: MCPClientManager | null;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean },
  ) => void;
  onEdit: (server: ServerWithName) => void;
  onRemove?: (serverName: string) => void;
}

export function ServerConnectionCard({
  server,
  manager,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
}: ServerConnectionCardProps) {
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);

  const { label: connectionStatusLabel, indicatorColor } =
    getConnectionStatusMeta(server.connectionStatus);
  const commandDisplay = getServerCommandDisplay(server.config);

  const initializationInfo = server.initializationInfo;
  const serverIcon = initializationInfo?.serverVersion?.icons?.[0];
  const version = initializationInfo?.serverVersion?.version;
  const serverTitle = initializationInfo?.serverVersion?.title;
  const websiteUrl = initializationInfo?.serverVersion?.websiteUrl;
  const protocolVersion = initializationInfo?.protocolVersion;
  const instructions = initializationInfo?.instructions;
  const serverCapabilities = initializationInfo?.serverCapabilities;

  const capabilities: string[] = [];
  if (serverCapabilities && typeof serverCapabilities === "object") {
    const caps = serverCapabilities as Record<string, unknown>;
    if (caps.tools) capabilities.push("Tools");
    if (caps.prompts) capabilities.push("Prompts");
    if (caps.resources) capabilities.push("Resources");
  }

  const hasInitInfo =
    initializationInfo &&
    (capabilities.length > 0 ||
      protocolVersion ||
      websiteUrl ||
      instructions ||
      serverCapabilities ||
      serverTitle);

  const hasError =
    server.connectionStatus === "failed" && Boolean(server.lastError);

  useEffect(() => {
    const loadTools = async () => {
      if (!manager || server.connectionStatus !== "connected") {
        setToolsData(null);
        return;
      }
      try {
        const result = await manager.listTools(server.id);
        const toolsMetadata = manager.getAllToolsMetadata(server.id);
        setToolsData({ ...result, toolsMetadata });
      } catch (err) {
        console.error("Failed to load tools metadata:", err);
        setToolsData(null);
      }
    };

    void loadTools();
  }, [manager, server.id, server.connectionStatus]);

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  };

  const handleReconnect = async (options?: { forceOAuthFlow?: boolean }) => {
    setIsReconnecting(true);
    try {
      onReconnect(server.id, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to reconnect to ${server.name}: ${errorMessage}`);
    } finally {
      setIsReconnecting(false);
    }
  };

  const handleExport = async () => {
    if (!manager) {
      toast.error("MCP manager unavailable");
      return;
    }

    setIsExporting(true);
    try {
      const toastId = toast.loading(`Exporting ${server.name}...`);
      const data = await exportServerApi(manager, server.id);
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

  return (
    <>
      <Card className="group h-full rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm transition-all duration-200 hover:border-border hover:shadow-md">
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
                  <span className="text-xs text-muted-foreground">v{version}</span>
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
                    if (!checked) {
                      onDisconnect(server.id);
                    } else {
                      void handleReconnect();
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
                        const shouldForceOAuth =
                          server.useOAuth === true || server.oauthTokens != null;
                      void handleReconnect(
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
                      onClick={() => onEdit(server)}
                      className="text-xs cursor-pointer"
                    >
                      <Edit className="h-3 w-3 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleExport()}
                      disabled={isExporting || server.connectionStatus !== "connected"}
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
                        onDisconnect(server.id);
                        onRemove?.(server.id);
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
                void copyToClipboard(commandDisplay, "command");
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
    </>
  );
}
