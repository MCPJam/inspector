import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Card } from "@mcpjam/design-system/card";
import { Button } from "@mcpjam/design-system/button";
import { Switch } from "@mcpjam/design-system/switch";
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
import type {
  PendingDashboardOAuthState,
  ServerUpdateResult,
  ServerWithName,
} from "@/hooks/use-app-state";
import { ServerConnectionCard } from "./connection/ServerConnectionCard";
import { AddServerModal } from "./connection/AddServerModal";
import {
  ServerDetailModal,
  type ServerDetailTab,
} from "./connection/ServerDetailModal";
import { ActiveMcpProfileProvider } from "@/contexts/active-mcp-profile-context";

import { JsonImportModal } from "./connection/JsonImportModal";
import { AddPluginModal } from "./plugins/AddPluginModal";
import { PluginsSection } from "./plugins/PluginsSection";
import {
  permalinkUnavailableMessage,
  resolvePermalinkTarget,
} from "@/lib/permalink-target";
import { usePluginsEnabled } from "@/hooks/usePluginsEnabled";
import { ServerFormData } from "@/shared/types.js";
import {
  createInspectorCommandClientError,
  registerInspectorCommandHandler,
} from "@/lib/inspector-command-handlers";
import type {
  AddServerInspectorCommand,
  OpenServerFormInspectorCommand,
} from "@/shared/inspector-command.js";
import {
  serverDraftToFormData,
  serverDraftToPrefill,
} from "@/lib/webmcp/server-draft-adapter";
import { waitForUiCommit } from "@/lib/wait-for-ui-commit";
import { useAppReady, useAppReadyMessage } from "@/hooks/use-app-ready";
import { MCPIcon } from "./ui/mcp-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import {
  useRegistryServers,
  getRegistryServerName,
  type EnrichedRegistryCatalogCard,
  type EnrichedRegistryServer,
} from "@/hooks/useRegistryServers";
import { formatRegistryStarCount } from "@/lib/format-registry-star-count";
import {
  useOrgRegistryServers,
  type OrgRegistrySubmission,
} from "@/hooks/useOrgRegistryServers";
import {
  OrgRegistryServerDialog,
  type OrgRegistryDialogSeed,
} from "./registry/OrgRegistryServerDialog";
import { track } from "@/lib/analytics";
import { reportCaught } from "@/lib/error-reporting";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@mcpjam/design-system/hover-card";
import { BILLING_GATES, useProjectBillingGate } from "@/lib/billing-gates";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { CollapsedPanelStrip } from "./ui/collapsed-panel-strip";
import { LoggerView } from "./logger-view";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { ServersLoadingSkeleton } from "@mcpjam/design-system/servers-loading-skeleton";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import {
  applyMcpProtocolVersionOverride,
  type ProjectServerConfigDto,
  type ProjectServerConfigInput,
} from "@/lib/project-server-config";
import type { McpProtocolVersion } from "@/lib/client-config-v2";
import {
  resetAutoConnectAttempts,
  useAutoConnectProjectServers,
} from "@/hooks/useAutoConnectProjectServers";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { useHost } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useProjectServers as useViewProjectServers } from "@/hooks/useViews";
import { Project } from "@/state/app-types";
import {
  clearPendingQuickConnect,
  readPendingQuickConnect,
  writePendingQuickConnect,
  type PendingQuickConnectState,
} from "@/lib/quick-connect-pending";
import {
  useProjectServers as useRemoteProjectServers,
  useProjectMembers,
  useServerMutations,
  shouldQueryProjectId,
  type RemoteServer,
} from "@/hooks/useProjects";
import { projectClientCapabilitiesNeedReconnect } from "@/lib/client-config";
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
import { cn } from "@/lib/utils";
import { HostsConnectAddServerSlotContext } from "./hosts/HostsConnectAddServerSlotContext";
import { useHostsConnectViewPhase } from "./hosts/HostsConnectViewPhaseContext";
import {
  SERVER_CARD_LAYOUT_ID,
  SNAPPY_CAMERA,
  SNAPPY_RAIL,
} from "./hosts/transition-tokens";
import { compareQuickConnectCatalogCards } from "@/lib/quick-connect-catalog-sort";
import { toast } from "@/lib/toast";

const ORDER_STORAGE_KEY = "mcp-server-order";
const LOGGER_FOCUS_STORAGE_KEY = "mcp-server-logger-focus";
const LOGGER_FOCUS_TTL_MS = 15 * 60 * 1000;

interface PersistedLoggerFocus {
  projectId: string;
  serverName: string;
  sinceTimestamp: number;
}

function variantIsAlreadyInProjectForQuickConnect(
  v: EnrichedRegistryServer,
  projectServers: Record<string, ServerWithName>,
  pendingQuickConnect: PendingQuickConnectState | null,
  isPendingQuickConnectVisible: boolean
): boolean {
  const name = getRegistryServerName(v);
  const ws = projectServers[name];
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

/** True if this catalog card should not appear in Quick Connect (already in project). */
function isQuickConnectCardExcludedByProject(
  card: EnrichedRegistryCatalogCard,
  projectServers: Record<string, ServerWithName>,
  pendingQuickConnect: PendingQuickConnectState | null,
  isPendingQuickConnectVisible: boolean
): boolean {
  return card.variants.some((v) =>
    variantIsAlreadyInProjectForQuickConnect(
      v,
      projectServers,
      pendingQuickConnect,
      isPendingQuickConnectVisible
    )
  );
}

function loadServerOrder(projectId: string): string[] | undefined {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    return raw ? JSON.parse(raw)[projectId] : undefined;
  } catch {
    return undefined;
  }
}

function saveServerOrder(projectId: string, orderedNames: string[]): void {
  try {
    const raw = localStorage.getItem(ORDER_STORAGE_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[projectId] = orderedNames;
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}

function clearPersistedLoggerFocus(): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    sessionStorage.removeItem(LOGGER_FOCUS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readPersistedLoggerFocus(
  projectId: string
): PersistedLoggerFocus | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = sessionStorage.getItem(LOGGER_FOCUS_STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<PersistedLoggerFocus> | null;
    if (
      !parsed ||
      typeof parsed.projectId !== "string" ||
      typeof parsed.serverName !== "string" ||
      typeof parsed.sinceTimestamp !== "number"
    ) {
      clearPersistedLoggerFocus();
      return null;
    }

    if (Date.now() - parsed.sinceTimestamp > LOGGER_FOCUS_TTL_MS) {
      clearPersistedLoggerFocus();
      return null;
    }

    if (parsed.projectId !== projectId) {
      return null;
    }

    return {
      projectId: parsed.projectId,
      serverName: parsed.serverName,
      sinceTimestamp: parsed.sinceTimestamp,
    };
  } catch {
    clearPersistedLoggerFocus();
    return null;
  }
}

function writePersistedLoggerFocus(input: PersistedLoggerFocus): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    sessionStorage.setItem(LOGGER_FOCUS_STORAGE_KEY, JSON.stringify(input));
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
    (v) => v.publishStatus === "verified"
  );
  const isPending =
    pendingQuickConnect?.sourceTab === "servers" &&
    card.variants.some(
      (v) =>
        v._id === pendingQuickConnect.registryServerId ||
        getRegistryServerName(v) === pendingQuickConnect.serverName
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
                  aria-label={`${formatRegistryStarCount(
                    card.starCount
                  )} stars`}
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
  ...cardProps
}: {
  id: string;
  dndDisabled: boolean;
} & ComponentProps<typeof ServerConnectionCard>) {
  // Every card prop is forwarded by rest-spread rather than re-listed. The
  // hand-written list this replaces silently dropped anything the caller
  // added but the list did not know about — which is exactly what happened
  // to the auto-connect opt-out: the grid passed it, this wrapper ate it,
  // and the action appeared only on cards in the collapsed "needs
  // attention" section, which renders ServerConnectionCard directly.
  const { hostedServerId } = cardProps;
  const { listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id, disabled: dndDisabled });
  const viewPhase = useHostsConnectViewPhase();
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

  // When the server has a Convex id, share layout with the ReactFlow pill of
  // the same server in the Host canvas so the Servers→Host swap morphs cards
  // into pills 1:1 instead of crossfading. Without an id (server not yet
  // persisted) we fall back to a plain div so the rest of the grid still
  // renders.
  const cardContent = (
    <ServerConnectionCard {...cardProps} />
  );

  return (
    <div ref={setNodeRef} style={style} {...dragListeners}>
      {hostedServerId ? (
        // Outer box owns the size+position morph (layout); inner wrapper
        // fades the heavy ServerConnectionCard UI out *before* the size
        // morph reveals it warping. Mirrors the demo's CSS approach where
        // toggle/menu/copy collapse to opacity 0 during the camera move.
        <motion.div
          layoutId={SERVER_CARD_LAYOUT_ID(hostedServerId)}
          layout
          transition={SNAPPY_CAMERA}
          className="h-full overflow-hidden rounded-xl"
        >
          <motion.div
            initial={false}
            animate={{ opacity: viewPhase === "servers" ? 1 : 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            className="h-full"
          >
            {cardContent}
          </motion.div>
        </motion.div>
      ) : (
        cardContent
      )}
    </div>
  );
}

interface ServersTabProps {
  projectServers: Record<string, ServerWithName>;
  pendingDashboardOAuth?: PendingDashboardOAuthState | null;
  onConnect: (formData: ServerFormData) => void;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: {
      forceOAuthFlow?: boolean;
      allowInteractiveOAuthFlow?: boolean;
    }
  ) => Promise<void>;
  onUpdate: (
    originalServerName: string,
    formData: ServerFormData,
    skipAutoConnect?: boolean
  ) => Promise<ServerUpdateResult>;
  onRemove: (serverName: string) => void;
  /** Save a server config without connecting — backs `ui_add_server`. */
  onSaveServerConfig: (formData: ServerFormData) => Promise<boolean>;
  projects: Record<string, Project>;
  activeProjectId: string;
  organizationId: string | null;
  isBillingContextPending?: boolean;
  isLoadingProjects?: boolean;
  isAuthHydrating?: boolean;
  areServersHydrated?: boolean;
  onProjectShared?: (sharedProjectId: string, sourceProjectId?: string) => void;
  onLeaveProject?: () => void;
  /**
   * The saved server named by a `/servers/:serverId` permalink, if any.
   *
   * A HOSTED (Convex) server id, not a name: a permalink has to survive a
   * rename, and the id is what an agent returned. Resolved against the
   * project's remote server rows below.
   */
  routeServerId?: string | null;
  /** The plugin named by a `/servers/plugins/:pluginId` permalink, if any. */
  routePluginId?: string | null;
  isRegistryEnabled?: boolean;
  onNavigateToRegistry?: () => void;
}

