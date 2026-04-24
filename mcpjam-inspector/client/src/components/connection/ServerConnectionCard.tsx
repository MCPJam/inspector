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
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
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
  Share2,
  FileText,
  Smartphone,
} from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { exportServerApi } from "@/lib/apis/mcp-export-api";
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
  cleanupOrphanedTunnels,
  closeServerTunnel,
  createServerTunnel,
  getServerTunnel,
} from "@/lib/apis/mcp-tunnels-api";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvex, useConvexAuth } from "convex/react";
import { HOSTED_MODE } from "@/lib/config";
import { ShareServerDialog } from "./ShareServerDialog";
import { useExploreCasesPrefetchOnConnect } from "@/hooks/use-explore-cases-prefetch-on-connect";
import { getOAuthTraceFailureStep } from "@/lib/oauth/oauth-trace";
import { useServerMutations, type RemoteServer } from "@/hooks/useWorkspaces";
import { useServerShareMutations } from "@/hooks/useServerShares";
import { PhoneTestDialog } from "./PhoneTestDialog";

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

// Temporary hide while chatbox sharing replaces server sharing in the main UI.
const SERVER_SHARE_UI_ENABLED = false;
const SERVER_CARD_CONTEXT_MENU_EXEMPT_SELECTOR =
  "[data-server-card-context-menu-exempt]";

function isContextMenuExemptTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(SERVER_CARD_CONTEXT_MENU_EXEMPT_SELECTOR) != null
  );
}

interface HostedServerMutationPayload {
  name: string;
  enabled: boolean;
  transportType: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
}

function buildHostedServerPayload(
  serverEntry: ServerWithName
): HostedServerMutationPayload {
  const config = serverEntry.config as any;
  const transportType = config?.command ? "stdio" : "http";
  const url =
    config?.url instanceof URL ? config.url.href : config?.url || undefined;
  const headers = config?.requestInit?.headers || undefined;
  const oauthScopes = serverEntry.oauthFlowProfile?.scopes
    ? serverEntry.oauthFlowProfile.scopes
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean)
    : undefined;

  return {
    name: serverEntry.name,
    enabled: serverEntry.enabled ?? false,
    transportType,
    command: config?.command,
    args: config?.args,
    url,
    headers,
    timeout: config?.timeout,
    useOAuth: serverEntry.useOAuth ?? false,
    oauthScopes,
    clientId: serverEntry.oauthFlowProfile?.clientId,
  };
}

function buildTunnelHostedServerPayload(
  serverEntry: ServerWithName,
  tunnelUrl: string
): HostedServerMutationPayload {
  return {
    name: serverEntry.name,
    enabled: true,
    transportType: "http",
    url: tunnelUrl,
    headers: {},
    timeout: (serverEntry.config as any)?.timeout,
    useOAuth: false,
    oauthScopes: [],
  };
}

