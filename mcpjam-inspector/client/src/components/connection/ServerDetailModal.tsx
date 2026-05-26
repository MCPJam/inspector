import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { useMutation, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@mcpjam/design-system/tabs";
import { Switch } from "@mcpjam/design-system/switch";
import { Loader2 } from "lucide-react";
import { ServerWithName, type ServerUpdateResult } from "@/hooks/use-app-state";
import type { Project } from "@/state/app-types";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { ServerFormData } from "@/shared/types.js";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { getConnectionStatusMeta } from "./server-card-utils";
import { useServerForm } from "./hooks/use-server-form";
import { ServerInfoContent } from "./ServerInfoContent";
import { ServerInfoToolsMetadataContent } from "./ServerInfoToolsMetadataContent";
import { EditServerFormContent } from "./EditServerFormContent";
import type { McpProtocolVersion } from "@/lib/client-config-v2";
import type {
  ProjectServerConfigDto,
  ProjectServerConfigInput,
  ProjectServerOverrideEntry,
} from "@/lib/project-server-config";
import { EffectiveProtocolVersionChip } from "./shared/EffectiveProtocolVersionChip";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { useActiveMcpProfile } from "@/contexts/active-mcp-profile-context";

export type ServerDetailTab = "overview" | "configuration" | "tools-metadata";

interface ServerDetailModalProps {
  isOpen: boolean;
  onClose: () => void;
  server: ServerWithName;
  needsReconnect?: boolean;
  defaultTab?: ServerDetailTab;
  onSubmit: (
    formData: ServerFormData,
    originalServerName: string,
  ) => Promise<ServerUpdateResult>;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: {
      forceOAuthFlow?: boolean;
      allowInteractiveOAuthFlow?: boolean;
    },
  ) => Promise<void>;
  existingServerNames: string[];
  projectClientConfig?: Project["clientConfig"];
  projectId?: string | null;
  hostedServerId?: string | null;
  /**
   * Host-default outbound MCP wire mode resolved from the surrounding
   * client's hostConfig.mcpProfile. Surfaced as a prop because the
   * Servers tab doesn't render this modal inside an
   * `ActiveMcpProfileProvider` scope (that provider only wraps chat /
   * playground), so `useActiveMcpProfile()` would return undefined and
   * the chip would always read "Legacy · default" regardless of what
   * the user toggled on the client. Undefined = no host-level pin =
   * "Legacy · default" attribution on the chip.
   */
  hostDefaultMcpProtocolVersion?: McpProtocolVersion;
}

