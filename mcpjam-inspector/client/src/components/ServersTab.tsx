import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Plus, FileText, Package, ArrowRight, Loader2 } from "lucide-react";
import { ServerWithName, type ServerUpdateResult } from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { AddServerModal } from "./connection/AddServerModal";
import {
  ServerDetailModal,
  type ServerDetailTab,
} from "./connection/ServerDetailModal";

import { JsonImportModal } from "./connection/JsonImportModal";
import { ServerFormData } from "@/shared/types.js";
import { MCPIcon } from "./ui/mcp-icon";
import { usePostHog } from "posthog-js/react";
import { useQuery } from "convex/react";
import type { RegistryServer } from "@/hooks/useRegistryServers";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { CollapsedPanelStrip } from "./ui/collapsed-panel-strip";
import { LoggerView } from "./logger-view";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { Skeleton } from "./ui/skeleton";
import { useConvexAuth } from "convex/react";
import { Workspace } from "@/state/app-types";
import {
  clearPendingQuickConnect,
  readPendingQuickConnect,
  writePendingQuickConnect,
  type PendingQuickConnectState,
} from "@/lib/quick-connect-pending";
import { useWorkspaceServers as useRemoteWorkspaceServers } from "@/hooks/useWorkspaces";
import {
  getEffectiveServerClientCapabilities,
  workspaceClientCapabilitiesNeedReconnect,
} from "@/lib/client-config";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  clearOpenServerDetailModalState,
  clearServerDetailModalOAuthResume,
  readServerDetailModalOAuthResume,
  writeOpenServerDetailModalState,
} from "@/lib/server-detail-modal-resume";

const ORDER_STORAGE_KEY = "mcp-server-order";

function loadServerOrder(workspaceId: string): string[] | undefined {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    return raw ? JSON.parse(raw)[workspaceId] : undefined;
  } catch {
    return undefined;
  }
}

function saveServerOrder(workspaceId: string, orderedNames: string[]): void {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[workspaceId] = orderedNames;
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function SortableServerCard({
  id,
  dndDisabled,
  server,
  needsReconnect,
  onDisconnect,
  onReconnect,
  onRemove,
  hostedServerId,
  onOpenDetailModal,
}: {
  id: string;
  dndDisabled: boolean;
  server: ServerWithName;
  needsReconnect?: boolean;
  onDisconnect: (name: string) => void;
  onReconnect: (
    name: string,
    opts?: { forceOAuthFlow?: boolean },
  ) => Promise<void>;
  onRemove: (name: string) => void;
  hostedServerId?: string;
  onOpenDetailModal?: (
    server: ServerWithName,
    defaultTab: ServerDetailTab,
  ) => void;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: dndDisabled });
  const dragListeners =
    listeners == null
      ? {}
      : (({ onKeyDown: _ignoredOnKeyDown, ...pointerListeners }) =>
          pointerListeners)(listeners);

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...dragListeners}>
      <ServerConnectionCard
        server={server}
        needsReconnect={needsReconnect}
        onDisconnect={onDisconnect}
        onReconnect={onReconnect}
        onRemove={onRemove}
        hostedServerId={hostedServerId}
        onOpenDetailModal={onOpenDetailModal}
      />
    </div>
  );
}

interface ServersTabProps {
  workspaceServers: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean },
  ) => Promise<void>;
  onUpdate: (
    originalServerName: string,
    formData: ServerFormData,
    skipAutoConnect?: boolean,
  ) => Promise<ServerUpdateResult>;
  onRemove: (serverName: string) => void;
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  isLoadingWorkspaces?: boolean;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
  onNavigateToRegistry?: () => void;
}

