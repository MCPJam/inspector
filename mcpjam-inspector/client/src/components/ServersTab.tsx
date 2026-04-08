import { useCallback, useEffect, useMemo, useState } from "react";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import {
  Plus,
  FileText,
  Package,
  ArrowRight,
  Loader2,
  BadgeCheck,
  Star,
  ChevronDown,
  ChevronRight,
  MonitorSmartphone,
  MessageSquareText,
} from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import {
  useRegistryServers,
  getRegistryServerName,
  type EnrichedRegistryCatalogCard,
  type EnrichedRegistryServer,
} from "@/hooks/useRegistryServers";
import { formatRegistryStarCount } from "@/lib/format-registry-star-count";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./ui/hover-card";
import { BILLING_GATES, useWorkspaceBillingGate } from "@/lib/billing-gates";
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
import {
  readInspectionDetailRequest,
  clearInspectionDetailRequest,
} from "@/lib/inspection-detail-request";
import { cn } from "@/lib/utils";
import { compareQuickConnectCatalogCards } from "@/lib/quick-connect-catalog-sort";
import { toast } from "sonner";

const ORDER_STORAGE_KEY = "mcp-server-order";

function variantIsAlreadyInWorkspaceForQuickConnect(
  v: EnrichedRegistryServer,
  workspaceServers: Record<string, ServerWithName>,
  pendingQuickConnect: PendingQuickConnectState | null,
  isPendingQuickConnectVisible: boolean,
): boolean {
  const name = getRegistryServerName(v);
  const ws = workspaceServers[name];
  if (!ws) return false;

  const isThisPendingQuickConnect =
    isPendingQuickConnectVisible &&
    pendingQuickConnect?.sourceTab === "servers" &&
    (v._id === pendingQuickConnect.registryServerId ||
      name === pendingQuickConnect.serverName) &&
    (ws.connectionStatus === "oauth-flow" ||
      ws.connectionStatus === "connecting");

  if (isThisPendingQuickConnect) {
    return false;
  }

  return true;
}

/** True if this catalog card should not appear in Quick Connect (already in workspace). */
function isQuickConnectCardExcludedByWorkspace(
  card: EnrichedRegistryCatalogCard,
  workspaceServers: Record<string, ServerWithName>,
  pendingQuickConnect: PendingQuickConnectState | null,
  isPendingQuickConnectVisible: boolean,
): boolean {
  return card.variants.some((v) =>
    variantIsAlreadyInWorkspaceForQuickConnect(
      v,
      workspaceServers,
      pendingQuickConnect,
      isPendingQuickConnectVisible,
    ),
  );
}

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