export function ServerDetailModal({
  isOpen,
  onClose,
  server,
  needsReconnect = false,
  defaultTab = "overview",
  onSubmit,
  onDisconnect,
  onReconnect,
  existingServerNames,
  projectClientConfig,
  projectId = null,
  hostedServerId = null,
  hostDefaultMcpProtocolVersion,
}: ServerDetailModalProps) {
  const posthog = usePostHog();
  const [activeTab, setActiveTab] = useState<ServerDetailTab>(defaultTab);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingTools, setIsLoadingTools] = useState(false);
  const [toolsLoadError, setToolsLoadError] = useState<string | null>(null);
  const [toolsData, setToolsData] =
    useState<ListToolsResultWithMetadata | null>(null);

  const initializationInfo = server.initializationInfo;
  const version = initializationInfo?.serverVersion?.version;

  // Per-server MCP wire-mode override lives on the project layer
  // (`projectServerRefs.mcpProtocolVersionOverride`), not the server's own
  // config blob — flipping it requires a `projectServerConfig:setConfig`
  // round-trip rather than a server-update. Read/write here so the
  // form control inside `EditServerFormContent` can stay a pure prop
  // consumer.
  const statelessMcpEnabled = useFeatureFlagEnabled("stateless-mcp-enabled");
  const projectServerConfigDto = useQuery(
    "projectServerConfig:getConfig" as never,
    projectId ? ({ projectId } as never) : "skip",
  ) as ProjectServerConfigDto | null | undefined;
  const setProjectServerConfigMutation = useMutation(
    "projectServerConfig:setConfig" as never,
  ) as unknown as (args: {
    projectId: string;
    input: ProjectServerConfigInput;
  }) => Promise<ProjectServerConfigDto>;
  // Resolve the inspector-side `serverId` — the project-server-refs DTO
  // is keyed by the canonical server document `_id`. `ServerWithName`
  // doesn't carry that (it's a local React-state shape keyed by name);
  // the modal's caller resolves the mapping via
  // `sharedProjectServersRecord[name]?._id` and passes it down as
  // `hostedServerId`.
  const serverId = hostedServerId ?? undefined;
  const currentMcpProtocolVersionOverride = useMemo<McpProtocolVersion | undefined>(
    () =>
      serverId
        ? (projectServerConfigDto?.overrides?.[serverId]
            ?.mcpProtocolVersionOverride as McpProtocolVersion | undefined)
        : undefined,
    [projectServerConfigDto, serverId],
  );
  // Host default — prefer the explicit prop passed by the Servers tab
  // (which has direct access to `previewedHost.config.mcpProfile`),
  // falling back to `useActiveMcpProfile()` for renderers that mount
  // this modal inside an `ActiveMcpProfileProvider` scope (chat,
  // playground). Mixing the two sources lets the chip work everywhere
  // without forcing the Servers tab to also wire up the provider just
  // for the chip's source attribution.
  const activeMcpProfile = useActiveMcpProfile();
  const resolvedHostDefaultMcpProtocolVersion: McpProtocolVersion | undefined =
    hostDefaultMcpProtocolVersion ?? activeMcpProfile?.mcpProtocolVersion;

  // Whether the server is in the project's auto-connect `serverIds`
  // set. The backend `ensureProjectServerConfig` rejects overrides for
  // servers not in this set ("override key X is not a member of
  // Pending reconnect bookkeeping for the override-save → reconnect
  // race (see `handleMcpProtocolVersionOverrideChange` below). Holds the
  // target override value the user just wrote; the watcher effect
  // fires reconnect once the Convex query reflects the new value. The
  // tick counter forces the effect to re-run when the timeout fallback
  // fires, even if the Convex value hasn't changed (e.g. a hung
  // refetch).
  const pendingReconnectRef = useRef<{
    target: McpProtocolVersion | undefined;
  } | null>(null);
  const [pendingReconnectTick, setPendingReconnectTick] = useState(0);
  useEffect(() => {
    const pending = pendingReconnectRef.current;
    if (!pending) return;
    if (currentMcpProtocolVersionOverride !== pending.target) return;
    pendingReconnectRef.current = null;
    void onReconnect(server.name).catch(() => {
      // Reconnect failures surface their own toast inside the handler.
    });
  }, [
    currentMcpProtocolVersionOverride,
    onReconnect,
    server.name,
    pendingReconnectTick,
  ]);

  const handleMcpProtocolVersionOverrideChange = async (
    next: McpProtocolVersion | undefined,
  ): Promise<void> => {
    if (!projectId) {
      toast.error(
        "Wire mode override requires a project context; cannot save without projectId.",
      );
      return;
    }
    if (!serverId) return;
    // `setConfig` replaces the entire `(serverIds, overrides)` pair on
    // the server. If the underlying Convex query is still loading
    // (`projectServerConfigDto === undefined`), defaulting to
    // `serverIds: []` / `overrides: {}` would wipe the project's
    // membership list and every other server's overrides — a
    // data-loss bug that fires if the user is fast enough to toggle
    // before hydration finishes. Bail out and surface a clear retry
    // hint instead.
    if (projectServerConfigDto === undefined) {
      toast.error(
        "Project configuration is still loading. Try again in a moment.",
      );
      return;
    }
    // setConfig replaces the entire (serverIds, overrides) pair — read
    // current (now guaranteed non-undefined), splice in the new
    // override, write back. Preserve every other server's overrides
    // verbatim. `projectServerConfigDto` may still be `null` (no row
    // yet for this project) — that case is genuinely the empty
    // baseline.
    const currentServerIds = projectServerConfigDto?.serverIds ?? [];
    if (!currentServerIds.includes(serverId)) {
      toast.error(
        "Enable auto-connect for this server first to set a per-server protocol override.",
      );
      return;
    }
    const currentOverrides = projectServerConfigDto?.overrides ?? {};
    const existingEntry = currentOverrides[serverId] ?? {};
    const updatedEntry: ProjectServerOverrideEntry = {
      ...existingEntry,
      mcpProtocolVersionOverride: next,
    };
    // Drop entry when it collapses to nothing (no headers, no timeout,
    // no wire-mode). Mirrors `normalizeOverrideEntry` on the backend so
    // the canonicalizer doesn't see an empty entry.
    const hasContent =
      (updatedEntry.headersOverride &&
        Object.keys(updatedEntry.headersOverride).length > 0) ||
      updatedEntry.requestTimeoutOverride !== undefined ||
      updatedEntry.mcpProtocolVersionOverride !== undefined;
    const nextOverrides: Record<string, ProjectServerOverrideEntry> = {
      ...currentOverrides,
    };
    if (hasContent) nextOverrides[serverId] = updatedEntry;
    else delete nextOverrides[serverId];
    try {
      await setProjectServerConfigMutation({
        projectId,
        input: { serverIds: currentServerIds, overrides: nextOverrides },
      });
      // Reconnect-after-save race: `onReconnect` ultimately reads from
      // `activeHostConfig.serverConnectionOverrides` to compute the new
      // wire mode. That value is a derivation of the same Convex row we
      // just wrote, but `useQuery` doesn't repopulate synchronously —
      // there's a brief window where the reactive subscription hasn't
      // pushed the new snapshot yet. We can't read `activeHostConfig`
      // from here (it lives in `use-server-state`), but we CAN observe
      // the override on `projectServerConfigDto`, which is fed by the
      // same mutation. Schedule reconnect inside an effect that waits
      // until the read-back matches the value we just wrote — same
      // "wait for reactive refetch" gate, but expressible at this
      // boundary. Falls back to a 1.5s deadline so a stuck refetch
      // (network blip) doesn't strand the toggle in a half-applied
      // state — the reconnect runs anyway and the user can retry.
      pendingReconnectRef.current = { target: next };
      // Fallback: if the reactive refetch is delayed (network blip,
      // backend slow), trigger reconnect after 1.5s anyway. The watcher
      // effect short-circuits if it already fired.
      window.setTimeout(() => {
        if (pendingReconnectRef.current?.target === next) {
          pendingReconnectRef.current = null;
          void onReconnect(server.name).catch(() => {});
        }
      }, 1500);
      // Tick the watcher so it re-evaluates immediately in case the
      // query already returned the new value before this handler ran.
      setPendingReconnectTick((t) => t + 1);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : "Failed to update wire mode override",
      );
    }
  };
  const isMCPAppServer = isMCPApp(toolsData);
  const isOpenAIAppServer = isOpenAIApp(toolsData);
  const isOpenAIAppAndMCPAppServer = isOpenAIAppAndMCPApp(toolsData);

  const formState = useServerForm(server, { projectClientConfig });
  const trimmedName = formState.name.trim();
  const isDuplicateServerName =
    trimmedName !== "" &&
    trimmedName !== server.name &&
    existingServerNames.includes(trimmedName);

  const isConnected = server.connectionStatus === "connected";
  const { label: connectionStatusLabel, indicatorColor } =
    getConnectionStatusMeta(server.connectionStatus);

  useEffect(() => {
    let isCancelled = false;

    const loadTools = async () => {
      if (!isOpen || server.connectionStatus !== "connected") {
        setIsLoadingTools(false);
        setToolsLoadError(null);
        setToolsData(null);
        return;
      }

      setIsLoadingTools(true);
      setToolsLoadError(null);
      try {
        const result = await listTools({ serverId: server.name });
        if (!isCancelled) {
          setToolsData(result);
          setToolsLoadError(null);
        }
      } catch (error) {
        if (!isCancelled) {
          console.error("Failed to load tools metadata:", error);
          setToolsLoadError(
            error instanceof Error
              ? error.message
              : "Failed to load tools metadata",
          );
          setToolsData(null);
        }
      } finally {
        if (!isCancelled) {
          setIsLoadingTools(false);
        }
      }
    };

    void loadTools();

    return () => {
      isCancelled = true;
    };
  }, [isOpen, server.connectionStatus, server.name]);

  const handleSave = async () => {
    if (isDuplicateServerName) {
      toast.error(
        `A server named "${trimmedName}" already exists. Choose a different name.`,
      );
      return;
    }

    // Validate form
    const formError = formState.validateForm();
    if (formError) {
      toast.error(formError);
      return;
    }

    // Validate Client ID if using custom configuration
    if (
      formState.authType === "oauth" &&
      formState.oauthRegistrationMode === "preregistered"
    ) {
      const clientIdError = formState.validateClientId(formState.clientId);
      if (clientIdError) {
        toast.error(clientIdError);
        return;
      }

      if (formState.clientSecret) {
        const clientSecretError = formState.validateClientSecret(
          formState.clientSecret,
        );
        if (clientSecretError) {
          toast.error(clientSecretError);
          return;
        }
      }
    }

    posthog.capture("update_server_button_clicked", {
      location: "server_detail_modal",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });

    const finalFormData = formState.buildFormData();
    setIsSaving(true);
    try {
      await onSubmit(finalFormData, server.name);
    } finally {
      setIsSaving(false);
    }
  };

  const handleConnect = async (options?: {
    forceOAuthFlow?: boolean;
    allowInteractiveOAuthFlow?: boolean;
  }) => {
    setIsReconnecting(true);
    posthog.capture("server_detail_modal_connect_clicked", {
      platform: detectPlatform(),
      environment: detectEnvironment(),
      server_id: server.name,
    });
    try {
      await onReconnect(server.name, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      toast.error(`Failed to connect to ${server.name}: ${errorMessage}`);
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

  const handleDisconnect = () => {
    posthog.capture("server_detail_modal_disconnect_clicked", {
      platform: detectPlatform(),
      environment: detectEnvironment(),
      server_id: server.name,
    });
    onDisconnect(server.name);
  };

  const handleClose = () => {
    posthog.capture("server_detail_modal_closed", {
      platform: detectPlatform(),
      environment: detectEnvironment(),
      server_id: server.name,
    });
    onClose();
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      handleClose();
    }
  };

  const tabGridClass = "grid w-full grid-cols-3";
  const isConfigurationTab = activeTab === "configuration";

  const handleConfigurationSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isConfigurationTab || isSaving) return;
    void handleSave();
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent
        className="max-w-2xl max-h-[85vh] flex flex-col outline-none focus:outline-none focus-visible:outline-none focus:ring-0 focus-visible:ring-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="truncate">{server.name}</span>
              {version && (
                <span className="text-sm text-muted-foreground font-normal flex-shrink-0">
                  v{version}
                </span>
              )}
              {(isOpenAIAppServer || isOpenAIAppAndMCPAppServer) && (
                <img
                  src="/openai_logo.png"
                  alt="OpenAI App"
                  className="h-5 w-5 flex-shrink-0"
                  title="OpenAI App"
                />
              )}
              {(isMCPAppServer || isOpenAIAppAndMCPAppServer) && (
                <img
                  src="/mcp.svg"
                  alt="MCP App"
                  className="h-5 w-5 flex-shrink-0 dark:invert"
                  title="MCP App"
                />
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0 mr-6">
              <EffectiveProtocolVersionChip
                hostDefault={resolvedHostDefaultMcpProtocolVersion}
                serverOverride={currentMcpProtocolVersionOverride}
                flagEnabled={Boolean(statelessMcpEnabled)}
              />
              <span className="inline-flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
                {isReconnecting ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: indicatorColor }}
                  />
                )}
                <span>
                  {isReconnecting
                    ? "Connecting..."
                    : server.connectionStatus === "failed"
                      ? `${connectionStatusLabel} (${server.retryCount})`
                      : connectionStatusLabel}
                </span>
              </span>
              <Switch
                checked={isConnected}
                disabled={
                  isReconnecting ||
                  server.connectionStatus === "connecting" ||
                  server.connectionStatus === "oauth-flow"
                }
                onCheckedChange={(checked) => {
                  if (!checked) {
                    handleDisconnect();
                  } else {
                    void handleConnect(getSwitchReconnectOptions());
                  }
                }}
                className="cursor-pointer scale-75"
              />
            </div>
          </DialogTitle>
          <DialogDescription className="sr-only">
            View server details, edit configuration, and manage connection
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={handleConfigurationSubmit}
          className="flex min-h-0 flex-col"
        >
          <Tabs
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as ServerDetailTab)}
            className="flex min-h-0 flex-col"
          >
            <TabsList className={tabGridClass}>
              <TabsTrigger value="configuration">Configuration</TabsTrigger>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="tools-metadata">Tools Metadata</TabsTrigger>
            </TabsList>

            <div className="relative mt-4 -mr-6 -ml-1">
              {/* Configuration: always rendered via forceMount, sets container height */}
              <TabsContent
                value="configuration"
                forceMount
                className="mt-0 flex-none max-h-[60vh] overflow-y-auto data-[state=inactive]:invisible"
              >
                <div className="pl-1 pr-6">
                  <EditServerFormContent
                    formState={formState}
                    isDuplicateServerName={isDuplicateServerName}
                    projectId={projectId}
                    hostedServerId={hostedServerId}
                    mcpProtocolVersionOverride={currentMcpProtocolVersionOverride}
                    onMcpProtocolVersionOverrideChange={
                      projectId && serverId &&
                      projectServerConfigDto?.serverIds.includes(serverId)
                        ? handleMcpProtocolVersionOverrideChange
                        : undefined
                    }
                  />
                </div>
              </TabsContent>

              {/* Footer inside the relative container so overlays cover it */}
              <DialogFooter
                data-testid="modal-footer"
                className="min-h-9 flex-shrink-0 pt-4 pl-1 pr-6 border-t border-border/50 sm:justify-end data-[state=inactive]:invisible"
                style={{
                  visibility: isConfigurationTab ? "visible" : "hidden",
                }}
              >
                <Button
                  type={isConnected && !formState.hasChanges ? "button" : "submit"}
                  onClick={
                    isConnected && !formState.hasChanges
                      ? () =>
                          void handleConnect({
                            allowInteractiveOAuthFlow: false,
                          })
                      : undefined
                  }
                  disabled={
                    isDuplicateServerName ||
                    isSaving ||
                    isReconnecting ||
                    (!formState.hasChanges && !isConnected) ||
                    formState.preregisteredOauthBlocksSubmit
                  }
                  size="sm"
                >
                  {isSaving || isReconnecting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {isSaving ? "Saving..." : "Reconnecting..."}
                    </>
                  ) : isConnected && !formState.hasChanges ? (
                    "Reconnect"
                  ) : (
                    "Save Changes"
                  )}
                </Button>
              </DialogFooter>

              {/* Overview: overlays the configuration panel + footer to use full space */}
              <TabsContent
                value="overview"
                className="mt-0 flex-none absolute inset-0 overflow-y-auto bg-background"
              >
                <div className="pl-1 pr-6">
                  {!isConnected &&
                  !server.lastError &&
                  !server.lastOAuthTrace ? (
                    <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-muted-foreground">
                      Connect to view server overview
                    </div>
                  ) : (
                    <ServerInfoContent
                      server={server}
                      needsReconnect={needsReconnect}
                      projectId={projectId}
                      hostedServerId={hostedServerId}
                    />
                  )}
                </div>
              </TabsContent>

              {/* Tools Metadata: overlays the configuration panel + footer to use full space */}
              <TabsContent
                value="tools-metadata"
                className="mt-0 flex-none absolute inset-0 overflow-y-auto bg-background"
              >
                <div className="pl-1 pr-6">
                  {!isConnected ? (
                    <div className="flex items-center justify-center h-full min-h-[120px] text-sm text-muted-foreground">
                      Connect to view tools metadata
                    </div>
                  ) : isLoadingTools || (!toolsData && !toolsLoadError) ? (
                    <div className="flex items-center justify-center gap-2 h-full min-h-[120px] text-sm text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading tools metadata...
                    </div>
                  ) : toolsLoadError ? (
                    <div className="flex flex-col items-center justify-center h-full min-h-[120px] text-sm text-muted-foreground text-center gap-1">
                      <span>Failed to load tools metadata</span>
                      <span className="text-xs max-w-[400px] truncate">
                        {toolsLoadError.slice(0, 200)}
                      </span>
                    </div>
                  ) : (
                    <ServerInfoToolsMetadataContent toolsData={toolsData} />
                  )}
                </div>
              </TabsContent>
            </div>
          </Tabs>
        </form>
      </DialogContent>
    </Dialog>
  );
}
