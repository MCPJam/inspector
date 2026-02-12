import { useEffect, useMemo, useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Plus, FileText } from "lucide-react";
import { ServerWithName } from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { AddServerModal } from "./connection/AddServerModal";
import { EditServerModal } from "./connection/EditServerModal";
import { JsonImportModal } from "./connection/JsonImportModal";
import { ServerFormData } from "@/shared/types.js";
import { MCPIcon } from "./ui/mcp-icon";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { WorkspaceMembersFacepile } from "./workspace/WorkspaceMembersFacepile";
import { WorkspaceShareButton } from "./workspace/WorkspaceShareButton";
import { WorkspaceSelector } from "./connection/WorkspaceSelector";
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
import { useAuth } from "@workos-inc/authkit-react";
import { Workspace } from "@/state/app-types";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
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
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

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
  server,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
}: {
  id: string;
  server: ServerWithName;
  onDisconnect: (name: string) => void;
  onReconnect: (name: string, opts?: { forceOAuthFlow?: boolean }) => void;
  onEdit: (server: ServerWithName) => void;
  onRemove: (name: string) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <ServerConnectionCard
        server={server}
        onDisconnect={onDisconnect}
        onReconnect={onReconnect}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </div>
  );
}

interface ServersTabProps {
  connectedOrConnectingServerConfigs: Record<string, ServerWithName>;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: { forceOAuthFlow?: boolean },
  ) => void;
  onUpdate: (
    originalServerName: string,
    formData: ServerFormData,
    skipAutoConnect?: boolean,
  ) => void;
  onRemove: (serverName: string) => void;
  workspaces: Record<string, Workspace>;
  activeWorkspaceId: string;
  onSwitchWorkspace: (workspaceId: string) => void;
  onCreateWorkspace: (name: string, switchTo?: boolean) => Promise<string>;
  onUpdateWorkspace: (workspaceId: string, updates: Partial<Workspace>) => void;
  onDeleteWorkspace: (workspaceId: string) => void;
  isLoadingWorkspaces?: boolean;
  onWorkspaceShared?: (sharedWorkspaceId: string) => void;
  onLeaveWorkspace?: () => void;
}

export function ServersTab({
  connectedOrConnectingServerConfigs,
  onConnect,
  onDisconnect,
  onReconnect,
  onUpdate,
  onRemove,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  onCreateWorkspace,
  onUpdateWorkspace,
  onDeleteWorkspace,
  isLoadingWorkspaces,
  onWorkspaceShared,
  onLeaveWorkspace,
}: ServersTabProps) {
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const { user } = useAuth();
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<ServerWithName | null>(null);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  // --- Self-contained local ordering (localStorage only, never synced to Convex) ---
  const allNames = useMemo(
    () => Object.keys(connectedOrConnectingServerConfigs),
    [connectedOrConnectingServerConfigs],
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
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
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

  const activeServer = activeId
    ? connectedOrConnectingServerConfigs[activeId]
    : null;

  useEffect(() => {
    posthog.capture("servers_tab_viewed", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      num_servers: Object.keys(connectedOrConnectingServerConfigs).length,
    });
  }, []);

  const connectedCount = Object.keys(connectedOrConnectingServerConfigs).length;
  const activeWorkspace = workspaces[activeWorkspaceId];
  const workspaceName = activeWorkspace?.name || "Workspace";
  const sharedWorkspaceId = activeWorkspace?.sharedWorkspaceId;

  const handleEditServer = (server: ServerWithName) => {
    setServerToEdit(server);
    setIsEditingServer(true);
  };

  const handleCloseEditModal = () => {
    setIsEditingServer(false);
    setServerToEdit(null);
  };

  const handleJsonImport = (servers: ServerFormData[]) => {
    servers.forEach((server) => {
      onConnect(server);
    });
  };

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
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <WorkspaceSelector
                  activeWorkspaceId={activeWorkspaceId}
                  workspaces={workspaces}
                  onSwitchWorkspace={onSwitchWorkspace}
                  onCreateWorkspace={onCreateWorkspace}
                  onUpdateWorkspace={onUpdateWorkspace}
                  onDeleteWorkspace={onDeleteWorkspace}
                  isLoading={isLoadingWorkspaces}
                />
              </div>
              <div className="flex items-center gap-2">
                {isAuthenticated && user && (
                  <WorkspaceMembersFacepile
                    workspaceName={workspaceName}
                    workspaceServers={connectedOrConnectingServerConfigs}
                    currentUser={user}
                    sharedWorkspaceId={sharedWorkspaceId}
                    onWorkspaceShared={onWorkspaceShared}
                    onLeaveWorkspace={onLeaveWorkspace}
                  />
                )}
                <WorkspaceShareButton
                  workspaceName={workspaceName}
                  workspaceServers={connectedOrConnectingServerConfigs}
                  sharedWorkspaceId={sharedWorkspaceId}
                  onWorkspaceShared={onWorkspaceShared}
                  onLeaveWorkspace={onLeaveWorkspace}
                />
                {renderServerActionsMenu()}
              </div>
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
                  const server = connectedOrConnectingServerConfigs[name];
                  if (!server) return null;
                  return (
                    <SortableServerCard
                      key={name}
                      id={name}
                      server={server}
                      onDisconnect={onDisconnect}
                      onReconnect={onReconnect}
                      onEdit={handleEditServer}
                      onRemove={onRemove}
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
                    onDisconnect={onDisconnect}
                    onReconnect={onReconnect}
                    onEdit={handleEditServer}
                    onRemove={onRemove}
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
          <ResizablePanel defaultSize={35} minSize={20} maxSize={50}>
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-6">
          <WorkspaceSelector
            activeWorkspaceId={activeWorkspaceId}
            workspaces={workspaces}
            onSwitchWorkspace={onSwitchWorkspace}
            onCreateWorkspace={onCreateWorkspace}
            onUpdateWorkspace={onUpdateWorkspace}
            onDeleteWorkspace={onDeleteWorkspace}
            isLoading={isLoadingWorkspaces}
          />
        </div>
        <div className="flex items-center gap-2">
          {isAuthenticated && user && (
            <WorkspaceMembersFacepile
              workspaceName={workspaceName}
              workspaceServers={connectedOrConnectingServerConfigs}
              currentUser={user}
              sharedWorkspaceId={sharedWorkspaceId}
              onWorkspaceShared={onWorkspaceShared}
              onLeaveWorkspace={onLeaveWorkspace}
            />
          )}
          <WorkspaceShareButton
            workspaceName={workspaceName}
            workspaceServers={connectedOrConnectingServerConfigs}
            sharedWorkspaceId={sharedWorkspaceId}
            onWorkspaceShared={onWorkspaceShared}
            onLeaveWorkspace={onLeaveWorkspace}
          />
          {renderServerActionsMenu()}
        </div>
      </div>

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
        : connectedCount > 0
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

      {/* Edit Server Modal */}
      {serverToEdit && (
        <EditServerModal
          isOpen={isEditingServer}
          onClose={handleCloseEditModal}
          onSubmit={(formData, originalName) =>
            onUpdate(originalName, formData)
          }
          server={serverToEdit}
          existingServerNames={Object.keys(connectedOrConnectingServerConfigs)}
        />
      )}

      {/* JSON Import Modal */}
      <JsonImportModal
        isOpen={isImportingJson}
        onClose={() => setIsImportingJson(false)}
        onImport={handleJsonImport}
      />
    </div>
  );
}