export function ServersTab({
  workspaceServers,
  onConnect,
  onDisconnect,
  onReconnect,
  onUpdate,
  onRemove,
  workspaces,
  activeWorkspaceId,
  isLoadingWorkspaces,
  onWorkspaceShared,
  onNavigateToRegistry,
}: ServersTabProps) {
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const [pendingQuickConnect, setPendingQuickConnect] =
    useState<PendingQuickConnectState | null>(() => readPendingQuickConnect());

  // Fetch featured registry servers for the quick-connect section
  const registryServers = useQuery(
    "registryServers:listRegistryServers" as any,
    isAuthenticated ? ({} as any) : "skip",
  ) as RegistryServer[] | undefined;
  const featuredRegistryServers = useMemo(() => {
    if (!registryServers) return [];
    const featured = registryServers
      .filter((s) => s.sortOrder != null)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    return (featured.length > 0 ? featured : registryServers).slice(0, 4);
  }, [registryServers]);
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [detailModalState, setDetailModalState] = useState<{
    isOpen: boolean;
    serverName: string | null;
    defaultTab: ServerDetailTab;
    sessionKey: number;
    serverSnapshot: ServerWithName | null;
  }>({
    isOpen: false,
    serverName: null,
    defaultTab: "configuration",
    sessionKey: 0,
    serverSnapshot: null,
  });

  // --- Self-contained local ordering (localStorage only, never synced to Convex) ---
  const allNames = useMemo(
    () => Object.keys(workspaceServers),
    [workspaceServers],
  );

  const [orderedServerNames, setOrderedServerNames] = useState<string[]>(() => {
    const saved = loadServerOrder(activeWorkspaceId);
    if (saved && saved.length > 0) {
      const existing = saved.filter((n: string) => allNames.includes(n));
      const added = allNames.filter((n) => !existing.includes(n));
      return [...existing, ...added];
    }
    return allNames;
  });

  // Reconcile when servers are added/removed or workspace changes
  useEffect(() => {
    setOrderedServerNames((prev) => {
      const saved = loadServerOrder(activeWorkspaceId);
      const base = saved && saved.length > 0 ? saved : prev;
      const existing = base.filter((n) => allNames.includes(n));
      const added = allNames.filter((n) => !existing.includes(n));
      return [...existing, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNames.join(","), activeWorkspaceId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = orderedServerNames.findIndex(
        (name) => name === active.id,
      );
      const newIndex = orderedServerNames.findIndex((name) => name === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(orderedServerNames, oldIndex, newIndex);
        setOrderedServerNames(newOrder);
        saveServerOrder(activeWorkspaceId, newOrder);
      }
    }
    setActiveId(null);
  };

  const activeServer = activeId ? workspaceServers[activeId] : null;
  const reconnectWarningByServerName = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(workspaceServers).map(([serverName, server]) => [
          serverName,
          server.connectionStatus === "connected" &&
            workspaceClientCapabilitiesNeedReconnect({
              desiredCapabilities: getEffectiveServerClientCapabilities({
                workspaceClientConfig:
                  workspaces[activeWorkspaceId]?.clientConfig,
                serverCapabilities: server.config.capabilities as
                  | Record<string, unknown>
                  | undefined,
              }),
              initializedCapabilities: server.initializationInfo
                ?.clientCapabilities as Record<string, unknown> | undefined,
            }),
        ]),
      ),
    [activeWorkspaceId, workspaceServers, workspaces],
  );

  const detailModalLiveServer = detailModalState.serverName
    ? (workspaceServers[detailModalState.serverName] ?? null)
    : null;
  const detailModalServer =
    detailModalLiveServer ?? detailModalState.serverSnapshot;

  useEffect(() => {
    if (!detailModalState.isOpen || detailModalServer == null) {
      clearOpenServerDetailModalState();
      return;
    }

    writeOpenServerDetailModalState(detailModalServer.name);

    return () => {
      clearOpenServerDetailModalState();
    };
  }, [detailModalServer, detailModalState.isOpen]);

  useEffect(() => {
    if (detailModalState.isOpen) {
      return;
    }

    const resumeMarker = readServerDetailModalOAuthResume();
    if (!resumeMarker) {
      return;
    }

    const resumeServer = workspaceServers[resumeMarker.serverName];
    if (!resumeServer) {
      return;
    }

    setDetailModalState((prev) => ({
      isOpen: true,
      serverName: resumeServer.name,
      defaultTab: "configuration",
      sessionKey: prev.sessionKey + 1,
      serverSnapshot: resumeServer,
    }));
    clearServerDetailModalOAuthResume();
  }, [detailModalState.isOpen, workspaceServers]);

  useEffect(() => {
    posthog.capture("servers_tab_viewed", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      num_servers: Object.keys(workspaceServers).length,
    });
  }, []);

  useEffect(() => {
    if (pendingQuickConnect?.sourceTab !== "servers") {
      return;
    }

    const pendingServer = workspaceServers[pendingQuickConnect.serverName];
    if (!pendingServer) {
      return;
    }

    if (
      pendingServer.connectionStatus === "connected" ||
      pendingServer.connectionStatus === "failed" ||
      pendingServer.connectionStatus === "disconnected"
    ) {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
  }, [pendingQuickConnect, workspaceServers]);

  const connectedCount = Object.keys(workspaceServers).length;
  const hasConnectedServers = Object.values(workspaceServers).some(
    (server) => server.connectionStatus === "connected",
  );
  const hasAnyServers = connectedCount > 0;
  const pendingQuickConnectServer =
    pendingQuickConnect?.sourceTab === "servers"
      ? workspaceServers[pendingQuickConnect.serverName]
      : null;
  const isPendingQuickConnectVisible =
    pendingQuickConnect?.sourceTab === "servers" &&
    (!pendingQuickConnectServer ||
      pendingQuickConnectServer.connectionStatus === "oauth-flow" ||
      pendingQuickConnectServer.connectionStatus === "connecting");
  const pendingQuickConnectPhaseLabel =
    pendingQuickConnectServer?.connectionStatus === "connecting"
      ? "Finishing setup..."
      : "Authorizing...";
  const activeWorkspace = workspaces[activeWorkspaceId];
  const sharedWorkspaceId = activeWorkspace?.sharedWorkspaceId;
  const { serversRecord: sharedWorkspaceServersRecord } =
    useRemoteWorkspaceServers({
      workspaceId: sharedWorkspaceId ?? null,
      isAuthenticated,
    });

  const handleOpenDetailModal = useCallback(
    (server: ServerWithName, defaultTab: ServerDetailTab) => {
      setDetailModalState((prev) => ({
        isOpen: true,
        serverName: server.name,
        defaultTab,
        sessionKey: prev.sessionKey + 1,
        serverSnapshot: server,
      }));
    },
    [],
  );

  const handleCloseDetailModal = useCallback(() => {
    setDetailModalState((prev) => ({
      ...prev,
      isOpen: false,
    }));
  }, []);

  const handleSubmitDetailModal = useCallback(
    async (formData: ServerFormData, originalServerName: string) => {
      const optimisticServerName = formData.name.trim() || originalServerName;

      setDetailModalState((prev) => ({
        ...prev,
        serverName: optimisticServerName,
        serverSnapshot: prev.serverSnapshot
          ? { ...prev.serverSnapshot, name: optimisticServerName }
          : prev.serverSnapshot,
      }));

      const result = await onUpdate(originalServerName, formData);

      setDetailModalState((prev) => {
        const liveServer = workspaceServers[result.serverName];

        return {
          ...prev,
          serverName: result.serverName,
          serverSnapshot: liveServer
            ? liveServer
            : prev.serverSnapshot
              ? { ...prev.serverSnapshot, name: result.serverName }
              : prev.serverSnapshot,
        };
      });

      return result;
    },
    [onUpdate, workspaceServers],
  );

  useEffect(() => {
    if (!detailModalState.isOpen || detailModalLiveServer == null) {
      return;
    }

    setDetailModalState((prev) => {
      if (
        !prev.isOpen ||
        prev.serverName !== detailModalState.serverName ||
        prev.serverSnapshot === detailModalLiveServer
      ) {
        return prev;
      }

      return {
        ...prev,
        serverSnapshot: detailModalLiveServer,
      };
    });
  }, [
    detailModalLiveServer,
    detailModalState.isOpen,
    detailModalState.serverName,
  ]);

  const handleJsonImport = (servers: ServerFormData[]) => {
    servers.forEach((server) => {
      onConnect(server);
    });
  };

  const handleQuickConnect = (server: RegistryServer) => {
    const nextPendingQuickConnect: PendingQuickConnectState = {
      serverName: server.displayName,
      registryServerId: server._id,
      displayName: server.displayName,
      sourceTab: "servers",
      createdAt: Date.now(),
    };
    writePendingQuickConnect(nextPendingQuickConnect);
    setPendingQuickConnect(nextPendingQuickConnect);
    onConnect({
      name: server.displayName,
      type: server.transport.transportType,
      url: server.transport.url,
      useOAuth: server.transport.useOAuth,
      oauthScopes: server.transport.oauthScopes,
      oauthCredentialKey: server.transport.oauthCredentialKey,
      registryServerId: server._id,
    });
  };

  const clearPendingQuickConnectIfMatches = useCallback(
    (serverName: string) => {
      if (pendingQuickConnect?.serverName !== serverName) {
        return;
      }
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    },
    [pendingQuickConnect],
  );

  const handleAddServerClick = () => {
    posthog.capture("add_server_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsAddingServer(true);
    setIsActionMenuOpen(false);
  };

  const handleImportJsonClick = () => {
    posthog.capture("import_json_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsImportingJson(true);
    setIsActionMenuOpen(false);
  };

  const renderServerActionsMenu = () => (
    <>
      <HoverCard
        open={isActionMenuOpen}
        onOpenChange={setIsActionMenuOpen}
        openDelay={150}
        closeDelay={100}
      >
        <HoverCardTrigger asChild>
          <Button
            size="sm"
            onClick={handleAddServerClick}
            className="cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Server
          </Button>
        </HoverCardTrigger>
        <HoverCardContent align="end" sideOffset={8} className="w-56 p-3">
          <div className="flex flex-col gap-2">
            <Button
              variant="ghost"
              className="justify-start"
              onClick={handleAddServerClick}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add manually
            </Button>
            <Button
              variant="ghost"
              className="justify-start"
              onClick={handleImportJsonClick}
            >
              <FileText className="h-4 w-4 mr-2" />
              Import JSON
            </Button>
          </div>
        </HoverCardContent>
      </HoverCard>
    </>
  );

  const renderConnectedContent = () => (
    <ResizablePanelGroup direction="horizontal" className="flex-1">
      {/* Main Server List Panel */}
      <ResizablePanel
        defaultSize={isJsonRpcPanelVisible ? 65 : 100}
        minSize={70}
      >
        <div className="space-y-6 p-8 h-full overflow-auto">
          {/* Header Section */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              {renderServerActionsMenu()}
            </div>
          </div>

          {/* Server Cards Grid (drag-and-drop reorderable, order saved to localStorage only) */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={orderedServerNames}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-1 lg:grid-cols-1 xl:grid-cols-2 gap-6">
                {orderedServerNames.map((name) => {
                  const server = workspaceServers[name];
                  if (!server) return null;
                  return (
                    <SortableServerCard
                      key={name}
                      id={name}
                      dndDisabled={false}
                      server={server}
                      needsReconnect={reconnectWarningByServerName[name]}
                      onDisconnect={onDisconnect}
                      onReconnect={onReconnect}
                      onRemove={onRemove}
                      hostedServerId={sharedWorkspaceServersRecord[name]?._id}
                      onOpenDetailModal={handleOpenDetailModal}
                    />
                  );
                })}
              </div>
            </SortableContext>
            <DragOverlay>
              {activeServer ? (
                <div style={{ opacity: 0.85 }}>
                  <ServerConnectionCard
                    server={activeServer}
                    needsReconnect={
                      reconnectWarningByServerName[activeServer.name]
                    }
                    onDisconnect={onDisconnect}
                    onReconnect={onReconnect}
                    onRemove={onRemove}
                    hostedServerId={
                      sharedWorkspaceServersRecord[activeId!]?._id
                    }
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>
      </ResizablePanel>

      {/* JSON-RPC Traces Panel */}
      {isJsonRpcPanelVisible ? (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel
            defaultSize={35}
            minSize={4}
            maxSize={50}
            collapsible={true}
            collapsedSize={0}
            onCollapse={toggleJsonRpcPanel}
          >
            <div className="h-full flex flex-col bg-background border-l border-border">
              <LoggerView key={connectedCount} onClose={toggleJsonRpcPanel} />
            </div>
          </ResizablePanel>
        </>
      ) : (
        <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
      )}
    </ResizablePanelGroup>
  );

  const renderEmptyContent = () => (
    <div className="space-y-6 p-8 h-full overflow-auto">
      {/* Header Section */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-2">
          {renderServerActionsMenu()}
        </div>
      </div>

      {/* Quick Connect from Registry */}
      {isAuthenticated && featuredRegistryServers.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-muted-foreground">
              Quick Connect
            </h3>
            {onNavigateToRegistry && (
              <Button
                variant="link"
                size="sm"
                className="text-xs h-auto p-0"
                onClick={onNavigateToRegistry}
              >
                View all in Registry
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            )}
          </div>
          {isPendingQuickConnectVisible && pendingQuickConnect && (
            <Card className="border-blue-500/30 bg-blue-500/5 px-4 py-3">
              <div className="flex items-center gap-3">
                <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">
                    {`Connecting ${pendingQuickConnect.displayName}...`}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {pendingQuickConnectPhaseLabel}
                  </p>
                </div>
              </div>
            </Card>
          )}
          <div className="flex gap-3 overflow-x-auto pb-1">
            {featuredRegistryServers.map((server) => {
              const isPendingServer =
                pendingQuickConnect?.sourceTab === "servers" &&
                (pendingQuickConnect.registryServerId === server._id ||
                  pendingQuickConnect.serverName === server.displayName);

              return (
                <button
                  key={server._id}
                  type="button"
                  aria-label={`Connect ${server.displayName}`}
                  className="p-3 flex items-center gap-3 min-w-[220px] max-w-[280px] flex-shrink-0 rounded-xl border bg-card text-card-foreground hover:bg-accent/50 transition-colors text-left disabled:cursor-not-allowed disabled:opacity-80"
                  onClick={() => handleQuickConnect(server)}
                  disabled={isPendingServer}
                >
                  {isPendingServer ? (
                    <div className="h-8 w-8 rounded-md bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <Loader2 className="h-4 w-4 animate-spin text-blue-500" />
                    </div>
                  ) : server.iconUrl ? (
                    <img
                      src={server.iconUrl}
                      alt={server.displayName}
                      className="h-8 w-8 rounded-md object-contain flex-shrink-0"
                    />
                  ) : (
                    <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
                      <Package className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">
                      {server.displayName}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {isPendingServer
                        ? pendingQuickConnectPhaseLabel
                        : server.publisher}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
          {isPendingQuickConnectVisible && pendingQuickConnectServer && (
            <ServerConnectionCard
              server={pendingQuickConnectServer}
              onDisconnect={(serverName) => {
                clearPendingQuickConnectIfMatches(serverName);
                onDisconnect(serverName);
              }}
              onReconnect={onReconnect}
              onRemove={(serverName) => {
                clearPendingQuickConnectIfMatches(serverName);
                onRemove(serverName);
              }}
              hostedServerId={
                sharedWorkspaceServersRecord[pendingQuickConnectServer.name]?._id
              }
              onOpenDetailModal={handleOpenDetailModal}
            />
          )}
        </div>
      )}

      {/* Empty State */}
      <Card className="p-12 text-center">
        <div className="mx-auto max-w-sm">
          <MCPIcon className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">No servers connected</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Get started by connecting to your first MCP server
          </p>
          <Button
            onClick={() => setIsAddingServer(true)}
            className="mt-4 cursor-pointer"
          >
            <Plus className="h-4 w-4 mr-2" />
            Add Your First Server
          </Button>
        </div>
      </Card>
    </div>
  );

  const renderLoadingContent = () => (
    <div className="flex-1 p-6">
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-48 w-full rounded-lg" />
      </div>
    </div>
  );

  return (
    <div className="h-full flex flex-col">
      {isLoadingWorkspaces
        ? renderLoadingContent()
        : hasConnectedServers || (hasAnyServers && !isPendingQuickConnectVisible)
          ? renderConnectedContent()
          : renderEmptyContent()}

      {/* Add Server Modal */}
      <AddServerModal
        isOpen={isAddingServer}
        onClose={() => {
          setIsAddingServer(false);
        }}
        onSubmit={(formData) => {
          posthog.capture("connecting_server", {
            location: "servers_tab",
            platform: detectPlatform(),
            environment: detectEnvironment(),
          });
          onConnect(formData);
        }}
      />

      {/* JSON Import Modal */}
      <JsonImportModal
        isOpen={isImportingJson}
        onClose={() => setIsImportingJson(false)}
        onImport={handleJsonImport}
      />

      {detailModalServer && (
        <ServerDetailModal
          key={detailModalState.sessionKey}
          isOpen={detailModalState.isOpen}
          onClose={handleCloseDetailModal}
          server={detailModalServer}
          needsReconnect={reconnectWarningByServerName[detailModalServer.name]}
          defaultTab={detailModalState.defaultTab}
          onSubmit={handleSubmitDetailModal}
          onDisconnect={onDisconnect}
          onReconnect={onReconnect}
          existingServerNames={Object.keys(workspaceServers)}
        />
      )}
    </div>
  );
}