function ServersQuickConnectMiniCard({
  card,
  pendingQuickConnect,
  pendingPhaseLabel,
  onConnect,
}: {
  card: EnrichedRegistryCatalogCard;
  pendingQuickConnect: PendingQuickConnectState | null;
  pendingPhaseLabel: string;
  onConnect: (server: EnrichedRegistryServer) => void | Promise<void>;
}) {
  const first = card.variants[0];
  const isPublisherVerified = card.variants.some(
    (v) => v.publishStatus === "verified",
  );
  const isPending =
    pendingQuickConnect?.sourceTab === "servers" &&
    card.variants.some(
      (v) =>
        v._id === pendingQuickConnect.registryServerId ||
        getRegistryServerName(v) === pendingQuickConnect.serverName,
    );

  const description = first.description?.trim() ?? "";
  const descLine =
    description.length > 140 ? `${description.slice(0, 137)}…` : description;

  const connectControl = card.hasDualType ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 gap-1 border-orange-200/70 bg-orange-50/50 px-2.5 text-xs font-medium text-orange-950 shadow-none dark:border-orange-800/50 dark:bg-orange-950/35 dark:text-orange-100/95 hover:border-orange-300/90 hover:bg-orange-100/60 hover:text-orange-950 dark:hover:border-orange-700/60 dark:hover:bg-orange-900/45 dark:hover:text-orange-50"
          disabled={isPending}
          aria-label={`Connect ${first.displayName}`}
          data-testid="connect-dropdown-trigger"
        >
          {isPending ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="max-w-28 truncate">{pendingPhaseLabel}</span>
            </>
          ) : (
            <>
              Connect
              <ChevronDown className="h-3 w-3 opacity-80 text-orange-800/80 dark:text-orange-200/90" />
            </>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {card.variants.map((v) => (
          <DropdownMenuItem
            key={v._id}
            disabled={isPending}
            onClick={() => void onConnect(v)}
          >
            {v.clientType === "app" ? (
              <MonitorSmartphone className="h-3.5 w-3.5 mr-2 text-blue-400" />
            ) : (
              <MessageSquareText className="h-3.5 w-3.5 mr-2 text-violet-400" />
            )}
            Connect as {v.clientType === "app" ? "App" : "Text"}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : (
    <Button
      size="sm"
      variant="outline"
      className="h-7 shrink-0 border-orange-200/70 bg-orange-50/50 px-2.5 text-xs font-medium text-orange-950 shadow-none dark:border-orange-800/50 dark:bg-orange-950/35 dark:text-orange-100/95 hover:border-orange-300/90 hover:bg-orange-100/60 hover:text-orange-950 dark:hover:border-orange-700/60 dark:hover:bg-orange-900/45 dark:hover:text-orange-50"
      disabled={isPending}
      onClick={() => void onConnect(first)}
      aria-label={`Connect ${first.displayName}`}
    >
      {isPending ? (
        <>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {pendingPhaseLabel}
        </>
      ) : (
        "Connect"
      )}
    </Button>
  );

  return (
    <div
      className="min-w-[280px] max-w-[340px] shrink-0 rounded-lg border border-border/50 bg-muted/15 text-card-foreground p-3 flex flex-col gap-2"
      data-testid="servers-quick-connect-mini-card"
    >
      <div className="flex gap-3 items-start">
        {first.iconUrl ? (
          <img
            src={first.iconUrl}
            alt=""
            className="h-9 w-9 rounded-md object-contain shrink-0"
          />
        ) : (
          <div className="h-9 w-9 rounded-md bg-muted/80 flex items-center justify-center shrink-0">
            <Package className="h-4 w-4 text-muted-foreground" />
          </div>
        )}
        <div className="min-w-0 flex-1 flex flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 flex flex-col gap-1">
              <h4 className="text-sm font-medium leading-snug text-foreground line-clamp-2">
                {first.displayName}
              </h4>
              <div className="flex min-h-5 max-w-full flex-nowrap items-center gap-2 text-[11px] leading-tight text-muted-foreground">
                <span className="min-w-0 shrink truncate font-normal">
                  {first.publisher ?? "—"}
                </span>
                {isPublisherVerified ? (
                  <span
                    className="inline-flex shrink-0"
                    title="Verified publisher"
                  >
                    <BadgeCheck
                      className="h-3.5 w-3.5 shrink-0 [&>path:first-of-type]:fill-orange-500 [&>path:first-of-type]:stroke-none [&>path:last-of-type]:stroke-white [&>path:last-of-type]:stroke-[2.5] [&>path:last-of-type]:[stroke-linecap:round] [&>path:last-of-type]:[stroke-linejoin:round]"
                      aria-label="Verified publisher"
                    />
                  </span>
                ) : null}
                <span
                  className="inline-flex shrink-0 items-center gap-0.5 tabular-nums text-muted-foreground"
                  aria-label={`${formatRegistryStarCount(card.starCount)} stars`}
                >
                  <Star className="h-3 w-3 shrink-0 text-amber-400/80 fill-amber-400/30 pointer-events-none" />
                  {formatRegistryStarCount(card.starCount)}
                </span>
              </div>
            </div>
            <div className="shrink-0 pt-px">{connectControl}</div>
          </div>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground line-clamp-2">
        {descLine || "—"}
      </p>
    </div>
  );
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
  workspaceId,
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
  workspaceId: string;
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
        workspaceId={workspaceId}
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
  isRegistryEnabled?: boolean;
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
  isRegistryEnabled = false,
  onNavigateToRegistry,
}: ServersTabProps) {
  const posthog = usePostHog();
  const { isAuthenticated } = useConvexAuth();
  const [pendingQuickConnect, setPendingQuickConnect] =
    useState<PendingQuickConnectState | null>(() => readPendingQuickConnect());
  const registryWorkspaceId =
    workspaces[activeWorkspaceId]?.sharedWorkspaceId ?? null;

  const {
    catalogCards,
    isLoading: isRegistryCatalogLoading,
    connect: connectRegistryServer,
  } = useRegistryServers({
    enabled: isRegistryEnabled,
    workspaceId: registryWorkspaceId,
    isAuthenticated,
    liveServers: workspaceServers,
    onConnect,
  });

  const [quickConnectMiniCardsExpanded, setQuickConnectMiniCardsExpanded] =
    useState(() => Object.keys(workspaceServers).length <= 2);

  // Billing gate for server creation
  const serverCreationGate = useWorkspaceBillingGate({
    workspaceId: registryWorkspaceId,
    gate: BILLING_GATES.serverCreation,
  });

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

  // Consume inspection detail request (from toast "View changes" CTA)
  useEffect(() => {
    if (detailModalState.isOpen) return;

    const request = readInspectionDetailRequest();
    if (!request) return;

    clearInspectionDetailRequest();

    const server = workspaceServers[request.serverName];
    if (!server) return;

    setDetailModalState((prev) => ({
      isOpen: true,
      serverName: server.name,
      defaultTab: "overview",
      sessionKey: prev.sessionKey + 1,
      serverSnapshot: server,
    }));
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

  const featuredQuickConnectCards = useMemo(() => {
    return [...catalogCards]
      .sort(compareQuickConnectCatalogCards)
      .filter(
        (card) =>
          !isQuickConnectCardExcludedByWorkspace(
            card,
            workspaceServers,
            pendingQuickConnect,
            isPendingQuickConnectVisible,
          ),
      )
      .slice(0, 4);
  }, [
    catalogCards,
    workspaceServers,
    pendingQuickConnect,
    isPendingQuickConnectVisible,
  ]);

  const quickConnectCatalogAvailableCount = featuredQuickConnectCards.length;

  const totalServerCards = connectedCount;
  /** Compact header + collapsible mini-cards when many servers on the tab; full module when ≤2 or pending OAuth. */
  const isQuickConnectMinimized =
    totalServerCards > 2 && !isPendingQuickConnectVisible;

  useEffect(() => {
    if (totalServerCards > 2) {
      setQuickConnectMiniCardsExpanded(false);
    } else {
      setQuickConnectMiniCardsExpanded(true);
    }
  }, [totalServerCards]);

  const shouldShowQuickConnect =
    isRegistryEnabled &&
    (isRegistryCatalogLoading ||
      quickConnectCatalogAvailableCount > 0 ||
      isPendingQuickConnectVisible);

  const shouldShowBrowseRegistryOnly =
    isRegistryEnabled &&
    !shouldShowQuickConnect &&
    quickConnectCatalogAvailableCount > 0;

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

  const handleQuickConnect = async (server: EnrichedRegistryServer) => {
    const serverName = getRegistryServerName(server);
    const nextPendingQuickConnect: PendingQuickConnectState = {
      serverName,
      registryServerId: server._id,
      displayName: server.displayName,
      sourceTab: "servers",
      createdAt: Date.now(),
    };
    writePendingQuickConnect(nextPendingQuickConnect);
    setPendingQuickConnect(nextPendingQuickConnect);
    try {
      await connectRegistryServer(server);
    } catch {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
  };

  const handleAddServerClick = () => {
    if (serverCreationGate.isDenied) {
      toast.error(
        serverCreationGate.denialMessage ??
          "Upgrade required to add more servers",
      );
      return;
    }
    posthog.capture("add_server_button_clicked", {
      location: "servers_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    setIsAddingServer(true);
    setIsActionMenuOpen(false);
  };

  const handleImportJsonClick = () => {
    if (serverCreationGate.isDenied) {
      toast.error(
        serverCreationGate.denialMessage ??
          "Upgrade required to add more servers",
      );
      return;
    }
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

  const renderQuickConnectSection = () => {
    if (!shouldShowQuickConnect) return null;

    const minimized = isQuickConnectMinimized;
    const hasMiniCardContent =
      isRegistryCatalogLoading || featuredQuickConnectCards.length > 0;
    const showMiniCardsRow =
      hasMiniCardContent && (!minimized || quickConnectMiniCardsExpanded);
    const featuredCount = featuredQuickConnectCards.length;
    const featuredCountForLabel =
      isRegistryCatalogLoading && featuredCount === 0 ? null : featuredCount;

    return (
      <div
        className={cn(
          "rounded-lg border border-border/50 bg-muted/15",
          minimized ? "space-y-2 p-2" : "space-y-3 p-3",
        )}
        data-testid="servers-quick-connect-section"
        data-minimized={minimized ? "true" : undefined}
      >
        <div
          className={cn(
            minimized
              ? "flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2"
              : "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3",
          )}
        >
          {minimized ? (
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
              <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Quick Connect
              </span>
              {hasMiniCardContent ? (
                <button
                  type="button"
                  className={cn(
                    "group inline-flex max-w-full items-center gap-1 rounded-md border border-border/40 bg-muted/10 px-1.5 py-1 text-left",
                    "text-[11px] font-semibold uppercase tracking-wide text-primary underline-offset-4 hover:underline",
                    "transition-colors hover:border-border/60 hover:bg-muted/25",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  )}
                  aria-expanded={quickConnectMiniCardsExpanded}
                  onClick={() =>
                    setQuickConnectMiniCardsExpanded((open) => !open)
                  }
                  data-testid="servers-quick-connect-mini-cards-toggle"
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 shrink-0 text-current opacity-90 transition-transform duration-200 group-hover:opacity-100",
                      quickConnectMiniCardsExpanded && "rotate-90",
                    )}
                    aria-hidden
                  />
                  <span className="whitespace-nowrap">
                    {isRegistryCatalogLoading && featuredCount === 0 ? (
                      <>Loading…</>
                    ) : featuredCountForLabel != null ? (
                      quickConnectMiniCardsExpanded ? (
                        <>Hide ({featuredCountForLabel})</>
                      ) : (
                        <>Show ({featuredCountForLabel})</>
                      )
                    ) : (
                      <>Show</>
                    )}
                  </span>
                </button>
              ) : null}
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Quick Connect
              </h3>
            </div>
          )}
          {onNavigateToRegistry ? (
            <Button
              variant="link"
              size="sm"
              className={cn(
                "h-auto shrink-0 p-0 text-xs",
                minimized ? "self-center" : "self-start",
              )}
              onClick={onNavigateToRegistry}
              data-testid="servers-quick-connect-browse-registry"
            >
              Browse Registry
              <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          ) : null}
        </div>
        {isPendingQuickConnectVisible && pendingQuickConnect && (
          <Card className="border-blue-500/30 bg-blue-500/5 px-3 py-2.5">
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
        {showMiniCardsRow ? (
          <div className="flex gap-2 overflow-x-auto pb-0.5">
            {isRegistryCatalogLoading && featuredQuickConnectCards.length === 0
              ? Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className="min-w-[280px] h-[152px] shrink-0 rounded-lg"
                  />
                ))
              : featuredQuickConnectCards.map((card) => (
                  <ServersQuickConnectMiniCard
                    key={card.registryCardKey}
                    card={card}
                    pendingQuickConnect={pendingQuickConnect}
                    pendingPhaseLabel={pendingQuickConnectPhaseLabel}
                    onConnect={handleQuickConnect}
                  />
                ))}
          </div>
        ) : null}
      </div>
    );
  };

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
              {shouldShowBrowseRegistryOnly && onNavigateToRegistry ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="cursor-pointer"
                  onClick={onNavigateToRegistry}
                  data-testid="servers-tab-browse-registry-header-fallback"
                >
                  Browse Registry
                  <ArrowRight className="h-3.5 w-3.5 ml-1" />
                </Button>
              ) : null}
              {renderServerActionsMenu()}
            </div>
          </div>

          {renderQuickConnectSection()}

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
                      onDisconnect={(serverName) => {
                        clearPendingQuickConnectIfMatches(serverName);
                        onDisconnect(serverName);
                      }}
                      onReconnect={onReconnect}
                      onRemove={(serverName) => {
                        clearPendingQuickConnectIfMatches(serverName);
                        onRemove(serverName);
                      }}
                      hostedServerId={sharedWorkspaceServersRecord[name]?._id}
                      onOpenDetailModal={handleOpenDetailModal}
                      workspaceId={activeWorkspaceId}
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
                      sharedWorkspaceServersRecord[activeId!]?._id
                    }
                    workspaceId={activeWorkspaceId}
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
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-2">
          {shouldShowBrowseRegistryOnly && onNavigateToRegistry ? (
            <Button
              variant="outline"
              size="sm"
              className="cursor-pointer"
              onClick={onNavigateToRegistry}
              data-testid="servers-tab-browse-registry-header-fallback"
            >
              Browse Registry
              <ArrowRight className="h-3.5 w-3.5 ml-1" />
            </Button>
          ) : null}
          {renderServerActionsMenu()}
        </div>
      </div>

      {renderQuickConnectSection()}

      {/* Empty State */}
      <Card className="p-12 text-center">
        <div className="mx-auto max-w-sm">
          <MCPIcon className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">No servers connected</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Get started by connecting to your first MCP server
          </p>
          <Button
            onClick={handleAddServerClick}
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
        : hasAnyServers
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
