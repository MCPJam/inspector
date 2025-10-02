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
  X,
  Wifi,
  Edit,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/mcp-export-api";

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
  const isHttpServer = server.config.url !== undefined;
  const serverConfig = server.config;

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

  const getConnectionStatusText = () => {
    switch (server.connectionStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting...";
      case "oauth-flow":
        return "Authorizing...";
      case "failed":
        return `Failed (${server.retryCount} retries)`;
      case "disconnected":
        return "Disconnected";
    }
  };

  const getConnectionStatusIcon = () => {
    switch (server.connectionStatus) {
      case "connected":
        return <Check className="h-3 w-3 text-green-500" />;
      case "connecting":
        return <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />;
      case "oauth-flow":
        return <Loader2 className="h-3 w-3 text-purple-500 animate-spin" />;
      case "failed":
        return <X className="h-3 w-3 text-red-500" />;
      case "disconnected":
        return <Wifi className="h-3 w-3 text-gray-500" />;
    }
  };

  const getCommandDisplay = () => {
    if (isHttpServer) {
      return server.config.url?.toString() || "";
    }
    const command = server.config.command;
    const args = server.config.args || [];
    return [command, ...args].join(" ");
  };

  return (
    <TooltipProvider>
      <Card className="group border border-border/50 bg-gradient-to-br from-card/80 to-card/40 backdrop-blur-sm hover:border-border hover:shadow-lg hover:shadow-primary/5 transition-all duration-300 overflow-hidden">
        <div className="p-6 space-y-4">
          {/* Enhanced Header Row */}
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              {/* Status Indicator with Animation */}
              <div className="relative">
                <div
                  className={`h-3 w-3 rounded-full flex-shrink-0 mt-1 transition-all duration-300 ${
                    server.connectionStatus === "connected"
                      ? "bg-emerald-500 shadow-lg shadow-emerald-500/30"
                      : server.connectionStatus === "connecting"
                        ? "bg-blue-500 shadow-lg shadow-blue-500/30 animate-pulse"
                        : server.connectionStatus === "oauth-flow"
                          ? "bg-purple-500 shadow-lg shadow-purple-500/30 animate-pulse"
                          : server.connectionStatus === "failed"
                            ? "bg-red-500 shadow-lg shadow-red-500/30"
                            : "bg-gray-400"
                  }`}
                />
                {server.connectionStatus === "connected" && (
                  <div className="absolute inset-0 h-3 w-3 rounded-full bg-emerald-500 animate-ping opacity-20" />
                )}
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center gap-3">
                  <h3 className="font-semibold text-base text-foreground truncate">
                    {server.name}
                  </h3>
                  <div className="flex items-center gap-1.5 px-2 py-1 rounded-full bg-muted/50">
                    {getConnectionStatusIcon()}
                    <span className="text-xs font-medium text-muted-foreground">
                      {getConnectionStatusText()}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div
                    className={`px-2 py-1 rounded-md text-xs font-medium ${
                      isHttpServer
                        ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                        : "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                    }`}
                  >
                    {isHttpServer ? "HTTP/SSE" : "STDIO"}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Switch
                checked={server.connectionStatus === "connected"}
                onCheckedChange={(checked) => {
                  if (!checked) {
                    onDisconnect(server.name);
                  } else {
                    handleReconnect();
                  }
                }}
                className="cursor-pointer data-[state=checked]:bg-emerald-500"
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 cursor-pointer transition-all duration-200"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem
                    onClick={handleReconnect}
                    disabled={
                      isReconnecting ||
                      server.connectionStatus === "connecting" ||
                      server.connectionStatus === "oauth-flow"
                    }
                    className="text-sm cursor-pointer"
                  >
                    {isReconnecting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    {isReconnecting ? "Reconnecting..." : "Reconnect"}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => onEdit(server)}
                    className="text-sm cursor-pointer"
                  >
                    <Edit className="h-4 w-4 mr-2" />
                    Edit Configuration
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={handleExport}
                    disabled={
                      isExporting || server.connectionStatus !== "connected"
                    }
                    className="text-sm cursor-pointer"
                  >
                    {isExporting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Download className="h-4 w-4 mr-2" />
                    )}
                    {isExporting ? "Exporting..." : "Export Server Info"}
                  </DropdownMenuItem>
                  <Separator />
                  <DropdownMenuItem
                    className="text-destructive text-sm cursor-pointer"
                    onClick={() =>
                      onRemove
                        ? onRemove(server.name)
                        : onDisconnect(server.name)
                    }
                  >
                    <Link2Off className="h-4 w-4 mr-2" />
                    Remove Server
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Enhanced Command/URL Display */}
          <div className="relative group">
            <div className="font-mono text-sm text-muted-foreground bg-gradient-to-r from-muted/40 to-muted/20 p-3 rounded-lg border border-border/40 break-all transition-all duration-200 group-hover:border-border/60">
              <div className="pr-10 leading-relaxed">{getCommandDisplay()}</div>
              <button
                onClick={() => copyToClipboard(getCommandDisplay(), "command")}
                className="absolute top-2 right-2 p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 rounded transition-all duration-200 cursor-pointer"
              >
                {copiedField === "command" ? (
                  <Check className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>

          {/* Enhanced Error Alert for Failed Connections */}
          {server.connectionStatus === "failed" && server.lastError && (
            <div className="bg-gradient-to-r from-red-50 to-red-50/50 dark:from-red-950/30 dark:to-red-950/20 border border-red-200 dark:border-red-800/30 rounded-lg p-4">
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <X className="h-4 w-4 text-red-500" />
                </div>
                <div className="flex-1 space-y-2">
                  <div className="text-sm font-medium text-red-700 dark:text-red-300">
                    Connection Failed
                  </div>
                  <div className="text-sm text-red-600 dark:text-red-400 break-all leading-relaxed">
                    {isErrorExpanded
                      ? server.lastError
                      : server.lastError.length > 120
                        ? `${server.lastError.substring(0, 120)}...`
                        : server.lastError}
                  </div>
                  {server.lastError.length > 120 && (
                    <button
                      onClick={() => setIsErrorExpanded(!isErrorExpanded)}
                      className="text-red-500/70 hover:text-red-500 text-sm underline cursor-pointer transition-colors duration-200"
                    >
                      {isErrorExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                  {server.retryCount > 0 && (
                    <div className="text-red-500/70 text-sm">
                      {server.retryCount} retry attempt
                      {server.retryCount !== 1 ? "s" : ""}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Enhanced Expand Button */}
          <div className="flex justify-center pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-3 text-muted-foreground hover:text-foreground hover:bg-accent/50 cursor-pointer transition-all duration-200 group"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              <span className="text-xs font-medium mr-2">
                {isExpanded ? "Hide Details" : "Show Details"}
              </span>
              {isExpanded ? (
                <ChevronUp className="h-4 w-4 transition-transform duration-200" />
              ) : (
                <ChevronDown className="h-4 w-4 transition-transform duration-200" />
              )}
            </Button>
          </div>

          {/* Enhanced Expandable Details */}
          {isExpanded && (
            <div className="space-y-4 pt-4 border-t border-border/50">
              <div className="space-y-3">
                <div className="space-y-3">
                  <div>
                    <span className="text-sm font-semibold text-foreground">
                      Server Configuration
                    </span>
                    <div className="mt-2 relative group">
                      <div className="font-mono text-sm text-foreground bg-gradient-to-r from-muted/40 to-muted/20 p-4 rounded-lg border border-border/40 whitespace-pre-wrap break-all transition-all duration-200 group-hover:border-border/60">
                        <div className="pr-10 leading-relaxed">
                          {JSON.stringify(serverConfig, null, 2)}
                        </div>
                        <button
                          onClick={() =>
                            copyToClipboard(
                              JSON.stringify(serverConfig, null, 2),
                              "serverConfig",
                            )
                          }
                          className="absolute top-2 right-2 p-1.5 text-muted-foreground/60 hover:text-foreground hover:bg-accent/50 rounded transition-all duration-200 cursor-pointer"
                        >
                          {copiedField === "serverConfig" ? (
                            <Check className="h-4 w-4 text-emerald-500" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )}
                        </button>
                      </div>
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
