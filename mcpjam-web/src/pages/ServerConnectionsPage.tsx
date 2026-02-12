import { useEffect, useMemo, useState } from "react";
import { Plus, FileText } from "lucide-react";
import { toast } from "sonner";
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
import type { MCPClientManager } from "@mcpjam/sdk/browser";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MCPIcon } from "@/components/ui/mcp-icon";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { EditServerModal } from "@/components/connection/EditServerModal";
import { JsonImportModal } from "@/components/connection/JsonImportModal";
import { ServerConnectionCard } from "@/components/connection/ServerConnectionCard";
import type { ServerFormData, ServerWithName } from "@/types/server-types";
import { useMcpConnections } from "@/hooks/useMcpConnections";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";

const ORDER_STORAGE_KEY = "mcpjam-web-server-order";

function loadServerOrder(): string[] | undefined {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as string[]) : undefined;
  } catch {
    return undefined;
  }
}

function saveServerOrder(orderedIds: string[]): void {
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(orderedIds));
  } catch {
    // ignore
  }
}

function mapStatus(status: string): ServerWithName["connectionStatus"] {
  switch (status) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting";
    case "oauth-pending":
      return "oauth-flow";
    case "error":
      return "failed";
    default:
      return "disconnected";
  }
}

function SortableServerCard({
  id,
  server,
  onDisconnect,
  onReconnect,
  onEdit,
  onRemove,
  manager,
}: {
  id: string;
  server: ServerWithName;
  manager: MCPClientManager | null;
  onDisconnect: (id: string) => void;
  onReconnect: (id: string, opts?: { forceOAuthFlow?: boolean }) => void;
  onEdit: (server: ServerWithName) => void;
  onRemove: (id: string) => void;
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
        manager={manager}
        onDisconnect={onDisconnect}
        onReconnect={onReconnect}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    </div>
  );
}

