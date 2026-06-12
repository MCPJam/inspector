import {
  useState,
  useEffect,
  useCallback,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { toast } from "sonner";
import { Card } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import { Separator } from "@mcpjam/design-system/separator";
import { Switch } from "@mcpjam/design-system/switch";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import {
  MoreVertical,
  Link2Off,
  RefreshCw,
  Power,
  Loader2,
  Copy,
  Download,
  Check,
  Edit,
  ExternalLink,
  Cable,
  Trash2,
  AlertCircle,
  FileText,
  FolderInput,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
import { ErrorCard } from "@/components/ui/error-card";
import {
  getConnectionStatusMeta,
  getServerCommandDisplay,
  getServerUrl,
} from "./server-card-utils";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import type { ServerDetailTab } from "./ServerDetailModal";
import { downloadJsonFile } from "@/lib/json-config-parser";
import { generateAgentBrief } from "@/lib/generate-agent-brief";
import {
  TunnelExplanationModal,
  TUNNEL_EXPLANATION_DISMISSED_KEY,
} from "./TunnelExplanationModal";
import {
  closeServerTunnel,
  createServerTunnel,
  getServerTunnel,
  getTunnelRequests,
  rotateServerTunnel,
  type TunnelRequestLogEntry,
} from "@/lib/apis/mcp-tunnels-api";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "@/lib/config";
import { useExploreCasesPrefetchOnConnect } from "@/hooks/use-explore-cases-prefetch-on-connect";
import { getOAuthTraceFailureStep } from "@/lib/oauth/oauth-trace";

function isHostedInsecureHttpServer(server: ServerWithName): boolean {
  if (!HOSTED_MODE || !("url" in server.config) || !server.config.url) {
    return false;
  }

  try {
    return new URL(server.config.url.toString()).protocol === "http:";
  } catch {
    return false;
  }
}

const SERVER_CARD_CONTEXT_MENU_EXEMPT_SELECTOR =
  "[data-server-card-context-menu-exempt]";

function isContextMenuExemptTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(SERVER_CARD_CONTEXT_MENU_EXEMPT_SELECTOR) != null
  );
}

interface ServerConnectionCardProps {
  server: ServerWithName;
  needsReconnect?: boolean;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: {
      forceOAuthFlow?: boolean;
      allowInteractiveOAuthFlow?: boolean;
    }
  ) => Promise<void>;
  onRemove?: (serverName: string) => void;
  serverTunnelUrl?: string | null;
  hostedServerId?: string;
  onOpenDetailModal?: (
    server: ServerWithName,
    defaultTab: ServerDetailTab
  ) => void;
  /** When set (e.g. active project on Servers tab), prefetches Explore AI test cases on MCP connect. */
  projectId?: string | null;
  /**
   * Projects this server can be moved into via the actions menu. Already
   * excludes the current project. When omitted/empty the "Move to project"
   * item is hidden.
   */
  moveTargets?: Array<{ id: string; name: string; icon?: string }>;
  /** Moves this server into another project (create in target, remove here). */
  onMoveToProject?: (
    serverName: string,
    targetProjectId: string
  ) => void | Promise<void>;
  /** True while a move for this server is in flight. */
  isMovingToProject?: boolean;
}

