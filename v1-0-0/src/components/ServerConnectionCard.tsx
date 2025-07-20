"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Separator } from "./ui/separator";
import { TooltipProvider } from "./ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ChevronDown,
  ChevronUp,
  MoreVertical,
  Link2Off,
  RefreshCw,
  Loader2,
  Copy,
  Check,
  X,
  Wifi,
} from "lucide-react";
import { ServerWithName } from "@/hooks/useAppState";
import { formatTimeRemaining, getTimeBreakdown } from "@/lib/utils";

interface ServerConnectionCardProps {
  server: ServerWithName;
  onDisconnect: (serverName: string) => void;
  onReconnect: (serverName: string) => void;
}

export function ServerConnectionCard({
  server,
  onDisconnect,
  onReconnect,
}: ServerConnectionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [currentTime, setCurrentTime] = useState(Date.now());
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const isHttpServer = "url" in server.config;
  const hasOAuth = server.oauthState || server.oauthFlow;

  // Update current time every second for live countdown
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  // Calculate OAuth token expiration
  const getTokenStatus = () => {
    if (!server.oauthState?.expiresAt) return null;
    const timeLeft = server.oauthState.expiresAt - currentTime;
    const totalTime = 3600000; // Assume 1 hour default
    const percentage = Math.max(0, (timeLeft / totalTime) * 100);

    return {
      percentage,
      timeLeft,
      ...getTimeBreakdown(timeLeft),
    };
  };

  const tokenStatus = getTokenStatus();

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

  const getConnectionStatusText = () => {
    switch (server.connectionStatus) {
      case "connected":
        return "Connected";
      case "connecting":
        return "Connecting...";
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
      <Card className="border border-border/50 bg-card/50 backdrop-blur-sm hover:border-border transition-colors">
        <div className="p-4 space-y-3 py-0">
          {/* Header Row */}
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3 flex-1">
              <div
                className="h-2 w-2 rounded-full flex-shrink-0 mt-1.5"
                style={{
                  backgroundColor:
                    server.connectionStatus === "connected"
                      ? "#10b981"
                      : server.connectionStatus === "connecting"
                        ? "#3b82f6"
                        : server.connectionStatus === "failed"
                          ? "#ef4444"
                          : "#9ca3af",
                }}
              />
              <div className="min-w-0 flex-1">
                <h3 className="font-medium text-sm text-foreground">
                  {server.name}
                </h3>
                <div className="flex justify-between mt-1">
                  <p className="text-xs text-muted-foreground">
                    {isHttpServer ? "HTTP/SSE" : "STDIO"}
                  </p>
                  <div className="flex items-center gap-1 -mr-3">
                    {getConnectionStatusIcon()}
                    <p className="text-xs text-muted-foreground">
                      {getConnectionStatusText()}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
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
                      isReconnecting || server.connectionStatus === "connecting"
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
                  <Separator />
                  <DropdownMenuItem
                    className="text-destructive text-xs cursor-pointer"
                    onClick={() => onDisconnect(server.name)}
                  >
                    <Link2Off className="h-3 w-3 mr-2" />
                    Disconnect
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Command/URL Display */}
          <div className="font-mono text-xs text-muted-foreground bg-muted/30 p-2 rounded border border-border/30 break-all relative group">
            <div className="pr-8">{getCommandDisplay()}</div>
            <button
              onClick={() => copyToClipboard(getCommandDisplay(), "command")}
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
          {(hasOAuth || !isHttpServer) && (
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
          )}
          {/* Expandable Details */}
          {isExpanded && (hasOAuth || !isHttpServer) && (
            <div className="space-y-3 pt-2">
              {/* OAuth Information */}
              {server.oauthState && (
                <div className="space-y-2">
                  <div className="space-y-3 text-xs">
                    <div>
                      <span className="text-muted-foreground font-medium">
                        Bearer Access Token:
                      </span>
                      <div className="font-mono text-foreground break-all bg-muted/30 p-2 rounded mt-1 relative group">
                        <div className="pr-8">
                          {server.oauthState.accessToken}
                        </div>
                        <button
                          onClick={() =>
                            copyToClipboard(
                              server.oauthState?.accessToken || "",
                              "accessToken",
                            )
                          }
                          className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
                        >
                          {copiedField === "accessToken" ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground font-medium">
                        Client ID:
                      </span>
                      <div className="font-mono text-foreground break-all bg-muted/30 p-2 rounded mt-1 relative group">
                        <div className="pr-8">
                          {server.oauthState.clientId || "N/A"}
                        </div>
                        <button
                          onClick={() =>
                            copyToClipboard(
                              server.oauthState?.clientId || "N/A",
                              "clientId",
                            )
                          }
                          className="absolute top-1 right-1 p-1 text-muted-foreground/50 hover:text-foreground transition-colors cursor-pointer"
                        >
                          {copiedField === "clientId" ? (
                            <Check className="h-3 w-3 text-green-500" />
                          ) : (
                            <Copy className="h-3 w-3" />
                          )}
                        </button>
                      </div>
                    </div>
                    {server.oauthState.scopes.length > 0 && (
                      <div>
                        <span className="text-muted-foreground font-medium">
                          Scopes:
                        </span>
                        <div className="font-mono text-foreground break-all bg-muted/30 p-2 rounded mt-1">
                          {server.oauthState.scopes.join(", ")}
                        </div>
                      </div>
                    )}
                  </div>

                  {tokenStatus && (
                    <div>
                      <span className="text-xs text-muted-foreground font-medium">
                        Token Expiry:
                      </span>
                      <div
                        className={`text-xs font-mono mt-1 bg-muted/30 p-2 rounded ${
                          tokenStatus.isExpired
                            ? "text-red-500"
                            : tokenStatus.isExpiringSoon
                              ? "text-yellow-500"
                              : "text-green-500"
                        }`}
                      >
                        {formatTimeRemaining(tokenStatus.timeLeft)}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Command Arguments and Environment */}
              {!isHttpServer && (
                <div className="space-y-3">
                  {server.config.args && server.config.args.length > 0 && (
                    <div>
                      <span className="text-xs text-muted-foreground font-medium">
                        Arguments:
                      </span>
                      <div className="space-y-1 mt-1">
                        {server.config.args.map((arg, index) => (
                          <div
                            key={index}
                            className="text-xs font-mono text-foreground bg-muted/30 p-2 rounded break-all"
                          >
                            {arg}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {server.config.env &&
                    Object.keys(server.config.env).length > 0 && (
                      <div>
                        <span className="text-xs text-muted-foreground font-medium">
                          Environment:
                        </span>
                        <div className="space-y-1 mt-1">
                          {Object.entries(server.config.env).map(
                            ([key, value]) => (
                              <div
                                key={key}
                                className="text-xs font-mono bg-muted/30 p-2 rounded break-all"
                              >
                                <span className="text-blue-600">{key}</span>=
                                <span className="text-green-600">{value}</span>
                              </div>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </TooltipProvider>
  );
}
