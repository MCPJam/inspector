import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
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
import type { Workspace } from "@/state/app-types";
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
  workspaceClientConfig?: Workspace["clientConfig"];
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
  workspaceClientConfig,
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
  const isMCPAppServer = isMCPApp(toolsData);
  const isOpenAIAppServer = isOpenAIApp(toolsData);
  const isOpenAIAppAndMCPAppServer = isOpenAIAppAndMCPApp(toolsData);
  const hasWidgetMetadata =
    isMCPAppServer || isOpenAIAppServer || isOpenAIAppAndMCPAppServer;

  const formState = useServerForm(server, { workspaceClientConfig });
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
                    void handleConnect({
                      allowInteractiveOAuthFlow: false,
                    });
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
                  type="submit"
                  disabled={
                    isDuplicateServerName ||
                    isSaving ||
                    !formState.hasChanges ||
                    formState.preregisteredOauthBlocksSubmit
                  }
                  size="sm"
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Saving...
                    </>
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