interface ServerConnectionCardProps {
  server: ServerWithName;
  needsReconnect?: boolean;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean }
  ) => Promise<void>;
  onRemove?: (serverName: string) => void;
  serverTunnelUrl?: string | null;
  hostedServerId?: string;
  onOpenDetailModal?: (
    server: ServerWithName,
    defaultTab: ServerDetailTab
  ) => void;
  /** When set (e.g. active workspace on Servers tab), prefetches Explore AI test cases on MCP connect. */
  workspaceId?: string | null;
  sharedWorkspaceId?: string | null;
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
  workspaceId,
  sharedWorkspaceId,
}: ServerConnectionCardProps) {
  useExploreCasesPrefetchOnConnect(workspaceId ?? null, server, hostedServerId);

  const posthog = usePostHog();
  const { getAccessToken } = useAuth();
  const convex = useConvex();
  const { isAuthenticated } = useConvexAuth();
  const { createServer: convexCreateServer, updateServer: convexUpdateServer } =
    useServerMutations();
  const { ensureServerShare, setServerShareMode, rotateServerShareLink } =
    useServerShareMutations();
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
  const [showTunnelExplanation, setShowTunnelExplanation] = useState(false);
  const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);
  const [isPhoneTestDialogOpen, setIsPhoneTestDialogOpen] = useState(false);
  const [isPreparingPhoneTest, setIsPreparingPhoneTest] = useState(false);
  const [phoneTestStatusMessage, setPhoneTestStatusMessage] = useState(
    "Preparing a phone test link..."
  );
  const [phoneTestShareUrl, setPhoneTestShareUrl] = useState<string | null>(
    null
  );
  const [phoneTestErrorMessage, setPhoneTestErrorMessage] = useState<
    string | null
  >(null);
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
  const canGeneratePhoneTest = canManageTunnels && !!sharedWorkspaceId;
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
  const isStdioServer = "command" in server.config;
  const isInsecureHttpServer =
    "url" in server.config &&
    !!server.config.url &&
    (() => {
      try {
        return new URL(server.config.url.toString()).protocol === "http:";
      } catch {
        return false;
      }
    })();
  const canShareServer =
    SERVER_SHARE_UI_ENABLED &&
    HOSTED_MODE &&
    !!hostedServerId &&
    isAuthenticated &&
    !isStdioServer &&
    !isInsecureHttpServer;

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

  const loadHostedWorkspaceServerByName = useCallback(async () => {
    if (!isAuthenticated || !sharedWorkspaceId) {
      return null;
    }

    const sharedServers = (await convex.query(
      "servers:getWorkspaceServers" as any,
      { workspaceId: sharedWorkspaceId } as any
    )) as RemoteServer[] | undefined;

    return (
      sharedServers?.find(
        (sharedServer) => sharedServer.name === server.name
      ) ?? null
    );
  }, [convex, isAuthenticated, server.name, sharedWorkspaceId]);

  const upsertHostedServerRecord = useCallback(
    async (payload: HostedServerMutationPayload) => {
      if (!isAuthenticated || !sharedWorkspaceId) {
        throw new Error(
          "Sign in to a synced workspace before generating a phone test link."
        );
      }

      const existingServerId = hostedServerId ?? undefined;

      try {
        if (existingServerId) {
          await convexUpdateServer({
            serverId: existingServerId,
            ...payload,
          } as any);
          return existingServerId;
        }

        const newId = await convexCreateServer({
          workspaceId: sharedWorkspaceId,
          ...payload,
        } as any);
        return newId as string;
      } catch (primaryError) {
        try {
          if (existingServerId) {
            try {
              const newId = await convexCreateServer({
                workspaceId: sharedWorkspaceId,
                ...payload,
              } as any);
              return newId as string;
            } catch {
              const retryExisting = await loadHostedWorkspaceServerByName();
              if (retryExisting) {
                await convexUpdateServer({
                  serverId: retryExisting._id,
                  ...payload,
                } as any);
                return retryExisting._id;
              }
            }
          }

          const retryExisting = await loadHostedWorkspaceServerByName();
          if (retryExisting) {
            await convexUpdateServer({
              serverId: retryExisting._id,
              ...payload,
            } as any);
            return retryExisting._id;
          }
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : "Unknown error";
          throw new Error(fallbackMessage);
        }

        const primaryMessage =
          primaryError instanceof Error
            ? primaryError.message
            : "Unknown error";
        throw new Error(primaryMessage);
      }
    },
    [
      convexCreateServer,
      convexUpdateServer,
      hostedServerId,
      loadHostedWorkspaceServerByName,
      sharedWorkspaceId,
      isAuthenticated,
    ]
  );

  const createServerTunnelWithCleanup = useCallback(async () => {
    const accessToken = await getAccessToken();
    await cleanupOrphanedTunnels(accessToken);

    const result = await createServerTunnel(server.name, accessToken);
    setTunnelUrl(result.url);

    await cleanupOrphanedTunnels(accessToken);
    return result.url;
  }, [getAccessToken, server.name]);

  const restoreHostedServerAfterTunnelClose = useCallback(async () => {
    if (!isAuthenticated || !sharedWorkspaceId) {
      return;
    }

    const existingServerId =
      hostedServerId ?? (await loadHostedWorkspaceServerByName())?._id;
    if (!existingServerId) {
      return;
    }

    await convexUpdateServer({
      serverId: existingServerId,
      ...buildHostedServerPayload(server),
    } as any);
  }, [
    convexUpdateServer,
    hostedServerId,
    loadHostedWorkspaceServerByName,
    server,
    sharedWorkspaceId,
    isAuthenticated,
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

  const handleReconnect = async (options?: { forceOAuthFlow?: boolean }) => {
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
      await createServerTunnelWithCleanup();
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
      setPhoneTestShareUrl(null);
      setPhoneTestErrorMessage(null);
      posthog.capture("tunnel_closed", {
        location: "server_connection_card",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        server_id: server.name,
      });

      try {
        await restoreHostedServerAfterTunnelClose();
        toast.success("Tunnel closed successfully");
      } catch (restoreError) {
        const restoreMessage =
          restoreError instanceof Error
            ? restoreError.message
            : "Failed to restore hosted server config";
        toast.error(
          `Tunnel closed, but failed to restore hosted server config: ${restoreMessage}`
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Failed to close tunnel";
      toast.error(`Failed to close tunnel: ${errorMessage}`);
    } finally {
      setIsClosingTunnel(false);
    }
  };

  const preparePhoneTestLink = useCallback(async () => {
    if (!canGeneratePhoneTest) {
      setPhoneTestErrorMessage(
        "Sign in to a synced workspace before generating a phone test link."
      );
      return;
    }

    setIsPreparingPhoneTest(true);
    setPhoneTestErrorMessage(null);
    setPhoneTestShareUrl(null);

    try {
      setPhoneTestStatusMessage(
        tunnelUrl
          ? "Reusing the active tunnel..."
          : "Creating a fresh tunnel for this server..."
      );
      const effectiveTunnelUrl =
        tunnelUrl ?? (await createServerTunnelWithCleanup());

      setPhoneTestStatusMessage("Pointing the hosted server at the tunnel...");
      const targetHostedServerId = await upsertHostedServerRecord(
        buildTunnelHostedServerPayload(server, effectiveTunnelUrl)
      );

      setPhoneTestStatusMessage("Rotating a fresh mobile test link...");
      const ensuredShare = (await ensureServerShare({
        serverId: targetHostedServerId,
      } as any)) as { mode?: string } | null;

      if (ensuredShare?.mode !== "any_signed_in_with_link") {
        await setServerShareMode({
          serverId: targetHostedServerId,
          mode: "any_signed_in_with_link",
        } as any);
      }

      const rotatedShare = (await rotateServerShareLink({
        serverId: targetHostedServerId,
      } as any)) as { link?: { url?: string | null } } | null;

      const nextShareUrl = rotatedShare?.link?.url?.trim();
      if (!nextShareUrl) {
        throw new Error(
          "The hosted share service did not return a valid link."
        );
      }

      setPhoneTestShareUrl(nextShareUrl);
      toast.success("Phone test link ready");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to generate a phone test link";
      setPhoneTestErrorMessage(errorMessage);
      toast.error(`Phone test link failed: ${errorMessage}`);
    } finally {
      setIsPreparingPhoneTest(false);
      setPhoneTestStatusMessage("Preparing a phone test link...");
    }
  }, [
    canGeneratePhoneTest,
    createServerTunnelWithCleanup,
    ensureServerShare,
    rotateServerShareLink,
    server,
    setServerShareMode,
    tunnelUrl,
    upsertHostedServerRecord,
  ]);

  const handleOpenPhoneTestDialog = () => {
    setIsPhoneTestDialogOpen(true);
    void preparePhoneTestLink();
  };

  const handlePhoneTestDialogOpenChange = (open: boolean) => {
    setIsPhoneTestDialogOpen(open);
    if (!open) {
      setPhoneTestErrorMessage(null);
      setPhoneTestShareUrl(null);
      setPhoneTestStatusMessage("Preparing a phone test link...");
    }
  };

  const handleOpenPhoneTestLink = () => {
    if (!phoneTestShareUrl) {
      return;
    }

    window.open(phoneTestShareUrl, "_blank", "noopener,noreferrer");
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
                {needsReconnect ? (
                  <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    Needs reconnect
                  </span>
                ) : null}
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
                      void handleReconnect();
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
              {canShareServer && (
                <button
                  data-server-card-context-menu-exempt
                  onClick={() => {
                    posthog.capture("share_server_clicked", {
                      location: "server_connection_card",
                      platform: detectPlatform(),
                      environment: detectEnvironment(),
                    });
                    setIsShareDialogOpen(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent/60 cursor-pointer"
                >
                  <Share2 className="h-3 w-3" />
                  <span>Share</span>
                </button>
              )}
              {showTunnelActions && (
                <button
                  data-server-card-context-menu-exempt
                  onClick={handleOpenPhoneTestDialog}
                  disabled={isPreparingPhoneTest || !canGeneratePhoneTest}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-[11px] text-foreground transition-colors hover:bg-accent/60 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                >
                  {isPreparingPhoneTest ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Smartphone className="h-3 w-3" />
                  )}
                  <span>
                    {canGeneratePhoneTest
                      ? "Test on phone"
                      : "Sign in for phone test"}
                  </span>
                </button>
              )}
              {showTunnelActions && (
                <>
                  {hasTunnel ? (
                    <div className="inline-flex items-center overflow-hidden rounded-full border border-border/70 bg-muted/30 text-foreground">
                      <button
                        data-server-card-context-menu-exempt
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
                        data-server-card-context-menu-exempt
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
                          ? "Create ngrok tunnel"
                          : "Sign in for tunnel"}
                      </span>
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {hasError && (
            <div
              className="mt-3 rounded-md border border-red-300/40 bg-red-500/10 p-2 text-xs text-red-700 dark:text-red-300"
              onClick={(e) => e.stopPropagation()}
            >
              {oauthFailureStep ? (
                <div className="mb-1 font-medium">
                  OAuth failed during {oauthFailureStep.title}
                </div>
              ) : null}
              <div className="break-all">
                {isErrorExpanded
                  ? server.lastError
                  : server.lastError!.length > 140
                  ? `${server.lastError!.substring(0, 140)}...`
                  : server.lastError}
              </div>
              {server.lastError!.length > 140 && (
                <button
                  data-server-card-context-menu-exempt
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
      {canShareServer && hostedServerId && (
        <ShareServerDialog
          isOpen={isShareDialogOpen}
          onClose={() => setIsShareDialogOpen(false)}
          serverId={hostedServerId}
          serverName={server.name}
        />
      )}
      <PhoneTestDialog
        isOpen={isPhoneTestDialogOpen}
        onOpenChange={handlePhoneTestDialogOpenChange}
        serverName={server.name}
        shareUrl={phoneTestShareUrl}
        isPreparing={isPreparingPhoneTest}
        statusMessage={phoneTestStatusMessage}
        errorMessage={phoneTestErrorMessage}
        isCopied={copiedField === "phone-test-link"}
        onCopyLink={() => {
          if (phoneTestShareUrl) {
            void copyToClipboard(phoneTestShareUrl, "phone-test-link");
          }
        }}
        onOpenLink={handleOpenPhoneTestLink}
        onRetry={() => {
          void preparePhoneTestLink();
        }}
      />
    </>
  );
}