export function ServerConnectionsPage() {
  const {
    servers,
    connectServer,
    disconnectServer,
    reconnectServer,
    removeServer,
    getManager,
  } = useMcpConnections();

  const manager = getManager();
  const [isAddingServer, setIsAddingServer] = useState(false);
  const [isImportingJson, setIsImportingJson] = useState(false);
  const [isEditingServer, setIsEditingServer] = useState(false);
  const [serverToEdit, setServerToEdit] = useState<ServerWithName | null>(null);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const serversById = useMemo<Record<string, ServerWithName>>(() => {
    return Object.fromEntries(
      servers.map((server) => {
        const urlConfig = {
          url: server.url,
          preferSSE: server.transport === "sse",
          timeout: 10000,
          requestInit: server.headers ? { headers: server.headers } : undefined,
          sessionId: server.sessionId,
        };

        const mapped: ServerWithName = {
          id: server.id,
          name: server.name,
          config: urlConfig,
          oauthTokens: getStoredTokens(server.id) ?? undefined,
          initializationInfo: server.initializationInfo as
            | ServerWithName["initializationInfo"]
            | undefined,
          lastConnectionTime: new Date(server.lastConnectedAt ?? server.createdAt),
          connectionStatus: mapStatus(server.connectionStatus),
          retryCount: server.retryCount,
          lastError: server.lastError?.message,
          useOAuth: server.oauth?.enabled,
        };

        return [server.id, mapped];
      }),
    );
  }, [servers]);

  const allIds = useMemo(() => Object.keys(serversById), [serversById]);

  const [orderedServerIds, setOrderedServerIds] = useState<string[]>(() => {
    const saved = loadServerOrder();
    if (saved && saved.length > 0) {
      const existing = saved.filter((id) => allIds.includes(id));
      const added = allIds.filter((id) => !existing.includes(id));
      return [...existing, ...added];
    }
    return allIds;
  });

  useEffect(() => {
    setOrderedServerIds((prev) => {
      const saved = loadServerOrder();
      const base = saved && saved.length > 0 ? saved : prev;
      const existing = base.filter((id) => allIds.includes(id));
      const added = allIds.filter((id) => !existing.includes(id));
      return [...existing, ...added];
    });
  }, [allIds]);

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
      const oldIndex = orderedServerIds.findIndex((id) => id === active.id);
      const newIndex = orderedServerIds.findIndex((id) => id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(orderedServerIds, oldIndex, newIndex);
        setOrderedServerIds(newOrder);
        saveServerOrder(newOrder);
      }
    }
    setActiveId(null);
  };

  const activeServer = activeId ? serversById[activeId] : null;

  const handleConnect = async (formData: ServerFormData) => {
    if (formData.type !== "http" || !formData.url) {
      throw new Error("Only remote HTTPS HTTP MCP servers are supported.");
    }
    if (Object.values(serversById).some((server) => server.name === formData.name)) {
      throw new Error(`A server named "${formData.name}" already exists.`);
    }

    await connectServer({
      name: formData.name,
      url: formData.url,
      transport: "streamable-http",
      headers: formData.headers,
      oauth: {
        enabled: formData.useOAuth === true,
        scopes: formData.oauthScopes,
        clientId: formData.clientId,
        clientSecret: formData.clientSecret,
      },
    });
  };

  const handleUpdate = async (
    originalServerId: string,
    formData: ServerFormData,
    skipAutoConnect?: boolean,
  ) => {
    const current = servers.find((s) => s.id === originalServerId);
    if (!current) return;
    if (
      Object.values(serversById).some(
        (server) =>
          server.id !== originalServerId && server.name === formData.name.trim(),
      )
    ) {
      throw new Error(`A server named "${formData.name}" already exists.`);
    }

    if (skipAutoConnect) {
      await disconnectServer(originalServerId);
      return;
    }

    await connectServer({
      id: originalServerId,
      name: formData.name,
      url: formData.url ?? current.url,
      transport: "streamable-http",
      headers: formData.headers,
      oauth: {
        enabled: formData.useOAuth === true,
        scopes: formData.oauthScopes,
        clientId: formData.clientId,
        clientSecret: formData.clientSecret,
      },
    });
  };

  const handleEditServer = (server: ServerWithName) => {
    setServerToEdit(server);
    setIsEditingServer(true);
  };

  const handleCloseEditModal = () => {
    setIsEditingServer(false);
    setServerToEdit(null);
  };

  const handleJsonImport = (importedServers: ServerFormData[]) => {
    importedServers.forEach((server) => {
      void handleConnect(server).catch((error) => {
        toast.error(error instanceof Error ? error.message : "Connection failed");
      });
    });
  };

  const renderServerActionsMenu = () => (
    <HoverCard
      open={isActionMenuOpen}
      onOpenChange={setIsActionMenuOpen}
      openDelay={150}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <Button
          size="sm"
          onClick={() => {
            setIsAddingServer(true);
            setIsActionMenuOpen(false);
          }}
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
            onClick={() => {
              setIsAddingServer(true);
              setIsActionMenuOpen(false);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            Add manually
          </Button>
          <Button
            variant="ghost"
            className="justify-start"
            onClick={() => {
              setIsImportingJson(true);
              setIsActionMenuOpen(false);
            }}
          >
            <FileText className="h-4 w-4 mr-2" />
            Import JSON
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );

  const connectedCount = Object.values(serversById).filter(
    (s) => s.connectionStatus === "connected",
  ).length;

  return (
    <div className="h-full flex flex-col">
      <div className="space-y-6 p-8 h-full overflow-auto">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Server Connections</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {connectedCount} connected / {allIds.length} total
            </p>
          </div>
          <div className="flex items-center gap-2">{renderServerActionsMenu()}</div>
        </div>

        {allIds.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext items={orderedServerIds} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-1 lg:grid-cols-1 xl:grid-cols-2 gap-6">
                {orderedServerIds.map((id) => {
                  const server = serversById[id];
                  if (!server) return null;
                  return (
                    <SortableServerCard
                      key={id}
                      id={id}
                      server={server}
                      manager={manager}
                      onDisconnect={(serverId) => {
                        void disconnectServer(serverId);
                      }}
                      onReconnect={(serverId, _opts) => {
                        void reconnectServer(serverId);
                      }}
                      onEdit={handleEditServer}
                      onRemove={(serverId) => {
                        void removeServer(serverId);
                      }}
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
                    manager={manager}
                    onDisconnect={() => {}}
                    onReconnect={() => {}}
                    onEdit={() => {}}
                    onRemove={() => {}}
                  />
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : (
          <Card className="p-12 text-center">
            <div className="mx-auto max-w-sm">
              <MCPIcon className="mx-auto h-12 w-12 text-muted-foreground" />
              <h3 className="mt-4 text-lg font-semibold">No servers configured</h3>
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
        )}
      </div>

      <AddServerModal
        isOpen={isAddingServer}
        onClose={() => setIsAddingServer(false)}
        onSubmit={handleConnect}
      />

      {serverToEdit && (
        <EditServerModal
          isOpen={isEditingServer}
          onClose={handleCloseEditModal}
          onSubmit={(formData, originalServerId, skipAutoConnect) =>
            handleUpdate(originalServerId, formData, skipAutoConnect)
          }
          server={serverToEdit}
          existingServerNames={Object.values(serversById).map((s) => s.name)}
        />
      )}

      <JsonImportModal
        isOpen={isImportingJson}
        onClose={() => setIsImportingJson(false)}
        onImport={handleJsonImport}
      />
    </div>
  );
}