export function ServersTab({
  projectServers,
  pendingDashboardOAuth,
  onConnect,
  onDisconnect,
  onReconnect,
  onUpdate,
  onRemove,
  onSaveServerConfig,
  projects,
  activeProjectId,
  organizationId,
  isBillingContextPending = false,
  isLoadingProjects,
  isAuthHydrating = false,
  areServersHydrated = true,
  onProjectShared: _onProjectShared,
  routeServerId,
  routePluginId,
  isRegistryEnabled = false,
  onNavigateToRegistry,
}: ServersTabProps) {
  const hostsConnectAddServerSlot = useContext(
    HostsConnectAddServerSlotContext
  );
  const viewPhase = useHostsConnectViewPhase();
  const { isAuthenticated } = useConvexAuth();
  const { user: signedInUser } = useAuth();

  // Auto-connect the previewed host's REQUIRED servers once per host scope.
  // Mirrors the wiring on the host builder + Playground so /servers, /hosts,
  // and the Playground all behave the same way. The hook dedupes by
  // (projectId, hostScopeKey, sortedNames) so navigating between these
  // surfaces does not re-fire, but switching to a different host (or
  // saving the host's required set) re-attempts for that scope.
  //
  // Match the global host picker / HostsTab / useAppState scope: prefer
  // the shared project id (what writers use in authed cloud flows), falling
  // back to the local id for CLI / no-cloud-sync where there is no shared
  // id. Reading only `activeProjectId` here misses selections made via
  // the global host bar on a Convex-synced project.
  const sharedProjectIdForHostScope =
    projects[activeProjectId]?.sharedProjectId ?? null;
  const [previewedHostId] = usePreviewedHostId(
    sharedProjectIdForHostScope ?? activeProjectId ?? null
  );
  const { host: previewedHost } = useHost({
    isAuthenticated,
    hostId: previewedHostId,
  });
  const { servers: viewProjectServersList } = useViewProjectServers({
    projectId: sharedProjectIdForHostScope,
    isAuthenticated,
  });

  // --- Move a server to another project (kebab menu) ---
  // Server-side move keeps encrypted secret material private and avoids
  // reporting success before the source server is deleted.
  const { moveServerToProject } = useServerMutations();
  const [movingServerName, setMovingServerName] = useState<string | null>(null);

  const remoteServersByName = useMemo(() => {
    const map: Record<string, RemoteServer> = {};
    for (const s of viewProjectServersList ?? []) map[s.name] = s;
    return map;
  }, [viewProjectServersList]);

  const moveTargets = useMemo(
    () =>
      Object.values(projects)
        .filter((p) => p.id !== activeProjectId && !!p.sharedProjectId)
        .filter((p) =>
          organizationId
            ? p.organizationId === organizationId
            : !p.organizationId
        )
        .sort((a, b) => {
          if (a.isDefault) return -1;
          if (b.isDefault) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((p) => ({ id: p.id, name: p.name, icon: p.icon })),
    [projects, activeProjectId, organizationId]
  );

  const handleMoveServerToProject = useCallback(
    async (serverName: string, targetProjectId: string) => {
      const remote = remoteServersByName[serverName];
      const target = projects[targetProjectId];
      const targetSharedId = target?.sharedProjectId;
      if (!remote) {
        toast.error(`Couldn't find "${serverName}" to move.`);
        return;
      }
      if (!targetSharedId) {
        toast.error(`"${target?.name ?? "That project"}" isn't synced yet.`);
        return;
      }
      setMovingServerName(serverName);
      try {
        await moveServerToProject({
          serverId: remote._id,
          targetProjectId: targetSharedId,
        });
        await Promise.resolve(onDisconnect(serverName));
        await Promise.resolve(onRemove(serverName));
        toast.success(`Moved "${serverName}" to ${target.name}`);
      } catch (error) {
        // Keep the raw error in the console for us; users get a friendly toast.
        console.error(
          `Failed to move server "${serverName}" to "${target.name}":`,
          error
        );
        const message = error instanceof Error ? error.message : String(error);
        toast.error(
          /already exists|already has/i.test(message)
            ? `"${target.name}" already has a server named "${serverName}". Rename or remove it there first.`
            : `Couldn't move "${serverName}" to "${target.name}". Please try again.`
        );
      } finally {
        setMovingServerName(null);
      }
    },
    [remoteServersByName, projects, moveServerToProject, onDisconnect, onRemove]
  );

  // Project-wide auto-connect toggle. ON means `autoConnectMode: 'all'` —
  // the pool is the project's live catalog, so a server added later is
  // included by definition and the backend's create hook fans it out. OFF
  // means 'none' and is non-destructive: per-server headers, timeouts and
  // protocol pins live in `projectServerRefs` and are independent of
  // enrollment, so they survive and come back when it is switched on.
  //
  // This used to be DERIVED by exact set-equality between the stored
  // `serverIds` and the catalog, which made the switch lie in both
  // directions: a fresh project (empty `serverIds`) read OFF with no
  // default-on state to write, and adding one server while it was ON made
  // the sets unequal so the switch flipped to OFF while the other N
  // servers carried on auto-connecting. Reading the mode directly is what
  // retires both bugs, and with them the "toggle OFF/ON to refresh" wart.
  //
  // Permission gate: backend `projectServerConfig:setConfig` requires
  // project admin (`canManageProjectMembers`); mirror that check on the
  // client so non-admins see a disabled switch instead of an enabled
  // control that toasts an authorization error when toggled. Reading the
  // value is fine for everyone, and a non-admin who wants out has the
  // per-user kill switch below. Matches the canManageProjectSettings
  // pattern in ProjectSettingsTab.
  const { canManageMembers: canManageProjectServers } = useProjectMembers({
    isAuthenticated,
    projectId: sharedProjectIdForHostScope,
  });
  const isUserReady = useDbUserReady();
  const projectServerConfigDto = useQuery(
    "projectServerConfig:getConfig" as any,
    sharedProjectIdForHostScope && isAuthenticated && isUserReady
      ? ({ projectId: sharedProjectIdForHostScope } as any)
      : "skip"
  ) as ProjectServerConfigDto | null | undefined;
  const setProjectServerConfigMutation = useMutation(
    "projectServerConfig:setConfig" as any
  ) as unknown as (args: {
    projectId: string;
    input: ProjectServerConfigInput;
  }) => Promise<ProjectServerConfigDto>;
  const [isTogglingAutoConnect, setIsTogglingAutoConnect] = useState(false);
  // Per-user, per-browser opt-out (localStorage `mcpjam-auto-connect-servers`).
  // This is the hook's own gate, so flipping it stops auto-connect for this
  // person without touching the project setting.
  const autoConnectServersEnabled = usePreferencesStore(
    (s) => s.autoConnectServersEnabled
  );
  const setAutoConnectServersEnabled = usePreferencesStore(
    (s) => s.setAutoConnectServersEnabled
  );
  const catalogServerIds = useMemo(
    () => (viewProjectServersList ?? []).map((s) => s._id),
    [viewProjectServersList]
  );
  // A direct read of the stored intent. No set arithmetic, so the switch
  // cannot disagree with what the project is actually doing. A project
  // that has never been configured reads 'all' from the backend's
  // normalization, which is what makes auto-connect on by default.
  const autoConnectAll = projectServerConfigDto
    ? projectServerConfigDto.autoConnectMode !== "none"
    : true;
  const handleToggleAutoConnect = useCallback(
    async (next: boolean) => {
      if (!sharedProjectIdForHostScope) return;
      setIsTogglingAutoConnect(true);
      // Treat an explicit project toggle like a fresh host transition so the
      // current host re-runs reconciliation instead of reusing stale attempts.
      resetAutoConnectAttempts(activeProjectId);
      resetAutoConnectAttempts(sharedProjectIdForHostScope);
      try {
        // Overrides pass through UNCHANGED in both directions. Turning
        // auto-connect off used to send `{serverIds: [], overrides: {}}`,
        // which deleted every stored header, timeout and protocol pin in
        // the project — because the backend rejected override keys outside
        // `serverIds`, so "no servers" had to mean "no overrides". Those
        // are decoupled now, so the switch is reversible: flip it back on
        // and the user's per-server configuration is still there.
        //
        // `serverIds` is advisory under 'all' (the backend resolves the
        // live catalog) and ignored under 'none', so there is nothing to
        // compute here.
        await setProjectServerConfigMutation({
          projectId: sharedProjectIdForHostScope,
          input: {
            serverIds: projectServerConfigDto?.serverIds ?? [],
            overrides: projectServerConfigDto?.overrides ?? {},
            autoConnectMode: next ? "all" : "none",
          },
        });
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : "Failed to update project auto-connect";
        toast.error(message);
      } finally {
        setIsTogglingAutoConnect(false);
      }
    },
    [
      activeProjectId,
      sharedProjectIdForHostScope,
      projectServerConfigDto,
      setProjectServerConfigMutation,
    ]
  );

  const renderAutoConnectToggle = () => {
    // Hide entirely when the project hasn't synced or when there's no
    // catalog to toggle against. Both states make the switch
    // semantically meaningless.
    if (!sharedProjectIdForHostScope || !isAuthenticated) return null;
    if (catalogServerIds.length === 0) return null;
    if (projectServerConfigDto === undefined) return null;

    // Two independent switches, deliberately: the PROJECT setting is an
    // admin decision shared by everyone, and the per-user one is this
    // browser's own opt-out. Without the second, a non-admin who does not
    // want servers opening on load would have no way out of a
    // now-on-by-default setting they cannot change.
    //
    // The per-user switch is only offered when the project setting is on,
    // because that is the only time it decides anything — and it is shown
    // to admins too, so "stop connecting for me" doesn't require turning
    // it off for the whole team.
    const disabled = isTogglingAutoConnect || !canManageProjectServers;
    return (
      <div className="flex items-center gap-3">
        <label
          className={cn(
            "flex items-center gap-2 text-xs text-muted-foreground select-none",
            disabled ? "cursor-not-allowed" : "cursor-pointer"
          )}
          title={
            canManageProjectServers
              ? "Auto-connect every project server when a client opens"
              : "Only project admins can change auto-connect for this project"
          }
        >
          <Switch
            checked={autoConnectAll}
            disabled={disabled}
            onCheckedChange={handleToggleAutoConnect}
            aria-label="Auto-connect project servers"
          />
          <span>Auto-connect</span>
        </label>
        {autoConnectAll ? (
          <label
            className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground select-none"
            title="Applies to you, in this browser only. The project setting stays as it is."
          >
            <Switch
              checked={autoConnectServersEnabled}
              onCheckedChange={(next) => {
                setAutoConnectServersEnabled(next);
                // An explicit flip is a fresh intent: clear the attempt log
                // so turning it back on reconnects now instead of waiting
                // for the next host switch.
                resetAutoConnectAttempts(activeProjectId);
                if (sharedProjectIdForHostScope) {
                  resetAutoConnectAttempts(sharedProjectIdForHostScope);
                }
              }}
              aria-label="Auto-connect on this device"
            />
            <span>On this device</span>
          </label>
        ) : null}
      </div>
    );
  };

  const previewedHostRequiredNames = useMemo(() => {
    const requiredIds = previewedHost?.config?.serverIds ?? [];
    if (requiredIds.length === 0 || !viewProjectServersList) return [];
    const byId = new Map(
      viewProjectServersList.map((s) => [s._id, s.name] as const)
    );
    return requiredIds
      .map((id) => byId.get(id))
      .filter((name): name is string => !!name);
  }, [previewedHost?.config?.serverIds, viewProjectServersList]);
  useAutoConnectProjectServers({
    projectId: sharedProjectIdForHostScope ?? activeProjectId ?? null,
    hostScopeKey: previewedHostId,
    requiredServerNames: previewedHostRequiredNames,
  });

  const appReady = useAppReady();
  const appReadyMessage = useAppReadyMessage();
  const isAppBootstrapping = appReady.status !== "ready";
  const [pendingQuickConnect, setPendingQuickConnect] =
    useState<PendingQuickConnectState | null>(() => readPendingQuickConnect());
  const selectedProject = projects[activeProjectId];
  const registryProjectId = selectedProject?.sharedProjectId ?? null;
  const resolvedOrganizationId = isBillingContextPending
    ? null
    : organizationId;
  const resolvedRegistryProjectId = isBillingContextPending
    ? null
    : registryProjectId;

  const {
    catalogCards,
    isLoading: isRegistryCatalogLoading,
    connect: connectRegistryServer,
  } = useRegistryServers({
    // The hand-curated catalog is retired. Keep the hook mounted so
    // connection helpers stay imported, but do not fetch those cards.
    enabled: false,
    projectId: registryProjectId,
    isAuthenticated,
    liveServers: projectServers,
    onConnect,
  });

  const [quickConnectMiniCardsExpanded, setQuickConnectMiniCardsExpanded] =
    useState(() => Object.keys(projectServers).length <= 2);

  // Billing gate for server creation
  const serverCreationGate = useProjectBillingGate({
    projectId: resolvedRegistryProjectId,
    organizationId: resolvedOrganizationId,
    gate: BILLING_GATES.serverCreation,
  });

  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const [isAddingServer, setIsAddingServer] = useState(false);
  // Prefill for an agent-opened Add-server form (`ui_open_server_form`).
  // Undefined for a hand-opened form, which starts empty as before.
  const [prefilledServerDraft, setPrefilledServerDraft] = useState<
    Partial<ServerFormData> | undefined
  >(undefined);
  const [isImportingJson, setIsImportingJson] = useState(false);
  // Connect → Add plugin (INS-2). Flag-gated behind `plugins-enabled`
  // (fail-closed); the modal itself stays MOUNTED while the flag is on so an
  // in-flight import survives closing the dialog and resumes on reopen.
  const isPluginsEnabled = usePluginsEnabled();
  const [isAddingPlugin, setIsAddingPlugin] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const persistedLoggerFocus = readPersistedLoggerFocus(activeProjectId);
  const [focusedLoggerServerIds, setFocusedLoggerServerIds] = useState<
    string[] | undefined
  >(persistedLoggerFocus ? [persistedLoggerFocus.serverName] : undefined);
  const [focusedLoggerSinceTimestamp, setFocusedLoggerSinceTimestamp] =
    useState<number | undefined>(persistedLoggerFocus?.sinceTimestamp);
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
  const allNames = useMemo(() => Object.keys(projectServers), [projectServers]);

  const [orderedServerNames, setOrderedServerNames] = useState<string[]>(() => {
    const saved = loadServerOrder(activeProjectId);
    if (saved && saved.length > 0) {
      const existing = saved.filter((n: string) => allNames.includes(n));
      const added = allNames.filter((n) => !existing.includes(n));
      return [...existing, ...added];
    }
    return allNames;
  });

  // Reconcile when servers are added/removed or project changes
  useEffect(() => {
    setOrderedServerNames((prev) => {
      const saved = loadServerOrder(activeProjectId);
      const base = saved && saved.length > 0 ? saved : prev;
      const existing = base.filter((n) => allNames.includes(n));
      const added = allNames.filter((n) => !existing.includes(n));
      return [...existing, ...added];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allNames.join(","), activeProjectId]);

  useEffect(() => {
    const persistedFocus = readPersistedLoggerFocus(activeProjectId);
    setFocusedLoggerServerIds(
      persistedFocus ? [persistedFocus.serverName] : undefined
    );
    setFocusedLoggerSinceTimestamp(persistedFocus?.sinceTimestamp);
  }, [activeProjectId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = orderedServerNames.findIndex(
        (name) => name === active.id
      );
      const newIndex = orderedServerNames.findIndex((name) => name === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(orderedServerNames, oldIndex, newIndex);
        setOrderedServerNames(newOrder);
        saveServerOrder(activeProjectId, newOrder);
      }
    }
    setActiveId(null);
  };

  /**
   * Split the grid into "fine" and "needs attention", preserving the user's
   * manual order within each.
   *
   * Status must NOT become the sort key: the grid is drag-orderable and
   * that order is persisted, so sorting by status would silently overwrite
   * an arrangement someone built by hand. Partitioning instead leaves
   * `orderedServerNames` — the stored order — completely untouched; a
   * server that recovers simply reappears in the position it always had.
   *
   * `failed` is the right predicate on its own, because the retry loop puts
   * a server back on `connecting` between attempts. So anything still
   * showing `failed` has either spent its retry budget or was never
   * retriable, which is exactly "settled, and not going to fix itself".
   * `needs-auth` deliberately stays in the main grid: it is one click from
   * working and that click is on the card.
   */
  const [attentionSectionExpanded, setAttentionSectionExpanded] =
    useState(false);
  const { gridServerNames, attentionServerNames } = useMemo(() => {
    const grid: string[] = [];
    const attention: string[] = [];
    for (const name of orderedServerNames) {
      const server = projectServers[name];
      if (!server) continue;
      if (server.connectionStatus === "failed") attention.push(name);
      else grid.push(name);
    }
    return { gridServerNames: grid, attentionServerNames: attention };
  }, [orderedServerNames, projectServers]);

  const activeServer = activeId ? projectServers[activeId] : null;
  const reconnectWarningByServerName = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(projectServers).map(([serverName, server]) => {
          // Only fires when the user edited the per-server clientCapabilities
          // override after connecting. Host-driven caps changes are handled by
          // the auto-reconciler, which disconnect/reconnects affected servers
          // on host switch — comparing against host-blended caps here just
          // produced false positives (server fresh-reconnects under the new
          // host, but the SDK strips runtime-gated caps like `elicitation`
          // when no handler is wired, so the comparator never matched).
          const override = server.config.clientCapabilities;
          const hasOverride =
            override != null &&
            typeof override === "object" &&
            !Array.isArray(override);
          const stale =
            hasOverride &&
            server.connectionStatus === "connected" &&
            server.initializationInfo?.clientCapabilities != null &&
            projectClientCapabilitiesNeedReconnect({
              desiredCapabilities: override as Record<string, unknown>,
              initializedCapabilities: server.initializationInfo
                .clientCapabilities as Record<string, unknown>,
            });
          return [serverName, stale];
        })
      ),
    [projectServers]
  );

  const detailModalLiveServer = detailModalState.serverName
    ? projectServers[detailModalState.serverName] ?? null
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

    const resumeServer = projectServers[resumeMarker.serverName];
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
  }, [detailModalState.isOpen, projectServers]);

  useEffect(() => {
    track("servers_tab_viewed", {
      location: "servers_tab",
      num_servers: Object.keys(projectServers).length,
    });
  }, []);

  useEffect(() => {
    if (pendingQuickConnect?.sourceTab !== "servers") {
      return;
    }

    const pendingServer = projectServers[pendingQuickConnect.serverName];
    if (!pendingServer) {
      return;
    }

    // Terminal outcomes clear the quick-connect marker — `needs-auth`
    // among them, since the connect attempt has finished and only the user
    // can move it further.
    if (
      pendingServer.connectionStatus === "connected" ||
      pendingServer.connectionStatus === "failed" ||
      pendingServer.connectionStatus === "needs-auth" ||
      pendingServer.connectionStatus === "disconnected"
    ) {
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
  }, [pendingQuickConnect, projectServers]);

  const connectedCount = Object.keys(projectServers).length;
  const pendingDashboardOAuthServer = pendingDashboardOAuth
    ? projectServers[pendingDashboardOAuth.serverName]
    : null;
  const isPendingDashboardOAuthVisible =
    !!pendingDashboardOAuth &&
    pendingDashboardOAuthServer?.connectionStatus !== "connected" &&
    pendingDashboardOAuthServer?.connectionStatus !== "failed" &&
    pendingDashboardOAuthServer?.connectionStatus !== "needs-auth";
  const hasAnyServers = connectedCount > 0;
  const shouldShowServerActionsInChrome =
    !!selectedProject && !isLoadingProjects && !isBillingContextPending;
  const showServerActionsInHostsHeader =
    hostsConnectAddServerSlot != null && shouldShowServerActionsInChrome;
  const pendingQuickConnectServer =
    pendingQuickConnect?.sourceTab === "servers"
      ? projectServers[pendingQuickConnect.serverName]
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
          !isQuickConnectCardExcludedByProject(
            card,
            projectServers,
            pendingQuickConnect,
            isPendingQuickConnectVisible
          )
      )
      .slice(0, 4);
  }, [
    catalogCards,
    projectServers,
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

  const getDisplayServer = useCallback(
    (server: ServerWithName): ServerWithName => {
      if (
        !isPendingDashboardOAuthVisible ||
        pendingDashboardOAuth?.serverName !== server.name ||
        server.connectionStatus === "connected" ||
        server.connectionStatus === "failed" ||
        server.connectionStatus === "needs-auth"
      ) {
        return server;
      }

      return {
        ...server,
        connectionStatus: "connecting",
        enabled: true,
      };
    },
    [isPendingDashboardOAuthVisible, pendingDashboardOAuth?.serverName]
  );

  const shouldShowQuickConnect =
    isRegistryEnabled &&
    (isRegistryCatalogLoading ||
      quickConnectCatalogAvailableCount > 0 ||
      isPendingQuickConnectVisible);

  const shouldShowBrowseRegistryOnly =
    isRegistryEnabled &&
    !shouldShowQuickConnect &&
    quickConnectCatalogAvailableCount > 0;

  const activeProject = projects[activeProjectId];
  const sharedProjectId = activeProject?.sharedProjectId;
  // Convex-only. Falling back to `activeProjectId` leaked a LOCAL project id
  // (a `crypto.randomUUID()` value) into `ServerDetailModal`, which passes it
  // straight to `projectServerConfig:getConfig` — a `v.id("projects")` arg.
  // The rejection throws during render and, with no route ErrorBoundary,
  // took down the whole page when opening a server's Config. Null here is
  // what every other project-scoped Convex consumer expects for local mode,
  // and matches `sharedProjectIdForHostScope` on the Add Server modal.
  const hostedProjectId = sharedProjectId ?? null;
  const {
    serversRecord: sharedProjectServersRecord,
    // The RAW array, which is `undefined` until the query settles. The record
    // beside it is `{}` in that state AND for a project with no servers, so it
    // cannot tell "still loading" from "loaded, empty" — and a permalink
    // resolved against the empty one flashes the deleted-or-forbidden notice
    // before the target arrives.
    servers: sharedProjectServers,
  } = useRemoteProjectServers({
    projectId: sharedProjectId ?? null,
    isAuthenticated,
  });

  // ── Permalink targets ──────────────────────────────────────────────
  //
  // `/servers/:serverId` and `/servers/plugins/:pluginId` are exact
  // addresses an agent hands to a human. Resolving them HERE, against the
  // rows this viewer can actually see, is what keeps a link to a deleted or
  // inaccessible resource from quietly rendering the collection instead —
  // the wrong-resource failure the permalink work exists to end.
  const routeServerState = resolvePermalinkTarget(
    routeServerId,
    // `undefined` until the query settles, so a cold load waits instead of
    // deciding. A project with no servers at all still answers with a real
    // empty array, which resolves to `unavailable` — the honest answer.
    isAuthenticated && hostedProjectId ? sharedProjectServers : undefined,
    (row) => row?._id
  );
  const routeServerName =
    routeServerState.kind === "found" ? routeServerState.target?.name : null;

  useEffect(() => {
    if (!routeServerName) return;
    const server = projectServers[routeServerName];
    if (!server) return;
    setDetailModalState((prev) =>
      prev.isOpen && prev.serverName === server.name
        ? prev
        : {
            isOpen: true,
            serverName: server.name,
            defaultTab: "configuration",
            sessionKey: prev.sessionKey + 1,
            serverSnapshot: server,
          }
    );
  }, [routeServerName, projectServers]);


  /**
   * PROMOTE: share a server that is already connected here on the
   * organization's shelf.
   *
   * NO PROBE. The facts are already in this browser — `initializationInfo`
   * holds what the server said during initialize, which is the same handshake
   * the paste flow's probe performs. Asking the server again would be slower
   * and no more true.
   *
   * `sourceServerId` is what makes the source project show the new entry as
   * connected: the mutation writes a provenance row pointing at THIS server,
   * so the card joins through the record rather than through the display name
   * it happens to share.
   */
  const orgRegistry = useOrgRegistryServers({
    // The SYNCED project id, not `activeProjectId`. The latter is this app's
    // own project key, which for an unsynced or local-mode project is not a
    // Convex document id at all — sending it to a Convex query (or to the
    // derive route, which forwards it to one) is not a lookup that can
    // succeed.
    projectId: sharedProjectIdForHostScope,
    enabled: isRegistryEnabled,
    isAuthenticated,
    onConnect: () => {
      /* promote never connects — the server is already here */
    },
  });
  const [orgRegistrySeed, setOrgRegistrySeed] =
    useState<OrgRegistryDialogSeed | null>(null);

  const handleShareToOrgRegistry = useCallback(
    (server: ServerWithName) => {
      const remote = sharedProjectServersRecord[server.name];
      // No Convex row means no `sourceServerId`, and the dialog reads that
      // field to decide it is a PROMOTE at all — without it the user asked to
      // share the server in front of them and would instead get a blank-slate
      // add with an unlocked URL and no provenance, so the source project
      // would never show the entry as connected. Say why instead.
      if (!remote?._id) {
        toast.error(
          `"${server.name}" hasn't finished syncing yet. Try again in a moment.`
        );
        return;
      }
      const info = server.initializationInfo as
        | { serverInfo?: { name?: string; version?: string; title?: string } }
        | undefined;
      setOrgRegistrySeed({
        displayName:
          info?.serverInfo?.title ?? info?.serverInfo?.name ?? server.name,
        url: server.config?.url ? String(server.config.url) : "",
        useOAuth: server.useOAuth,
        derived: {
          probedAt: Date.now(),
          endpointUrl: server.config?.url ? String(server.config.url) : "",
          serverName: info?.serverInfo?.name,
          serverVersion: info?.serverInfo?.version,
          authRequired: server.useOAuth === true,
        },
        sourceServerId: remote._id,
      });
    },
    [sharedProjectServersRecord]
  );

  const handleOrgRegistrySubmit = useCallback(
    async (submission: OrgRegistrySubmission) => {
      await orgRegistry.add(submission);
      toast.success("Added to your organization's registry");
    },
    [orgRegistry]
  );

  const detailModalHostedServerId = detailModalServer
    ? sharedProjectServersRecord[detailModalServer.name]?._id
    : undefined;
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
    []
  );

  const focusLoggerOnServer = useCallback(
    (serverName: string | null, sinceTimestamp = Date.now()) => {
      const normalizedServerName = serverName?.trim();
      if (!normalizedServerName) {
        return;
      }

      setFocusedLoggerServerIds([normalizedServerName]);
      setFocusedLoggerSinceTimestamp(sinceTimestamp);
      writePersistedLoggerFocus({
        projectId: activeProjectId,
        serverName: normalizedServerName,
        sinceTimestamp,
      });
    },
    [activeProjectId]
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
        const liveServer = projectServers[result.serverName];

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
    [onUpdate, projectServers]
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
    if (isAppBootstrapping) {
      toast.error(
        appReadyMessage ?? "App is still loading. Try again in a moment."
      );
      return;
    }
    servers.forEach((server) => {
      focusLoggerOnServer(server.name);
      onConnect(server);
    });
  };

  const handleConnectServer = useCallback(
    (formData: ServerFormData) => {
      if (isAppBootstrapping) {
        toast.error(
          appReadyMessage ?? "App is still loading. Try again in a moment."
        );
        return;
      }
      focusLoggerOnServer(formData.name);
      onConnect(formData);
    },
    [focusLoggerOnServer, onConnect, isAppBootstrapping, appReadyMessage]
  );

  const handleReconnectServer = useCallback(
    async (
      serverName: string,
      options?: {
        forceOAuthFlow?: boolean;
        allowInteractiveOAuthFlow?: boolean;
      }
    ) => {
      if (isAppBootstrapping) {
        toast.error(
          appReadyMessage ?? "App is still loading. Try again in a moment."
        );
        return;
      }
      focusLoggerOnServer(serverName);
      await onReconnect(serverName, options);
    },
    [focusLoggerOnServer, onReconnect, isAppBootstrapping, appReadyMessage]
  );

  // Protocol pin chosen in the Add Server modal. The pin is persisted on
  // the project layer (`projectServerConfig` overrides) keyed by the hosted
  // server row's `_id` — which doesn't exist until the add flow's Convex
  // sync lands. Stash the (name, version) pair here and let the effect
  // below apply it once the hosted row appears in `remoteServersByName`,
  // then reconnect so the pin actually takes effect on the wire (mirrors
  // the edit flow's save→reconnect behavior in `ServerDetailModal`).
  const [pendingAddProtocolPin, setPendingAddProtocolPin] = useState<{
    serverName: string;
    version: McpProtocolVersion;
  } | null>(null);
  // Guards double-fire while the async apply is in flight (the effect
  // re-runs on every reactive update of the DTO / server list).
  const isApplyingAddProtocolPinRef = useRef(false);
  useEffect(() => {
    if (!pendingAddProtocolPin) return;
    if (isApplyingAddProtocolPinRef.current) return;
    if (!sharedProjectIdForHostScope) return;
    // Wait for BOTH the hosted server row and the config DTO to hydrate —
    // `applyMcpProtocolVersionOverride` replaces the whole (serverIds,
    // overrides) pair, so writing against a still-loading DTO would wipe
    // other servers' overrides. `null` (no row yet) is a valid baseline.
    if (projectServerConfigDto === undefined) return;
    const serverId = remoteServersByName[pendingAddProtocolPin.serverName]?._id;
    if (!serverId) return;
    const { serverName, version } = pendingAddProtocolPin;
    isApplyingAddProtocolPinRef.current = true;
    void (async () => {
      try {
        await applyMcpProtocolVersionOverride({
          projectId: sharedProjectIdForHostScope,
          serverId,
          current: projectServerConfigDto,
          next: version,
          setConfig: setProjectServerConfigMutation,
        });
        // Reconnect so the just-saved pin governs the live connection.
        // Non-interactive on purpose: the add flow may already be running
        // an OAuth escalation; don't stack a second interactive flow.
        await handleReconnectServer(serverName, {
          allowInteractiveOAuthFlow: false,
        });
      } catch (err) {
        toast.error(
          err instanceof Error
            ? `Server added, but saving its protocol version failed: ${err.message}`
            : "Server added, but saving its protocol version failed."
        );
      } finally {
        isApplyingAddProtocolPinRef.current = false;
        setPendingAddProtocolPin(null);
      }
    })();
  }, [
    pendingAddProtocolPin,
    sharedProjectIdForHostScope,
    projectServerConfigDto,
    remoteServersByName,
    setProjectServerConfigMutation,
    handleReconnectServer,
  ]);

  const clearPendingQuickConnectIfMatches = useCallback(
    (serverName: string) => {
      if (pendingQuickConnect?.serverName !== serverName) {
        return;
      }
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    },
    [pendingQuickConnect]
  );

  const handleQuickConnect = async (server: EnrichedRegistryServer) => {
    if (isAppBootstrapping) {
      toast.error(
        appReadyMessage ?? "App is still loading. Try again in a moment."
      );
      return;
    }
    const serverName = getRegistryServerName(server);
    focusLoggerOnServer(serverName);
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
    } catch (err) {
      // This used to swallow the failure entirely: the pending state was
      // cleared and the user was left with a card that silently never
      // connected.
      reportCaught(err, {
        source: "registry_quick_connect",
        extra: { registryServerId: server._id },
      });
      toast.error(
        err instanceof Error
          ? err.message
          : `Failed to connect ${server.displayName ?? serverName}`
      );
      clearPendingQuickConnect();
      setPendingQuickConnect(null);
    }
  };

  const pendingLoggerServerIds = useMemo(() => {
    const pendingServerIds = new Set<string>();

    if (isPendingDashboardOAuthVisible && pendingDashboardOAuth?.serverName) {
      pendingServerIds.add(pendingDashboardOAuth.serverName);
    }

    if (isPendingQuickConnectVisible && pendingQuickConnect?.serverName) {
      pendingServerIds.add(pendingQuickConnect.serverName);
    }

    Object.entries(projectServers).forEach(([serverId, server]) => {
      if (
        server.connectionStatus === "connecting" ||
        server.connectionStatus === "oauth-flow"
      ) {
        pendingServerIds.add(serverId);
      }
    });

    return Array.from(pendingServerIds);
  }, [
    isPendingDashboardOAuthVisible,
    isPendingQuickConnectVisible,
    pendingDashboardOAuth?.serverName,
    pendingQuickConnect?.serverName,
    projectServers,
  ]);

  const loggerServerIds =
    focusedLoggerServerIds && focusedLoggerServerIds.length > 0
      ? focusedLoggerServerIds
      : pendingLoggerServerIds.length > 0
      ? pendingLoggerServerIds
      : undefined;
  const loggerSinceTimestamp = useMemo(() => {
    if (
      loggerServerIds &&
      focusedLoggerServerIds &&
      focusedLoggerSinceTimestamp
    ) {
      const focusedIds = new Set(focusedLoggerServerIds);
      if (loggerServerIds.some((serverId) => focusedIds.has(serverId))) {
        return focusedLoggerSinceTimestamp;
      }
    }

    if (
      loggerServerIds?.includes(pendingDashboardOAuth?.serverName ?? "") &&
      isPendingDashboardOAuthVisible
    ) {
      return pendingDashboardOAuth?.startedAt;
    }

    if (
      loggerServerIds?.includes(pendingQuickConnect?.serverName ?? "") &&
      isPendingQuickConnectVisible
    ) {
      return pendingQuickConnect?.createdAt;
    }

    return focusedLoggerSinceTimestamp;
  }, [
    focusedLoggerServerIds,
    focusedLoggerSinceTimestamp,
    isPendingDashboardOAuthVisible,
    isPendingQuickConnectVisible,
    loggerServerIds,
    pendingDashboardOAuth?.serverName,
    pendingDashboardOAuth?.startedAt,
    pendingQuickConnect?.createdAt,
    pendingQuickConnect?.serverName,
  ]);

  const handleAddServerClick = () => {
    if (serverCreationGate.isDenied) {
      toast.error(
        serverCreationGate.denialMessage ??
          "Upgrade required to add more servers"
      );
      return;
    }
    track("add_server_button_clicked", {
      location: "servers_tab",
    });
    setIsAddingServer(true);
    setIsActionMenuOpen(false);
  };

  // `openServerForm` AND `addServer` live HERE, not in App.tsx, because both
  // CREATE a server and so must clear `BILLING_GATES.serverCreation` — a hook
  // that only exists on this screen. The visible Add button is gated in its
  // click handler; a command that bypassed it could exceed the plan's server
  // limit. Registered while Connect is mounted; the tools navigate here first
  // and the bus's late-registration wait covers the gap.
  useEffect(() => {
    // The gate has a loading state distinct from denied. While it's still
    // resolving, the visible UI withholds the Add controls — so a command
    // must treat "still loading" as "not yet allowed" rather than racing
    // ahead of the answer.
    const assertMayCreateServer = () => {
      // App readiness first — the same guard the visible Add/connect controls
      // use (`isAppBootstrapping`). A command that saved during
      // project-provisioning could write against a project that isn't set up
      // yet; the visible UI withholds the controls until it's ready, and a
      // command must not do what the disabled button can't.
      if (isAppBootstrapping) {
        throw createInspectorCommandClientError(
          "execution_failed",
          appReadyMessage ?? "App is still loading; try again in a moment."
        );
      }
      if (serverCreationGate.isLoading) {
        throw createInspectorCommandClientError(
          "execution_failed",
          "Billing is still loading; try again in a moment."
        );
      }
      if (serverCreationGate.isDenied) {
        throw createInspectorCommandClientError(
          "execution_failed",
          serverCreationGate.denialMessage ??
            "Upgrade required to add more servers"
        );
      }
    };

    const unregisterOpen = registerInspectorCommandHandler(
      "openServerForm",
      async (rawCommand) => {
        const command = rawCommand as OpenServerFormInspectorCommand;
        assertMayCreateServer();

        // Lenient prefill: this command exists to open the form for the USER
        // to finish, so a blank or partial draft is the normal case and must
        // not be validated as a complete config. It only rejects a genuine
        // contradiction (bad transport, url+command together).
        const prefill = serverDraftToPrefill(command.payload?.draft);
        if (!prefill.ok) {
          throw createInspectorCommandClientError(
            "invalid_request",
            prefill.error
          );
        }
        setPrefilledServerDraft(prefill.prefill);
        setIsAddingServer(true);
        setIsActionMenuOpen(false);
        await waitForUiCommit();
        return { opened: true };
      }
    );

    const unregisterAdd = registerInspectorCommandHandler(
      "addServer",
      async (rawCommand) => {
        const command = rawCommand as AddServerInspectorCommand;
        assertMayCreateServer();

        const draft = command.payload?.draft;
        if (!draft?.name) {
          throw createInspectorCommandClientError(
            "invalid_request",
            "A server name is required."
          );
        }
        const built = serverDraftToFormData(draft);
        if (!built.ok) {
          throw createInspectorCommandClientError(
            "invalid_request",
            built.error
          );
        }
        // Additive means additive: refuse to overwrite an existing server.
        // Editing one is a different, destructive act that deserves its own
        // tool rather than a silent clobber here.
        if (projectServers[built.formData.name]) {
          throw createInspectorCommandClientError(
            "invalid_request",
            `A server named "${built.formData.name}" already exists. Remove it first, or pick another name.`
          );
        }

        // Save WITHOUT connecting: it's the only action-layer call that
        // reports success and can't wander into an OAuth redirect. The agent
        // connects as a separate, visible step.
        const saved = await onSaveServerConfig(built.formData);
        await waitForUiCommit();
        if (!saved) {
          throw createInspectorCommandClientError(
            "execution_failed",
            `Could not save "${built.formData.name}". The Connect screen shows why.`
          );
        }
        return { serverName: built.formData.name, saved: true };
      }
    );

    return () => {
      unregisterOpen();
      unregisterAdd();
    };
  }, [
    isAppBootstrapping,
    appReadyMessage,
    serverCreationGate.isLoading,
    serverCreationGate.isDenied,
    serverCreationGate.denialMessage,
    onSaveServerConfig,
    projectServers,
  ]);

  const handleImportJsonClick = () => {
    if (serverCreationGate.isDenied) {
      toast.error(
        serverCreationGate.denialMessage ??
          "Upgrade required to add more servers"
      );
      return;
    }
    track("import_json_button_clicked", {
      location: "servers_tab",
    });
    setIsImportingJson(true);
    setIsActionMenuOpen(false);
  };

  // Deliberately NOT behind `serverCreationGate`: importing a plugin creates
  // plugin-component servers, which are a plugin version's read-only
  // projection rather than standalone catalog servers, and the backend gates
  // import on project-admin authorization instead.
  const handleAddPluginClick = () => {
    track("add_plugin_button_clicked", { location: "servers_tab" });
    setIsAddingPlugin(true);
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
            {isPluginsEnabled ? (
              <Button
                variant="ghost"
                className="justify-start"
                onClick={handleAddPluginClick}
                data-testid="servers-tab-add-plugin"
              >
                <Package className="h-4 w-4 mr-2" />
                Add plugin
              </Button>
            ) : null}
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
          minimized ? "space-y-2 p-2" : "space-y-3 p-3"
        )}
        data-testid="servers-quick-connect-section"
        data-minimized={minimized ? "true" : undefined}
      >
        <div
          className={cn(
            minimized
              ? "flex flex-row flex-wrap items-center justify-between gap-x-3 gap-y-2"
              : "flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3"
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
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
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
                      quickConnectMiniCardsExpanded && "rotate-90"
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
                minimized ? "self-center" : "self-start"
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

  // Installed plugin GROUP cards, above the standalone server grid. Plugin
  // component servers never appear in that grid (the backend excludes
  // `lifecycleScope: 'plugin_component'` rows from the standalone list), so
  // this section is the only place their health is visible on Connect.
  const renderPluginsSection = () => {
    if (isPluginsEnabled) {
      return (
        <PluginsSection
          projectId={sharedProjectIdForHostScope}
          expandedPluginId={routePluginId ?? null}
        />
      );
    }
    // The flag is a per-viewer PostHog rollout, and `list_project_plugins` is
    // NOT flag-gated — so an agent working for someone inside the rollout can
    // hand a `/servers/plugins/:pluginId` link to someone outside it. Dropping
    // the section silently would render ordinary Connect and never mention
    // that the link went nowhere. Same message as a missing plugin: whether
    // the resource exists is not something this screen should disclose.
    if (!routePluginId) return null;
    return (
      <div
        role="status"
        data-testid="plugin-permalink-unavailable"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        {permalinkUnavailableMessage("plugin")}
      </div>
    );
  };

  /**
   * What a permalink to a gone-or-forbidden resource renders.
   *
   * Deliberately says one thing for BOTH "deleted" and "you cannot see it":
   * two messages would confirm to someone without access that the id exists.
   * Rendered ABOVE the collection rather than instead of it, so the recipient
   * can still use the screen — but never without being told the link they
   * followed did not land.
   */
  const renderPermalinkNotice = () => {
    // The PLUGIN half of the same question is answered inside
    // `PluginsSection`, which is where the plugin list lives — duplicating
    // that query here to render one sentence would put two sources of truth
    // behind one message.
    if (routeServerState.kind !== "unavailable") return null;
    return (
      <div
        role="status"
        data-testid="permalink-unavailable"
        className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground"
      >
        {permalinkUnavailableMessage("server")}
      </div>
    );
  };

  /**
   * Per-server auto-connect opt-out, stored as
   * `projectServerRefs.autoConnectDisabled` and honoured by the backend
   * under every mode. Keyed by runtime NAME here and translated to the
   * Convex id, because that is what the card knows.
   */
  const isServerAutoConnectDisabled = useCallback(
    (serverName: string) => {
      const serverId = sharedProjectServersRecord[serverName]?._id;
      if (!serverId) return false;
      return (
        projectServerConfigDto?.overrides?.[serverId]?.autoConnectDisabled ===
        true
      );
    },
    [sharedProjectServersRecord, projectServerConfigDto]
  );

  const handleSetServerAutoConnectDisabled = useCallback(
    async (serverName: string, disabled: boolean) => {
      const serverId = sharedProjectServersRecord[serverName]?._id;
      if (!sharedProjectIdForHostScope || !serverId) return;
      // The whole DTO round-trips: `setConfig` replaces rather than merges,
      // so every other server's overrides have to go back with it.
      const currentOverrides = projectServerConfigDto?.overrides ?? {};
      const existing = currentOverrides[serverId] ?? {};
      const nextEntry = { ...existing, autoConnectDisabled: disabled };
      try {
        await setProjectServerConfigMutation({
          projectId: sharedProjectIdForHostScope,
          input: {
            serverIds: projectServerConfigDto?.serverIds ?? [],
            overrides: { ...currentOverrides, [serverId]: nextEntry },
            // Always sent, defaulting to "all" — the same default the
            // backend reads. Omitting it makes this a legacy write, which
            // the backend classifies from the array, and on a project
            // whose config has never been written that reads as "none":
            // skipping one server would turn auto-connect off for all of
            // them.
            autoConnectMode: projectServerConfigDto?.autoConnectMode ?? "all",
          },
        });
        // A fresh intent: let the current host reconcile again rather than
        // reusing the attempt log from before the change.
        resetAutoConnectAttempts(activeProjectId);
        resetAutoConnectAttempts(sharedProjectIdForHostScope);
        toast.success(
          disabled
            ? `"${serverName}" will be skipped on auto-connect.`
            : `"${serverName}" will auto-connect again.`
        );
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Failed to update auto-connect for this server"
        );
      }
    },
    [
      activeProjectId,
      sharedProjectIdForHostScope,
      sharedProjectServersRecord,
      projectServerConfigDto,
      setProjectServerConfigMutation,
    ]
  );

  /**
   * The card's props, in one place. The same server can render in the main
   * grid, in the collapsed "needs attention" section, or under the drag
   * overlay, and three hand-maintained copies of this list is how one of
   * them quietly stops passing `onShareToOrgRegistry`.
   */
  const buildServerCardProps = useCallback(
    (name: string, server: ServerWithName) => ({
      server: getDisplayServer(server),
      needsReconnect: reconnectWarningByServerName[name],
      onDisconnect: (serverName: string) => {
        clearPendingQuickConnectIfMatches(serverName);
        onDisconnect(serverName);
      },
      onReconnect: handleReconnectServer,
      onRemove: (serverName: string) => {
        clearPendingQuickConnectIfMatches(serverName);
        onRemove(serverName);
      },
      hostedServerId: sharedProjectServersRecord[name]?._id,
      onOpenDetailModal: handleOpenDetailModal,
      projectId: activeProjectId,
      moveTargets,
      onMoveToProject: handleMoveServerToProject,
      isMovingToProject: movingServerName === name,
      onShareToOrgRegistry:
        isRegistryEnabled && orgRegistry.canAdd
          ? handleShareToOrgRegistry
          : undefined,
      autoConnectDisabled: isServerAutoConnectDisabled(name),
      onSetAutoConnectDisabled: canManageProjectServers
        ? handleSetServerAutoConnectDisabled
        : undefined,
    }),
    [
      getDisplayServer,
      reconnectWarningByServerName,
      clearPendingQuickConnectIfMatches,
      onDisconnect,
      handleReconnectServer,
      onRemove,
      sharedProjectServersRecord,
      handleOpenDetailModal,
      activeProjectId,
      moveTargets,
      handleMoveServerToProject,
      movingServerName,
      isRegistryEnabled,
      orgRegistry.canAdd,
      handleShareToOrgRegistry,
      isServerAutoConnectDisabled,
      canManageProjectServers,
      handleSetServerAutoConnectDisabled,
    ]
  );

  const renderConnectedContent = () => (
    <ResizablePanelGroup direction="horizontal" className="flex-1">
      {/* Main Server List Panel */}
      <ResizablePanel
        defaultSize={isJsonRpcPanelVisible ? 65 : 100}
        minSize={70}
      >
        <div className="space-y-6 p-8 h-full overflow-auto">
          {renderPermalinkNotice()}
          {/* Header Section */}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <div className="flex items-center gap-2">
              {showServerActionsInHostsHeader
                ? null
                : renderAutoConnectToggle()}
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
              {!showServerActionsInHostsHeader
                ? renderServerActionsMenu()
                : null}
            </div>
          </div>

          {renderQuickConnectSection()}

          {renderPluginsSection()}

          {/* Server Cards Grid (drag-and-drop reorderable, order saved to localStorage only) */}
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragCancel={() => setActiveId(null)}
          >
            <SortableContext
              items={gridServerNames}
              strategy={rectSortingStrategy}
            >
              <div className="grid grid-cols-1 lg:grid-cols-1 xl:grid-cols-2 gap-6">
                {gridServerNames.map((name) => {
                  const server = projectServers[name];
                  if (!server) return null;
                  return (
                    <SortableServerCard
                      key={name}
                      id={name}
                      dndDisabled={false}
                      {...buildServerCardProps(name, server)}
                    />
                  );
                })}
              </div>
            </SortableContext>

            {/* Servers that have settled as broken, folded away by default.
                Rendered OUTSIDE the SortableContext on purpose: they are
                not draggable while they're down here, and leaving them out
                keeps the sortable index space contiguous. Their place in
                `orderedServerNames` is untouched, so recovering puts each
                one straight back where the user put it. */}
            {attentionServerNames.length > 0 && (
              <div className="mt-6">
                <button
                  type="button"
                  className={cn(
                    "group inline-flex max-w-full items-center gap-1 rounded-md border border-border/40 bg-muted/10 px-1.5 py-1 text-left",
                    "text-[11px] font-semibold uppercase tracking-wide text-muted-foreground underline-offset-4 hover:underline",
                    "transition-colors hover:border-border/60 hover:bg-muted/25",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  )}
                  aria-expanded={attentionSectionExpanded}
                  onClick={() => setAttentionSectionExpanded((open) => !open)}
                  data-testid="servers-needs-attention-toggle"
                >
                  <ChevronRight
                    className={cn(
                      "h-3 w-3 shrink-0 text-current opacity-90 transition-transform duration-200 group-hover:opacity-100",
                      attentionSectionExpanded && "rotate-90"
                    )}
                    aria-hidden
                  />
                  <span className="whitespace-nowrap">
                    {attentionServerNames.length === 1
                      ? "1 server needs attention"
                      : `${attentionServerNames.length} servers need attention`}
                  </span>
                </button>
                {attentionSectionExpanded && (
                  <div className="mt-4 grid grid-cols-1 lg:grid-cols-1 xl:grid-cols-2 gap-6">
                    {attentionServerNames.map((name) => {
                      const server = projectServers[name];
                      if (!server) return null;
                      return (
                        <ServerConnectionCard
                          key={name}
                          {...buildServerCardProps(name, server)}
                        />
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <DragOverlay>
              {activeServer ? (
                <div style={{ opacity: 0.85 }}>
                  <ServerConnectionCard
                    server={getDisplayServer(activeServer)}
                    needsReconnect={
                      reconnectWarningByServerName[activeServer.name]
                    }
                    onDisconnect={(serverName) => {
                      clearPendingQuickConnectIfMatches(serverName);
                      onDisconnect(serverName);
                    }}
                    onReconnect={handleReconnectServer}
                    onRemove={(serverName) => {
                      clearPendingQuickConnectIfMatches(serverName);
                      onRemove(serverName);
                    }}
                    hostedServerId={sharedProjectServersRecord[activeId!]?._id}
                    projectId={activeProjectId}
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
            <AnimatePresence initial={false}>
              {viewPhase === "servers" ? (
                <motion.div
                  key="logs-rail"
                  initial={{ x: "100%", opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  exit={{ x: "100%", opacity: 0 }}
                  transition={SNAPPY_RAIL}
                  className="h-full flex flex-col bg-background border-l border-border"
                >
                  <LoggerView
                    key={connectedCount}
                    serverIds={loggerServerIds}
                    sinceTimestamp={loggerSinceTimestamp}
                    onClose={toggleJsonRpcPanel}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </ResizablePanel>
        </>
      ) : (
        <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
      )}
    </ResizablePanelGroup>
  );

  const renderEmptyContent = () => (
    <div className="space-y-6 p-8 h-full overflow-auto">
      {/* Rendered in BOTH branches: a permalink to a server this viewer
          cannot see most often lands on a project with no servers at all,
          which is exactly when the collection fallback would say only "No
          servers connected" and the link's failure would go unmentioned. */}
      {renderPermalinkNotice()}
      {/* Header Section */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <div className="flex items-center gap-2">
          {showServerActionsInHostsHeader ? null : renderAutoConnectToggle()}
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
          {!showServerActionsInHostsHeader ? renderServerActionsMenu() : null}
        </div>
      </div>

      {renderQuickConnectSection()}

      {renderPluginsSection()}

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
    <ResizablePanelGroup direction="horizontal" className="flex-1">
      <ResizablePanel
        defaultSize={isJsonRpcPanelVisible ? 65 : 100}
        minSize={70}
      >
        <ServersLoadingSkeleton />
      </ResizablePanel>
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
            <div className="h-full bg-background border-l border-border" />
          </ResizablePanel>
        </>
      ) : (
        <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
      )}
    </ResizablePanelGroup>
  );

  const renderNoProjectContent = () => (
    <div className="space-y-6 p-8 h-full overflow-auto">
      <Card className="p-12 text-center" data-testid="servers-no-project">
        <div className="mx-auto max-w-sm">
          <MCPIcon className="mx-auto h-12 w-12 text-muted-foreground" />
          <h3 className="mt-4 text-lg font-semibold">No project selected</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Select or create a project before adding servers.
          </p>
        </div>
      </Card>
    </div>
  );

  return (
    // The previewed host's mcpProfile scopes this tab so the server
    // add/edit modals' AuthenticationSection can read the host's
    // enterprise-managed authorization policy via useActiveMcpProfile().
    // The ServerDetailModal's protocol chip keeps its explicit
    // hostDefaultMcpProtocolVersion prop (prop wins; see the modal's
    // resolution comment) — the provider is additive, not a replacement.
    <ActiveMcpProfileProvider value={previewedHost?.config?.mcpProfile}>
      <div className="h-full flex flex-col">
        {isAuthHydrating ||
        isBillingContextPending ||
        isLoadingProjects ||
        !areServersHydrated
          ? renderLoadingContent()
          : !selectedProject
          ? shouldQueryProjectId(activeProjectId)
            ? renderLoadingContent()
            : renderNoProjectContent()
          : hasAnyServers
          ? renderConnectedContent()
          : renderEmptyContent()}

        {/* Add Server Modal */}
        <AddServerModal
          isOpen={isAddingServer}
          initialData={prefilledServerDraft}
          onClose={() => {
            setIsAddingServer(false);
            setPrefilledServerDraft(undefined);
          }}
          onSubmit={(formData) => {
            track("connecting_server", {
              location: "servers_tab",
            });
            // The wire-version pin can't be written until the hosted server
            // row exists — stash it and let the watcher effect apply it once
            // the Convex sync surfaces the row, then reconnect with the pin.
            if (formData.mcpProtocolVersionOverride) {
              setPendingAddProtocolPin({
                serverName: formData.name,
                version: formData.mcpProtocolVersionOverride,
              });
            }
            handleConnectServer(formData);
          }}
          projectClientConfig={selectedProject?.clientConfig}
          organizationId={selectedProject?.organizationId ?? null}
          isSignedIn={Boolean(signedInUser)}
          projectXaaDefaultIdentity={
            selectedProject?.xaaTestDefaults?.defaultIdentity ?? null
          }
          projectId={sharedProjectIdForHostScope}
        />

        {/* Promote a connected server onto the organization's registry. */}
        {orgRegistrySeed && (
          <OrgRegistryServerDialog
            open
            onOpenChange={(open) => {
              if (!open) setOrgRegistrySeed(null);
            }}
            projectId={sharedProjectIdForHostScope}
            seed={orgRegistrySeed}
            onSubmit={handleOrgRegistrySubmit}
          />
        )}

        {/* JSON Import Modal */}
        <JsonImportModal
          isOpen={isImportingJson}
          onClose={() => setIsImportingJson(false)}
          onImport={handleJsonImport}
        />

        {/* Add Plugin Modal. Mounted (not conditionally rendered) while the
          flag is on so an import in flight — or a preview awaiting a
          decision — survives closing the dialog and resumes on reopen. */}
        {isPluginsEnabled ? (
          <AddPluginModal
            isOpen={isAddingPlugin}
            onClose={() => setIsAddingPlugin(false)}
            projectId={sharedProjectIdForHostScope}
          />
        ) : null}

        {detailModalServer && (
          <ServerDetailModal
            key={detailModalState.sessionKey}
            isOpen={detailModalState.isOpen}
            onClose={handleCloseDetailModal}
            server={detailModalServer}
            needsReconnect={
              reconnectWarningByServerName[detailModalServer.name]
            }
            defaultTab={detailModalState.defaultTab}
            onSubmit={handleSubmitDetailModal}
            onDisconnect={onDisconnect}
            onReconnect={handleReconnectServer}
            existingServerNames={Object.keys(projectServers)}
            projectClientConfig={selectedProject?.clientConfig}
            projectId={hostedProjectId}
            hostedServerId={detailModalHostedServerId}
            organizationId={selectedProject?.organizationId ?? null}
            isSignedIn={Boolean(signedInUser)}
            // The tab now mounts under ActiveMcpProfileProvider (see the
            // root wrapper), which is the source for general host-profile
            // reads (e.g. the auth section's enterprise-policy guidance).
            // The protocol chip stays PROP-FIRST: this explicit value wins
            // over the provider (see the modal's resolution comment), so
            // its source attribution is unchanged.
            hostDefaultMcpProtocolVersion={
              previewedHost?.config?.mcpProfile?.mcpProtocolVersion
            }
            projectXaaDefaultIdentity={
              selectedProject?.xaaTestDefaults?.defaultIdentity ?? null
            }
          />
        )}

        {showServerActionsInHostsHeader && hostsConnectAddServerSlot
          ? createPortal(
              <>
                {renderAutoConnectToggle()}
                {renderServerActionsMenu()}
              </>,
              hostsConnectAddServerSlot
            )
          : null}
      </div>
    </ActiveMcpProfileProvider>
  );
}