export function ServerConnectionCard({
  server,
  needsReconnect = false,
  onDisconnect,
  onReconnect,
  onRemove,
  serverTunnelUrl,
  hostedServerId,
  onOpenDetailModal,
  projectId,
  moveTargets,
  onMoveToProject,
  isMovingToProject = false,
}: ServerConnectionCardProps) {
  useExploreCasesPrefetchOnConnect(projectId ?? null, server, hostedServerId);

  const posthog = usePostHog();
  const { getAccessToken } = useAuth();
  const { isAuthenticated } = useConvexAuth();
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isCopyingBrief, setIsCopyingBrief] = useState(false);
  const [isErrorExpanded, setIsErrorExpanded] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [tunnelUrl, setTunnelUrl] = useState<string | null>(
    serverTunnelUrl ?? null
  );
  const [isCreatingTunnel, setIsCreatingTunnel] = useState(false);
  const [isClosingTunnel, setIsClosingTunnel] = useState(false);
  const [isRotatingTunnel, setIsRotatingTunnel] = useState(false);
  const [showTunnelRequests, setShowTunnelRequests] = useState(false);
  const [tunnelRequests, setTunnelRequests] = useState<TunnelRequestLogEntry[]>(
    []
  );
  const [showTunnelExplanation, setShowTunnelExplanation] = useState(false);
  const [isActionsMenuOpen, setIsActionsMenuOpen] = useState(false);

  const {
    label: connectionStatusLabel,
    indicatorColor,
    Icon: ConnectionStatusIcon,
    iconClassName,
  } = getConnectionStatusMeta(server.connectionStatus);
  const commandDisplay = getServerCommandDisplay(server.config);

  const initializationInfo = server.initializationInfo;

  // Extract server info from initializationInfo
  const serverIcon = initializationInfo?.serverVersion?.icons?.[0];
  const version = initializationInfo?.serverVersion?.version;

  const isConnected = server.connectionStatus === "connected";
  const isTunnelEnabled = !HOSTED_MODE;
  const canManageTunnels = isAuthenticated;
  const showTunnelActions = isConnected && isTunnelEnabled;
  const hasTunnel = Boolean(tunnelUrl);
  const hasError =
    server.connectionStatus === "failed" && Boolean(server.lastError);
  const oauthFailureStep = getOAuthTraceFailureStep(server.lastOAuthTrace);
  const isHostedHttpReconnectBlocked = isHostedInsecureHttpServer(server);
  const isPendingConnection =
    server.connectionStatus === "connecting" ||
    server.connectionStatus === "oauth-flow";
  const isReconnectMenuDisabled = isReconnecting || isPendingConnection;
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

  // Poll the recent-requests log while the observability panel is open.
  useEffect(() => {
    if (!showTunnelRequests || !tunnelUrl) {
      return;
    }
    let isCancelled = false;

    const fetchRequests = async () => {
      try {
        const accessToken = await getAccessToken();
        const requests = await getTunnelRequests(server.name, accessToken);
        if (!isCancelled) {
          setTunnelRequests(requests);
        }
      } catch {
        // Panel is best-effort; keep the last snapshot on errors.
      }
    };

    fetchRequests();
    const intervalId = setInterval(fetchRequests, 4000);
    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, [getAccessToken, server.name, showTunnelRequests, tunnelUrl]);

  // Revalidate the displayed URL while a tunnel is shown: the relay can end
  // a tunnel server-side (grant superseded by another inspector, secret
  // rotated elsewhere, expired token), after which the local server 404s for
  // it — stop advertising a URL that no longer works. Skipped when the
  // parent owns the URL via the serverTunnelUrl prop, and while a local
  // create/rotate/close is in flight (mid-rotation the server briefly has
  // no entry; polling then would clear a healthy tunnel).
  useEffect(() => {
    if (
      !tunnelUrl ||
      !showTunnelActions ||
      serverTunnelUrl !== undefined ||
      isCreatingTunnel ||
      isClosingTunnel ||
      isRotatingTunnel
    ) {
      return;
    }
    let isCancelled = false;

    const revalidate = async () => {
      try {
        const accessToken = await getAccessToken();
        const existingTunnel = await getServerTunnel(server.name, accessToken);
        if (!isCancelled && existingTunnel === null) {
          setTunnelUrl(null);
          setShowTunnelRequests(false);
          toast.warning(
            `Tunnel for ${server.name} ended — create it again if you still need it`
          );
        }
      } catch {
        // Transient (network/auth) — keep the last known state; only an
        // explicit "no tunnel" answer clears the URL.
      }
    };

    const intervalId = setInterval(revalidate, 5000);
    return () => {
      isCancelled = true;
      clearInterval(intervalId);
    };
  }, [
    getAccessToken,
    isClosingTunnel,
    isCreatingTunnel,
    isRotatingTunnel,
    server.name,
    serverTunnelUrl,
    showTunnelActions,
    tunnelUrl,
  ]);

  const copyToClipboard = async (text: string, fieldName: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 2000); // Reset after 2 seconds
    } catch (error) {
      console.error("Failed to copy text:", error);
    }
  };

  const handleReconnect = async (options?: {
    forceOAuthFlow?: boolean;
    allowInteractiveOAuthFlow?: boolean;
  }) => {
    setIsReconnecting(true);
    try {
      await onReconnect(server.name, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to reconnect to ${server.name}: ${errorMessage}`);
    } finally {
      setIsReconnecting(false);
    }
  };

  const getSwitchReconnectOptions = () => {
    if (server.useOAuth === true && !server.oauthTokens) {
      return { allowInteractiveOAuthFlow: true };
    }

    return { allowInteractiveOAuthFlow: false };
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

  const handleCopyAgentBrief = async () => {
    setIsCopyingBrief(true);
    try {
      const data = await exportServerApi(server.name);
      const serverUrl = getServerUrl(server.config);
      const markdown = generateAgentBrief(data, { serverUrl });
      await navigator.clipboard.writeText(markdown);
      toast.success("Agent brief copied to clipboard");
      posthog.capture("copy_agent_brief_clicked", {
        location: "server_connection_card",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to copy agent brief: ${errorMessage}`);
    } finally {
      setIsCopyingBrief(false);
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
      const result = await createServerTunnel(server.name, accessToken);
      setTunnelUrl(result.url);
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
      if (errorMessage.includes("No access token available")) {
        toast.error("Sign in to create tunnels");
      } else {
        toast.error(`Tunnel creation failed: ${errorMessage}`);
      }
    } finally {
      setIsCreatingTunnel(false);
    }
  };

  // Rotate and close issue conflicting tunnel-lifecycle calls, so only one may
  // be in flight at a time (the server serializes per-tunnel too; this keeps
  // the UI from firing the conflicting request and showing a stale URL).
  const isTunnelMutationInFlight = isClosingTunnel || isRotatingTunnel;

  const handleCloseTunnel = async () => {
    if (isTunnelMutationInFlight) return;
    setIsClosingTunnel(true);
    try {
      const accessToken = await getAccessToken();
      await closeServerTunnel(server.name, accessToken);
      setTunnelUrl(null);
      setShowTunnelRequests(false);
      setTunnelRequests([]);
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

  const handleRotateTunnel = async () => {
    if (isTunnelMutationInFlight) return;
    setIsRotatingTunnel(true);
    try {
      const accessToken = await getAccessToken();
      const result = await rotateServerTunnel(server.name, accessToken);
      setTunnelUrl(result.url);
      toast.success("Tunnel secret rotated — the old URL no longer works");
      posthog.capture("tunnel_rotated", {
        location: "server_connection_card",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to rotate tunnel";
      toast.error(`Failed to rotate tunnel: ${errorMessage}`);
      // A failed rotation may have already torn down the listener (the old
      // secret dies at close). Re-sync with the server's live state so the
      // card never offers a copyable URL that no longer works.
      try {
        const accessToken = await getAccessToken();
        const liveTunnel = await getServerTunnel(server.name, accessToken);
        setTunnelUrl(liveTunnel?.url ?? null);
      } catch {
        setTunnelUrl(null);
      }
    } finally {
      setIsRotatingTunnel(false);
    }
  };

  const isDetailModalEnabled = onOpenDetailModal != null;

  const openDetailModal = useCallback(
    (tab: ServerDetailTab, source: "card_click" | "kebab_edit") => {
      if (!onOpenDetailModal) {
        return;
      }
      onOpenDetailModal(server, tab);
      posthog.capture("server_detail_modal_opened", {
        source,
        default_tab: tab,
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
      });
    },
    [onOpenDetailModal, posthog, server]
  );

  const handleCardContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (isContextMenuExemptTarget(event.target)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setIsActionsMenuOpen(true);
    },
    []
  );

  const handleCardClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!isDetailModalEnabled) {
        return;
      }

      const shouldSuppressCardClick = event.ctrlKey || isActionsMenuOpen;
      if (shouldSuppressCardClick) {
        return;
      }

      posthog.capture("server_card_clicked", {
        location: "server_connection_card",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
      });
      openDetailModal("configuration", "card_click");
    },
    [
      isActionsMenuOpen,
      isDetailModalEnabled,
      server.name,
      posthog,
      openDetailModal,
    ]
  );

  return (
    <>
      <Card
        className={`group h-full rounded-xl border border-border/50 bg-card/60 p-0 shadow-sm transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none ${
          isDetailModalEnabled
            ? "cursor-pointer hover:border-border hover:shadow-md hover:border-primary/40"
            : ""
        }`}
        onContextMenu={handleCardContextMenu}
        onClick={isDetailModalEnabled ? handleCardClick : undefined}
      >
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

              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {hasError && (
                  <button
                    data-server-card-context-menu-exempt
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsErrorExpanded(true);
                    }}
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
                  {isPendingConnection ? (
                    <ConnectionStatusIcon className={iconClassName} />
                  ) : (
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ backgroundColor: indicatorColor }}
                    />
                  )}
                  <span>
                    {server.connectionStatus === "failed"
                      ? `${connectionStatusLabel} (${server.retryCount})`
                      : connectionStatusLabel}
                  </span>
                  {needsReconnect ? (
                    <Tooltip>
                      <TooltipTrigger
                        type="button"
                        aria-label="Connection settings changed"
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-amber-600 outline-none transition-colors hover:text-amber-700 focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 focus-visible:ring-offset-background dark:text-amber-300 dark:hover:text-amber-200"
                      >
                        <Power className="h-3 w-3" />
                      </TooltipTrigger>
                      <TooltipContent
                        side="top"
                        sideOffset={4}
                        variant="muted"
                        className="max-w-48 px-2.5 text-left [text-wrap:normal]"
                      >
                        Turn the connection off and on to apply the new
                        connection settings.
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </span>

                <Switch
                  data-server-card-context-menu-exempt
                  checked={server.connectionStatus === "connected"}
                  onCheckedChange={(checked) => {
                    posthog.capture("connection_switch_toggled", {
                      location: "server_connection_card",
                      platform: detectPlatform(),
                      environment: detectEnvironment(),
                    });
                    if (checked && isHostedHttpReconnectBlocked) {
                      toast.error(
                        "HTTP servers are not supported in hosted mode"
                      );
                      return;
                    }
                    if (!checked) {
                      onDisconnect(server.name);
                    } else {
                      void handleReconnect(getSwitchReconnectOptions());
                    }
                  }}
                  className="cursor-pointer scale-75"
                />

                <DropdownMenu
                  open={isActionsMenuOpen}
                  onOpenChange={setIsActionsMenuOpen}
                >
                  <DropdownMenuTrigger asChild>
                    <Button
                      aria-label={`Open actions menu for ${server.name}`}
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
                        if (isHostedHttpReconnectBlocked) {
                          toast.error(
                            "HTTP servers are not supported in hosted mode"
                          );
                          return;
                        }
                        posthog.capture("reconnect_server_clicked", {
                          location: "server_connection_card",
                          platform: detectPlatform(),
                          environment: detectEnvironment(),
                        });
                        const shouldForceOAuth =
                          server.useOAuth === true ||
                          server.oauthTokens != null;
                        void handleReconnect(
                          shouldForceOAuth
                            ? { forceOAuthFlow: true }
                            : undefined
                        );
                      }}
                      disabled={isReconnectMenuDisabled}
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
                        openDetailModal("configuration", "kebab_edit");
                      }}
                      className="text-xs cursor-pointer"
                    >
                      <Edit className="h-3 w-3 mr-2" />
                      Configure
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
                    <DropdownMenuItem
                      onClick={() => {
                        handleCopyAgentBrief();
                      }}
                      disabled={
                        isCopyingBrief ||
                        server.connectionStatus !== "connected"
                      }
                      className="text-xs cursor-pointer"
                    >
                      {isCopyingBrief ? (
                        <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                      ) : (
                        <FileText className="h-3 w-3 mr-2" />
                      )}
                      {isCopyingBrief
                        ? "Copying..."
                        : "Copy markdown for evals"}
                    </DropdownMenuItem>
                    {onMoveToProject &&
                    moveTargets &&
                    moveTargets.length > 0 ? (
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger
                          disabled={isMovingToProject}
                          className="gap-2 text-xs cursor-pointer [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground"
                        >
                          {isMovingToProject ? (
                            <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                          ) : (
                            <FolderInput className="h-3 w-3 mr-2" />
                          )}
                          {isMovingToProject ? "Moving..." : "Move to project"}
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent
                          sideOffset={4}
                          className="max-h-64 w-52 overflow-y-auto"
                        >
                          {moveTargets.map((target) => (
                            <DropdownMenuItem
                              key={target.id}
                              className="text-xs cursor-pointer"
                              onClick={() => {
                                posthog.capture(
                                  "move_server_to_project_clicked",
                                  {
                                    location: "server_connection_card",
                                    platform: detectPlatform(),
                                    environment: detectEnvironment(),
                                  }
                                );
                                void onMoveToProject(server.name, target.id);
                              }}
                            >
                              <span className="flex size-4 shrink-0 items-center justify-center rounded bg-primary/10 text-[9px] font-semibold text-primary">
                                {target.name.charAt(0).toUpperCase()}
                              </span>
                              <span className="truncate">{target.name}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    ) : null}
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

          <div className="relative mt-2 rounded-md border border-border/50 bg-muted/30 p-2 pr-8 font-mono text-xs text-muted-foreground">
            <div className="break-all">{commandDisplay}</div>
            <button
              aria-label="Copy server command"
              data-server-card-context-menu-exempt
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

          {server.connectionStatus === "oauth-flow" && (
            <div
              className="mt-3 rounded-md border border-purple-300/40 bg-purple-500/10 p-2 text-xs text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              Complete sign-in in the browser. Inspector will resume
              automatically.
            </div>
          )}

          <div className="mt-3 flex items-center justify-end">
            <div
              className="flex flex-wrap items-center justify-end gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              {showTunnelActions && (
                <>
                  {hasTunnel ? (
                    <div className="inline-flex items-center overflow-hidden rounded-full border border-border/70 bg-muted/30 text-foreground">
                      <button
                        data-server-card-context-menu-exempt
                        onClick={() => copyToClipboard(tunnelUrl!, "tunnel")}
                        // Rotation revokes the displayed URL at the edge
                        // before the new one arrives (close kills it too), so
                        // mid-mutation the URL must not be copyable.
                        disabled={isTunnelMutationInFlight}
                        className="inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                      >
                        {copiedField === "tunnel" ? (
                          <>
                            <Check className="h-3 w-3" />
                            <span>Copied</span>
                          </>
                        ) : (
                          <>
                            <Cable className="h-3 w-3" />
                            <span>Copy tunnel URL</span>
                          </>
                        )}
                      </button>
                      <span className="h-4 w-px bg-border/80" />
                      <button
                        data-server-card-context-menu-exempt
                        onClick={() => setShowTunnelRequests((open) => !open)}
                        className="inline-flex items-center justify-center px-1.5 py-0.5 transition-colors hover:bg-accent/60 cursor-pointer"
                        aria-label="Recent tunnel requests"
                        title="Recent tunnel requests"
                      >
                        <FileText className="h-3 w-3" />
                      </button>
                      <span className="h-4 w-px bg-border/80" />
                      <button
                        data-server-card-context-menu-exempt
                        onClick={handleRotateTunnel}
                        disabled={isTunnelMutationInFlight}
                        className="inline-flex items-center justify-center px-1.5 py-0.5 transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                        aria-label="Rotate tunnel secret (revokes the current URL)"
                        title="Rotate tunnel secret (revokes the current URL)"
                      >
                        {isRotatingTunnel ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3" />
                        )}
                      </button>
                      <span className="h-4 w-px bg-border/80" />
                      <button
                        data-server-card-context-menu-exempt
                        onClick={handleCloseTunnel}
                        disabled={isTunnelMutationInFlight}
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
                      data-server-card-context-menu-exempt
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
                          ? "Create tunnel"
                          : "Sign in for tunnel"}
                      </span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {showTunnelActions && hasTunnel && showTunnelRequests && (
            <div
              className="mt-2 rounded-md border border-border/70 bg-muted/20 p-2"
              onClick={(e) => e.stopPropagation()}
              data-server-card-context-menu-exempt
            >
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                Recent tunnel requests
              </div>
              {tunnelRequests.length === 0 ? (
                <div className="text-[11px] text-muted-foreground">
                  No requests through the tunnel yet.
                </div>
              ) : (
                <div className="max-h-40 overflow-y-auto">
                  {tunnelRequests.slice(0, 20).map((entry, index) => (
                    <div
                      key={`${entry.ts}-${index}`}
                      className="flex items-center gap-2 py-0.5 font-mono text-[11px] text-muted-foreground"
                    >
                      <span className="shrink-0 tabular-nums">
                        {new Date(entry.ts).toLocaleTimeString()}
                      </span>
                      <span className="shrink-0 font-medium text-foreground">
                        {entry.method}
                      </span>
                      <span className="truncate">{entry.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hasError && (
            <div className="mt-3" onClick={(e) => e.stopPropagation()}>
              {oauthFailureStep ? (
                <div className="mb-1 text-xs font-medium text-red-700 dark:text-red-300">
                  OAuth failed during {oauthFailureStep.title}
                </div>
              ) : null}
              <ErrorCard
                // Prefer the rich block; fall back to the message string
                // (the card calls `describeError` internally when needed).
                error={server.lastNormalizedError ?? server.lastError ?? ""}
                // Controlled — the Error badge above toggles
                // `isErrorExpanded`; the card must reflect that on every
                // change, not just at mount.
                open={isErrorExpanded}
                onOpenChange={setIsErrorExpanded}
              />
              {server.retryCount > 0 && (
                <div className="mt-1 text-xs text-muted-foreground">
                  {server.retryCount} retry attempt
                  {server.retryCount !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}

          {server.connectionStatus === "failed" && (
            <div
              className="mt-2 text-xs text-muted-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              Having trouble?{" "}
              <a
                data-server-card-context-menu-exempt
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
      <TunnelExplanationModal
        isOpen={showTunnelExplanation}
        onClose={() => setShowTunnelExplanation(false)}
        onConfirm={handleConfirmCreateTunnel}
        isCreating={isCreatingTunnel}
      />
    </>
  );
}
