import { useState } from "react";
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
  ChevronDown,
  ChevronUp,
  MoreVertical,
  Link2Off,
  RefreshCw,
  Loader2,
  Copy,
  Download,
  Check,
  Edit,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/mcp-export-api";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerTransportLabel,
} from "./server-card-utils";

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
  const [isExpanded, setIsExpanded] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const serverConfig = server.config;
  const {
    label: connectionStatusLabel,
    Icon: ConnectionStatusIcon,
    iconClassName,
    indicatorColor,
  } = getConnectionStatusMeta(server.connectionStatus);
  const transportLabel = getServerTransportLabel(server.config);
  const commandDisplay = getServerCommandDisplay(server.config);

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
      <Card className="border border-border/50 bg-card/50 backdrop-blur-sm hover:border-border transition-colors">
        <div className="p-4 space-y-3 py-0">
          {/* Header Row */}
          <div className="flex items-baseline justify-between">
            <div className="flex items-baseline gap-3 flex-1">
              <div
                className="h-2 w-2 rounded-full flex-shrink-0 mt-1"
                style={{
                  backgroundColor: indicatorColor,
                }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium text-sm text-foreground">
                    {server.name}
                  </h3>
                  <div className="flex items-center gap-1 leading-none">
                    <ConnectionStatusIcon className={iconClassName} />
                    <p className="text-xs text-muted-foreground leading-none">
                      {server.connectionStatus === "failed"
                        ? `${connectionStatusLabel} (${server.retryCount} retries)`
                        : connectionStatusLabel}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {transportLabel}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 pr-2 text-xs text-muted-foreground leading-none">
                <Switch
                  checked={server.connectionStatus === "connected"}
                  onCheckedChange={(checked) => {
                    if (!checked) {
                      onDisconnect(server.name);
                    } else {
                      handleReconnect();
                    }
                  }}
                  className="cursor-pointer scale-80"
                />
              </div>
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
                    onClick={handleReconnect}
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
                    onClick={handleExport}
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
                    onClick={() =>
                      onRemove
                        ? onRemove(server.name)
                        : onDisconnect(server.name)
                    }
                  >
                    <Link2Off className="h-3 w-3 mr-2" />
                    Remove server
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Command/URL Display */}
          <div className="font-mono text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/30 break-all relative group">
            <div className="pr-8">{commandDisplay}</div>
            <button
              onClick={() => copyToClipboard(commandDisplay, "command")}
              className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
            >
              {copiedField === "command" ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
            </button>
          </div>

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
                  onClick={() => setIsErrorExpanded(!isErrorExpanded)}
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
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground cursor-pointer"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
            </Button>
          </div>
          {/* Expandable Details */}
          {isExpanded && (
            <div className="space-y-3 pt-2">
              {/* Server Configuration */}
              <div className="space-y-2">
                <div className="space-y-3 text-xs">
                  <div>
                    <span className="text-muted-foreground font-medium">
                      Server Configuration:
                    </span>
                    <div className="font-mono text-foreground break-all bg-muted/30 p-2 rounded mt-1 relative group">
                      <div className="pr-8 whitespace-pre-wrap">
                        {JSON.stringify(serverConfig, null, 2)}
                      </div>
                      <button
                        onClick={() =>
                          copyToClipboard(
                            JSON.stringify(serverConfig, null, 2),
                            "serverConfig",
                          )
                        }
                        className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
                      >
                        {copiedField === "serverConfig" ? (
                          <Check className="h-3 w-3 text-green-500" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>
    </TooltipProvider>
  );
}
