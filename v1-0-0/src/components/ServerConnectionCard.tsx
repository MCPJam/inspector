"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardFooter,
} from "./ui/card";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
import { Separator } from "./ui/separator";
import { Progress } from "./ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./ui/tooltip";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";
import { Alert, AlertDescription } from "./ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Terminal,
  Shield,
  Clock,
  Settings,
  MoreVertical,
  CheckCircle,
  AlertCircle,
  Wifi,
  Zap,
  Key,
  Link2Off,
  RefreshCw,
  Eye,
  Copy,
} from "lucide-react";
import { ServerWithName } from "@/hooks/useAppState";

interface ServerConnectionCardProps {
  server: ServerWithName;
  onDisconnect: (serverName: string) => void;
}

export function ServerConnectionCard({
  server,
  onDisconnect,
}: ServerConnectionCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isHttpServer = "url" in server.config;
  const isStdioServer = "command" in server.config;
  const hasOAuth = server.oauthState || server.oauthFlow;

  // Calculate OAuth token expiration
  const getTokenStatus = () => {
    if (!server.oauthState?.expiresAt) return null;
    const now = Date.now();
    const expiresAt = server.oauthState.expiresAt;
    const timeLeft = expiresAt - now;
    const totalTime = 3600000; // Assume 1 hour default
    const percentage = Math.max(0, (timeLeft / totalTime) * 100);

    return {
      percentage,
      timeLeft,
      isExpired: timeLeft <= 0,
      isExpiringSoon: timeLeft <= 300000, // 5 minutes
    };
  };

  const tokenStatus = getTokenStatus();

  const getConnectionStatus = () => {
    // Mock connection status - in real implementation, you'd check actual connection
    return {
      isConnected: true,
      lastConnected: new Date(),
      latency: Math.floor(Math.random() * 100) + 10,
    };
  };

  const connectionStatus = getConnectionStatus();

  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMinutes = Math.floor(diffMs / 60000);

    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <TooltipProvider>
      <Card className="w-full hover:shadow-md transition-shadow">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                {isHttpServer ? (
                  <Globe className="h-5 w-5 text-primary" />
                ) : (
                  <Terminal className="h-5 w-5 text-primary" />
                )}
              </div>
              <div>
                <CardTitle className="text-lg">{server.name}</CardTitle>
                <div className="flex items-center gap-2 mt-1">
                  <Badge
                    variant={
                      connectionStatus.isConnected ? "default" : "secondary"
                    }
                  >
                    {connectionStatus.isConnected ? (
                      <>
                        <CheckCircle className="h-3 w-3 mr-1" />
                        Connected
                      </>
                    ) : (
                      <>
                        <AlertCircle className="h-3 w-3 mr-1" />
                        Disconnected
                      </>
                    )}
                  </Badge>
                  <Badge variant="outline">
                    {isHttpServer ? "HTTP" : "STDIO"}
                  </Badge>
                  {hasOAuth && (
                    <Badge variant="outline">
                      <Shield className="h-3 w-3 mr-1" />
                      OAuth
                    </Badge>
                  )}
                </div>
              </div>
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="sm">
                  <MoreVertical className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reconnect
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Eye className="h-4 w-4 mr-2" />
                  View Logs
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Settings className="h-4 w-4 mr-2" />
                  Configure
                </DropdownMenuItem>
                <Separator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => onDisconnect(server.name)}
                >
                  <Link2Off className="h-4 w-4 mr-2" />
                  Disconnect
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {/* Connection Stats */}
          <div className="grid grid-cols-3 gap-4">
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <Wifi className="h-4 w-4 text-green-500" />
                <span className="text-sm font-medium">
                  {connectionStatus.latency}ms
                </span>
              </div>
              <p className="text-xs text-muted-foreground">Latency</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <Clock className="h-4 w-4 text-blue-500" />
                <span className="text-sm font-medium">
                  {formatTimeAgo(connectionStatus.lastConnected)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">Last Connected</p>
            </div>
            <div className="text-center">
              <div className="flex items-center justify-center gap-1">
                <Zap className="h-4 w-4 text-orange-500" />
                <span className="text-sm font-medium">
                  {Math.floor(Math.random() * 20) + 5}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">Tools</p>
            </div>
          </div>

          {/* OAuth Token Status */}
          {hasOAuth && tokenStatus && (
            <Alert
              className={
                tokenStatus.isExpired
                  ? "border-destructive"
                  : tokenStatus.isExpiringSoon
                    ? "border-yellow-500"
                    : "border-green-500"
              }
            >
              <Shield className="h-4 w-4" />
              <AlertDescription>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">OAuth Token</span>
                    <span className="text-xs text-muted-foreground">
                      {tokenStatus.isExpired
                        ? "Expired"
                        : `${Math.floor(tokenStatus.timeLeft / 60000)}m left`}
                    </span>
                  </div>
                  <Progress value={tokenStatus.percentage} className="h-2" />
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Configuration Details */}
          <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                className="w-full justify-between p-0 h-auto"
              >
                <span className="text-sm font-medium">
                  Configuration Details
                </span>
                {isExpanded ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-3 pt-3">
              {isHttpServer && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium flex items-center gap-2">
                      <Globe className="h-4 w-4" />
                      URL
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            copyToClipboard(server.config.url?.toString() || "")
                          }
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Copy URL</TooltipContent>
                    </Tooltip>
                  </div>
                  <p className="text-sm text-muted-foreground font-mono bg-muted p-2 rounded">
                    {server.config.url?.toString()}
                  </p>
                </div>
              )}

              {isStdioServer && (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <span className="text-sm font-medium flex items-center gap-2">
                      <Terminal className="h-4 w-4" />
                      Command
                    </span>
                    <p className="text-sm text-muted-foreground font-mono bg-muted p-2 rounded">
                      {server.config.command}
                    </p>
                  </div>

                  {server.config.args && server.config.args.length > 0 && (
                    <div className="space-y-2">
                      <span className="text-sm font-medium">Arguments</span>
                      <div className="space-y-1">
                        {server.config.args.map((arg, index) => (
                          <p
                            key={index}
                            className="text-sm text-muted-foreground font-mono bg-muted p-1 px-2 rounded"
                          >
                            {arg}
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  {server.config.env &&
                    Object.keys(server.config.env).length > 0 && (
                      <div className="space-y-2">
                        <span className="text-sm font-medium">
                          Environment Variables
                        </span>
                        <div className="space-y-1">
                          {Object.entries(server.config.env).map(
                            ([key, value]) => (
                              <div
                                key={key}
                                className="text-sm font-mono bg-muted p-2 rounded"
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

              {server.oauthState && (
                <div className="space-y-2">
                  <span className="text-sm font-medium flex items-center gap-2">
                    <Key className="h-4 w-4" />
                    OAuth Configuration
                  </span>
                  <div className="space-y-2 text-sm text-muted-foreground">
                    <div className="flex justify-between">
                      <span>Client ID:</span>
                      <span className="font-mono">
                        {server.oauthState.clientId || "N/A"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Scopes:</span>
                      <span className="font-mono">
                        {server.oauthState.scopes.join(", ")}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Status:</span>
                      <Badge
                        variant={
                          server.oauthState.accessToken
                            ? "default"
                            : "secondary"
                        }
                      >
                        {server.oauthState.accessToken
                          ? "Authenticated"
                          : "Not Authenticated"}
                      </Badge>
                    </div>
                  </div>
                </div>
              )}
            </CollapsibleContent>
          </Collapsible>
        </CardContent>

        <CardFooter className="pt-0">
          <div className="flex items-center justify-between w-full text-xs text-muted-foreground">
            <span>Connection stable</span>
            <span>ID: {server.name.slice(0, 8)}...</span>
          </div>
        </CardFooter>
      </Card>
    </TooltipProvider>
  );
}
