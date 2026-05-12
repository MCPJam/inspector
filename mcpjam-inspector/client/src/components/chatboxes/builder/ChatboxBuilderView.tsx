import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { useConvexAuth, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Card } from "@mcpjam/design-system/card";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { ChatboxUsagePanel } from "@/components/chatboxes/ChatboxUsagePanel";
import {
  useChatbox,
  useChatboxMutations,
  type ChatboxSettings,
} from "@/hooks/useChatboxes";
import { useIsMobile } from "@/hooks/use-mobile";
import { useServerMutations, type RemoteServer } from "@/hooks/useProjects";
import { copyToClipboard } from "@/lib/clipboard";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { getChatboxHostStyleShortLabel } from "@/lib/chatbox-host-style";
import { ChatTabV2 } from "@/components/ChatTabV2";
import { getLoadingIndicatorVariantForHostStyle } from "@/components/chat-v2/shared/loading-indicator-content";
import type {
  EnsureServersReadyResult,
  ServerWithName,
} from "@/hooks/use-app-state";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { isHostedOAuthBusy } from "@/lib/hosted-oauth-resume";
import { ChatboxHostOnboardingOverlays } from "@/components/hosted/ChatboxHostOnboardingOverlays";
import { useChatboxHostIntroGate } from "@/components/hosted/useChatboxHostIntroGate";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import {
  CHATBOX_OAUTH_PENDING_KEY,
  buildPlaygroundChatboxLink,
  buildChatboxLink,
  chatboxPreviewEnabledOptionalStorageKey,
  writeBuilderSession,
  writePlaygroundSession,
  type ChatboxBootstrapPayload,
  type ChatboxBootstrapServer,
} from "@/lib/chatbox-session";
import { ChatboxHostStyleProvider } from "@/contexts/chatbox-host-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-host-capabilities-override-context";
import type { ServerFormData } from "@/shared/types";
import { buildChatboxCanvas } from "./chatboxCanvasBuilder";
import { ChatboxCanvas } from "./ChatboxCanvas";
import {
  DEFAULT_SYSTEM_PROMPT,
  draftToHostConfigInputV2,
  toChatUiFromChatbox,
  toDraftConfig,
} from "./drafts";
import {
  hostConfigDtoToInput,
  type HostConfigDtoV2,
} from "@/lib/host-config-v2";
import {
  computeSectionStatuses,
  SetupChecklistPanel,
  isInsecureUrl,
  updateSelectedServerIds,
  type SetupSectionId,
} from "./setup-checklist-panel";
import type { ChatboxBuilderContext, ChatboxDraftConfig } from "./types";
import {
  bootstrapServerToHostedOAuthDescriptor,
  countRequiredServers,
} from "./chatbox-server-optional";
import "./chatbox-builder.css";

interface ChatboxBuilderViewProps {
  projectId: string;
  projectName?: string | null;
  projectServers: RemoteServer[];
  chatboxId?: string | null;
  draft: ChatboxDraftConfig | null;
  initialViewMode?: "setup" | "preview" | "usage" | "insights";
  /**
   * Reconnect the chatbox's MCP servers on the local inspector before the
   * first preview message. Reuses the eval-tab helper from
   * `useAppState.ensureServersReady` — without it, `prepareChatV2` in
   * `/api/mcp/chat-v2` filters out unconnected servers and the LLM responds
   * with zero MCP tools (e.g. ASCII drawings instead of an Excalidraw call).
   */
  ensureServersReady?: (
    serverNames: string[],
  ) => Promise<EnsureServersReadyResult>;
  onBack: () => void;
  onSavedDraft: (chatbox: ChatboxSettings) => void;
}

/** Right (setup) rail: favor setup on desktop */
const DESKTOP_SETUP_RAIL_DEFAULT_PERCENT = 60;
const DESKTOP_SETUP_RAIL_MIN_PERCENT = 40;
const DESKTOP_SETUP_RAIL_MAX_PERCENT = 70;

type ViewMode = "setup" | "preview" | "usage" | "insights";

function normalizeInitialViewMode(
  mode: string | undefined
): ViewMode | undefined {
  if (!mode) return undefined;
  if (
    mode === "setup" ||
    mode === "preview" ||
    mode === "usage" ||
    mode === "insights"
  ) {
    return mode;
  }
  if (mode === "builder") return "setup";
  return undefined;
}

function getSetupSectionForNode(nodeId: string | null): SetupSectionId {
  if (nodeId?.startsWith("server:")) {
    return "servers";
  }
  return "basics";
}

function ChatboxPreviewActionButtons({
  variant,
  hasSavedChatbox,
  onCopyLink,
  onOpenFullPreview,
  onReloadPreview,
}: {
  variant: "sidebar" | "mobileHeader";
  hasSavedChatbox: boolean;
  onCopyLink: () => void;
  onOpenFullPreview: () => void;
  onReloadPreview: () => void;
}) {
  const showCopyLink = hasSavedChatbox;
  const isSidebar = variant === "sidebar";
  const buttonClass = isSidebar
    ? "w-full justify-start rounded-xl"
    : "rounded-xl";

  return (
    <div
      className={
        isSidebar
          ? "flex flex-col gap-2"
          : "flex w-full flex-wrap items-center justify-end gap-2"
      }
    >
      {showCopyLink ? (
        <Button variant="outline" className={buttonClass} onClick={onCopyLink}>
          <Link2 className="mr-1.5 size-4 shrink-0" />
          Copy link
        </Button>
      ) : null}
      <Button
        variant="outline"
        className={buttonClass}
        onClick={onOpenFullPreview}
        disabled={!hasSavedChatbox}
      >
        <ExternalLink className="mr-1.5 size-4 shrink-0" />
        Open full preview
      </Button>
      <Button
        variant="outline"
        className={buttonClass}
        onClick={onReloadPreview}
        disabled={!hasSavedChatbox}
      >
        <RefreshCw className="mr-1.5 size-4 shrink-0" />
        Reload preview
      </Button>
    </div>
  );
}

function ChatboxBuilderChrome({
  title,
  isDirty,
  isSaving,
  hasSavedChatbox,
  setupHasBlockingSections,
  viewMode,
  onBack,
  onSave,
  mobilePreviewActions,
  onModeChange,
}: {
  title: string;
  isDirty: boolean;
  isSaving: boolean;
  hasSavedChatbox: boolean;
  /** True when any Setup section is marked Attention (same gate as bottom “Save and open preview”). */
  setupHasBlockingSections: boolean;
  viewMode: ViewMode;
  onBack: () => void;
  onSave: () => void;
  /** Preview-only actions shown under `md` when the config sidebar is hidden. */
  mobilePreviewActions?: ReactNode;
  onModeChange: (mode: ViewMode) => void;
}) {
  const saveDisabled =
    isSaving || (!isDirty && hasSavedChatbox) || setupHasBlockingSections;
  const saveLabel = hasSavedChatbox && isDirty ? "Save changes" : "Save";

  return (
    <div className="shrink-0 border-b border-border/70 px-6 py-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-x-4 md:gap-y-0">
        <div className="order-1 flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-xl"
            onClick={onBack}
            aria-label="Return to chatboxes"
            title="Return to chatboxes"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <div className="min-w-0">
            <h2 className="truncate text-xl font-semibold">{title}</h2>
          </div>
        </div>

        <ViewModeSelector
          value={viewMode}
          ariaLabel="Chatbox modes"
          onChange={onModeChange}
          options={[
            { value: "setup", label: "Setup" },
            {
              value: "preview",
              label: "Preview",
              disabled: !hasSavedChatbox,
            },
            {
              value: "usage",
              label: "Sessions",
              disabled: !hasSavedChatbox,
            },
            {
              value: "insights",
              label: "Clusters",
              disabled: !hasSavedChatbox,
            },
          ]}
        />

        <div className="order-2 flex flex-wrap items-center justify-end gap-2 md:order-3">
          {mobilePreviewActions}
          <Button
            onClick={onSave}
            disabled={saveDisabled}
            title={
              setupHasBlockingSections
                ? "Resolve every section marked Attention in Setup before saving."
                : undefined
            }
            variant={hasSavedChatbox && !isDirty ? "ghost" : "default"}
            className="rounded-xl"
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-4" />
            )}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ChatboxBuilderView({
  projectId,
  projectName,
  projectServers,
  chatboxId,
  draft,
  initialViewMode,
  ensureServersReady,
  onBack,
  onSavedDraft,
}: ChatboxBuilderViewProps) {
  const { isAuthenticated } = useConvexAuth();
  const isMobile = useIsMobile();
  const { chatbox } = useChatbox({
    isAuthenticated,
    chatboxId: chatboxId ?? null,
  });
  const { createChatbox, updateChatbox, setChatboxMode, upsertChatboxMember } =
    useChatboxMutations();
  const { createServer } = useServerMutations();

  // Round-trip the chatbox's own hostConfig (edit mode). The save path
  // sends a complete HostConfigInputV2 to the backend; the backend's
  // mintV2ChatboxHostConfigFromV2Input persists the connection portion
  // (connectionDefaults / clientCapabilities / hostContext) verbatim,
  // so we MUST feed it the existing values or they'll be clobbered.
  const chatboxHostConfig = useQuery(
    "hostConfigsV2:getChatboxConfig" as any,
    isAuthenticated && chatboxId ? ({ chatboxId } as any) : "skip"
  ) as HostConfigDtoV2 | null | undefined;

  // Project default seeds the connection portion for new chatboxes and
  // is also the fallback for legacy edit-mode rows that resolve null
  // from getChatboxConfig — without it, draftToHostConfigInputV2 would
  // fall back to v2 empty shape and silently drop the project's
  // configured headers / capabilities / hostContext on next save.
  const projectDefaultHostConfig = useQuery(
    "hostConfigsV2:getProjectDefault" as any,
    isAuthenticated && projectId ? ({ projectId } as any) : "skip"
  ) as HostConfigDtoV2 | null | undefined;

  const [draftChatboxConfig, setDraftChatboxConfig] =
    useState<ChatboxDraftConfig>(() => {
      const base =
        draft ??
        toDraftConfig(
          chatbox ??
            ({
              chatboxId: "",
              projectId,
              name: "New Chatbox",
              hostStyle: "claude",
              systemPrompt: DEFAULT_SYSTEM_PROMPT,
              modelId: "openai/gpt-5-mini",
              temperature: 0.7,
              requireToolApproval: false,
              allowGuestAccess: false,
              mode: "anyone_with_link",
              servers: [],
              link: null,
              members: [],
              chatUi: {
                surfaces: {
                  welcome: { enabled: true, body: "" },
                  feedback: {
                    enabled: true,
                    everyNToolCalls: 1,
                    promptHint: "",
                  },
                },
              },
            } as ChatboxSettings)
        );
      return {
        ...base,
        optionalServerIds: base.optionalServerIds ?? [],
      };
    });
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => normalizeInitialViewMode(initialViewMode) ?? "setup"
  );
  const [chatKey, setChatKey] = useState(0);
  const [playgroundId, setPlaygroundId] = useState(() => crypto.randomUUID());
  const [isSetupSheetOpen, setIsSetupSheetOpen] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("host");
  const [focusedSetupSection, setFocusedSetupSection] =
    useState<SetupSectionId | null>(null);
  const [desktopSettingsPaneSize, setDesktopSettingsPaneSize] = useState(
    DESKTOP_SETUP_RAIL_DEFAULT_PERCENT
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [canvasViewportRefitNonce, setCanvasViewportRefitNonce] = useState(0);
  const panelGroupContainerRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null);
  const isInitialMountRef = useRef(true);
  const pendingRestartRef = useRef(false);
  const prevViewModeRef = useRef(viewMode);
  const prevViewModeForCanvasRefitRef = useRef<ViewMode>(viewMode);
  const prevMobileSetupSheetForCanvasRef = useRef(isSetupSheetOpen);

  // Sync builder session to sessionStorage so it survives OAuth redirects
  useEffect(() => {
    writeBuilderSession({
      projectId,
      chatboxId: chatboxId ?? null,
      draft: draftChatboxConfig as unknown as Record<string, unknown>,
      viewMode,
    });
  }, [projectId, chatboxId, draftChatboxConfig, viewMode]);

  const behaviorFingerprint = useMemo(
    () =>
      JSON.stringify({
        name: draftChatboxConfig.name,
        hostStyle: draftChatboxConfig.hostStyle,
        systemPrompt: draftChatboxConfig.systemPrompt,
        modelId: draftChatboxConfig.modelId,
        temperature: draftChatboxConfig.temperature,
        requireToolApproval: draftChatboxConfig.requireToolApproval,
        mode: draftChatboxConfig.mode,
        allowGuestAccess: draftChatboxConfig.allowGuestAccess,
        chatUi: draftChatboxConfig.chatUi,
        selectedServerIds: [...draftChatboxConfig.selectedServerIds].sort(),
        optionalServerIds: [...draftChatboxConfig.optionalServerIds].sort(),
      }),
    [draftChatboxConfig]
  );

  const setupHasBlockingSections = useMemo(() => {
    const statuses = computeSectionStatuses(
      draftChatboxConfig,
      projectServers
    );
    return Object.values(statuses).some((kind) => kind === "attention");
  }, [draftChatboxConfig, projectServers]);

  // Debounced auto-restart on behavior-affecting changes
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }

    if (viewMode !== "preview" || !chatbox?.link?.token) {
      pendingRestartRef.current = true;
      return;
    }

    const timer = setTimeout(() => {
      const nextId = crypto.randomUUID();
      setPlaygroundId(nextId);
      setChatKey((k) => k + 1);
    }, 400);

    return () => clearTimeout(timer);
  }, [behaviorFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pending restart when switching back to preview
  useEffect(() => {
    const prev = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;

    if (
      prev !== viewMode &&
      viewMode === "preview" &&
      pendingRestartRef.current
    ) {
      pendingRestartRef.current = false;
      const nextId = crypto.randomUUID();
      setPlaygroundId(nextId);
      setChatKey((k) => k + 1);
    }
  }, [viewMode]);

  useEffect(() => {
    const prev = prevViewModeForCanvasRefitRef.current;
    prevViewModeForCanvasRefitRef.current = viewMode;
    if (viewMode === "setup" && prev !== "setup") {
      setCanvasViewportRefitNonce((n) => n + 1);
    }
  }, [viewMode]);

  useEffect(() => {
    if (!isMobile || viewMode !== "setup") {
      prevMobileSetupSheetForCanvasRef.current = isSetupSheetOpen;
      return;
    }
    if (prevMobileSetupSheetForCanvasRef.current !== isSetupSheetOpen) {
      setCanvasViewportRefitNonce((n) => n + 1);
    }
    prevMobileSetupSheetForCanvasRef.current = isSetupSheetOpen;
  }, [isMobile, viewMode, isSetupSheetOpen]);

  // Playground snapshot writer — keeps localStorage in sync with draft config
  useEffect(() => {
    if (!chatbox?.link?.token) return;

    const servers: ChatboxBootstrapServer[] =
      draftChatboxConfig.selectedServerIds.flatMap((id) => {
        const server = projectServers.find((s) => s._id === id);
        if (!server) return [];
        return [
          {
            serverId: server._id,
            serverName: server.name,
            useOAuth: Boolean(server.useOAuth),
            serverUrl: server.url ?? null,
            clientId: server.clientId ?? null,
            oauthScopes: server.oauthScopes ?? null,
            optional: draftChatboxConfig.optionalServerIds.includes(id),
          } satisfies ChatboxBootstrapServer,
        ];
      });

    const payload: ChatboxBootstrapPayload = {
      projectId: chatbox.projectId,
      chatboxId: chatbox.chatboxId,
      name: draftChatboxConfig.name,
      description: draftChatboxConfig.description || undefined,
      hostStyle: draftChatboxConfig.hostStyle,
      mode: draftChatboxConfig.mode,
      allowGuestAccess: draftChatboxConfig.allowGuestAccess,
      viewerIsProjectMember: true,
      systemPrompt: draftChatboxConfig.systemPrompt,
      modelId: draftChatboxConfig.modelId,
      temperature: draftChatboxConfig.temperature,
      requireToolApproval: draftChatboxConfig.requireToolApproval,
      servers,
      chatUi: draftChatboxConfig.chatUi,
    };

    writePlaygroundSession({
      chatboxId: chatbox.chatboxId,
      accessVersion: 0,
      payload,
      surface: "preview",
      playgroundId,
      updatedAt: Date.now(),
    });
  }, [draftChatboxConfig, chatbox, projectServers, playgroundId]);

  useEffect(() => {
    if (!draft && chatbox) {
      setDraftChatboxConfig(toDraftConfig(chatbox));
    }
  }, [draft, chatbox]);

  useEffect(() => {
    if (viewMode === "setup" && isMobile) {
      setIsSetupSheetOpen(true);
    }
  }, [viewMode, isMobile]);

  const context = useMemo<ChatboxBuilderContext>(
    () => ({
      chatbox: chatbox ?? null,
      draft: draftChatboxConfig,
      projectServers,
    }),
    [draftChatboxConfig, chatbox, projectServers]
  );
  const viewModel = useMemo(() => buildChatboxCanvas(context), [context]);
  const desktopRightPanelDefaultSize = desktopSettingsPaneSize;
  const desktopLeftPanelDefaultSize = 100 - desktopRightPanelDefaultSize;

  const isDirty = useMemo(() => {
    if (!chatbox) return true;
    const currentIds = chatbox.servers.map((server) => server.serverId).sort();
    const draftIds = [...draftChatboxConfig.selectedServerIds].sort();
    const optionalFromChatbox = chatbox.servers
      .filter((s) => s.optional)
      .map((s) => s.serverId)
      .sort();
    const draftOptionalIds = [...draftChatboxConfig.optionalServerIds].sort();
    return (
      draftChatboxConfig.name !== chatbox.name ||
      draftChatboxConfig.description !== (chatbox.description ?? "") ||
      draftChatboxConfig.hostStyle !== chatbox.hostStyle ||
      draftChatboxConfig.systemPrompt !== chatbox.systemPrompt ||
      draftChatboxConfig.modelId !== chatbox.modelId ||
      draftChatboxConfig.temperature !== chatbox.temperature ||
      draftChatboxConfig.requireToolApproval !== chatbox.requireToolApproval ||
      draftChatboxConfig.mode !== chatbox.mode ||
      draftChatboxConfig.allowGuestAccess !== chatbox.allowGuestAccess ||
      JSON.stringify(draftChatboxConfig.chatUi) !==
        JSON.stringify(toChatUiFromChatbox(chatbox)) ||
      JSON.stringify(currentIds) !== JSON.stringify(draftIds) ||
      JSON.stringify(optionalFromChatbox) !== JSON.stringify(draftOptionalIds)
    );
  }, [draftChatboxConfig, chatbox]);

  const hasSavedChatbox = Boolean(chatbox?.chatboxId);

  const shareLink = chatbox?.link?.token
    ? buildChatboxLink(chatbox.link.token, chatbox.name)
    : null;

  const introChatboxId = chatbox?.chatboxId ?? chatboxId ?? "";

  const [previewEnabledOptionalIds, setPreviewEnabledOptionalIds] = useState<
    string[]
  >([]);

  const optionalServerIdsKey = [...draftChatboxConfig.optionalServerIds]
    .sort()
    .join(",");

  useEffect(() => {
    if (!introChatboxId) return;
    try {
      const raw = sessionStorage.getItem(
        chatboxPreviewEnabledOptionalStorageKey(introChatboxId)
      );
      if (!raw) {
        setPreviewEnabledOptionalIds((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const optionalSet = new Set(draftChatboxConfig.optionalServerIds);
      const next = parsed.filter(
        (id): id is string => typeof id === "string" && optionalSet.has(id)
      );
      setPreviewEnabledOptionalIds((prev) => {
        if (
          prev.length === next.length &&
          prev.every((id, i) => id === next[i])
        ) {
          return prev;
        }
        return next;
      });
    } catch {
      setPreviewEnabledOptionalIds((prev) => (prev.length === 0 ? prev : []));
    }
  }, [introChatboxId, optionalServerIdsKey]);

  useEffect(() => {
    if (!introChatboxId) return;
    try {
      const storageKey =
        chatboxPreviewEnabledOptionalStorageKey(introChatboxId);
      const serialized = JSON.stringify(previewEnabledOptionalIds);
      if (sessionStorage.getItem(storageKey) === serialized) return;
      sessionStorage.setItem(storageKey, serialized);
    } catch {
      // ignore
    }
  }, [introChatboxId, previewEnabledOptionalIds]);

  const selectedPreviewServers = useMemo((): ChatboxBootstrapServer[] => {
    return draftChatboxConfig.selectedServerIds.flatMap((id) => {
      const server = projectServers.find((s) => s._id === id);
      if (!server) return [];
      return [
        {
          serverId: server._id,
          serverName: server.name,
          useOAuth: Boolean(server.useOAuth),
          serverUrl: server.url ?? null,
          clientId: server.clientId ?? null,
          oauthScopes: server.oauthScopes ?? null,
          optional: draftChatboxConfig.optionalServerIds.includes(server._id),
        } satisfies ChatboxBootstrapServer,
      ];
    });
  }, [
    draftChatboxConfig.selectedServerIds,
    draftChatboxConfig.optionalServerIds,
    projectServers,
  ]);

  const requiredPreviewServers = useMemo(
    () => selectedPreviewServers.filter((s) => !s.optional),
    [selectedPreviewServers]
  );

  const activePreviewServers = useMemo(() => {
    const enabled = new Set(previewEnabledOptionalIds);
    const optionalActive = selectedPreviewServers.filter(
      (s) => s.optional && enabled.has(s.serverId)
    );
    return [...requiredPreviewServers, ...optionalActive];
  }, [
    requiredPreviewServers,
    selectedPreviewServers,
    previewEnabledOptionalIds,
  ]);

  const chatboxServerConfigs = useMemo(() => {
    const entries = activePreviewServers.flatMap((preview) => {
      const server = projectServers.find((s) => s._id === preview.serverId);
      if (!server) return [];
      return [
        [
          server.name,
          {
            name: server.name,
            connectionStatus: "connected" as const,
            config: { url: "https://chatbox-chat.invalid" } as any,
            lastConnectionTime: new Date(),
            retryCount: 0,
            enabled: true,
          } satisfies ServerWithName,
        ],
      ];
    });
    return Object.fromEntries(entries);
  }, [activePreviewServers, projectServers]);

  const previewOAuthGateServers = useMemo(
    () => activePreviewServers.map(bootstrapServerToHostedOAuthDescriptor),
    [activePreviewServers]
  );

  const {
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
    hasBusyOAuth,
  } = useHostedOAuthGate({
    surface: "chatbox",
    pendingKey: CHATBOX_OAUTH_PENDING_KEY,
    servers: previewOAuthGateServers,
    projectId: chatbox?.projectId ?? projectId,
    chatboxId: chatbox?.chatboxId,
    isAuthenticated,
  });

  const isFinishingPreviewOAuth =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ state }) => isHostedOAuthBusy(state.status));

  const oauthPending = pendingOAuthServers.length > 0;
  const welcomeAvailable =
    draftChatboxConfig.chatUi.surfaces.welcome.enabled &&
    !!draftChatboxConfig.chatUi.surfaces.welcome.body?.trim();
  const introGate = useChatboxHostIntroGate({
    chatboxId: introChatboxId,
    servers: requiredPreviewServers,
    oauthPending,
    hasBusyOAuth,
    pendingOAuthServers,
    welcomeAvailable,
  });

  // Auto-connect the chatbox's MCP servers on the inspector's local
  // mcpClientManager before the first preview turn. Without this,
  // prepareChatV2 in /api/mcp/chat-v2 filters out servers that aren't
  // registered → the LLM gets zero tools → "draw a dog" returns ASCII
  // art instead of an Excalidraw tool call. Mirrors the evals flow at
  // EvalsTab.tsx:445 + use-eval-handlers.ts:653.
  const activePreviewServerNames = useMemo(
    () => activePreviewServers.map((s) => s.serverName),
    [activePreviewServers]
  );
  // Stable key for the reconnect effect. The `\0` delimiter prevents
  // collisions between e.g. ["ab","c"] and ["a","bc"] (both join to "abc"
  // without one), which would otherwise let a server-set swap skip the
  // effect entirely. Matches the convention in use-playground-project-executions.
  const activePreviewServerNamesKey = useMemo(
    () => activePreviewServerNames.slice().sort().join("\0"),
    [activePreviewServerNames]
  );
  // Seed in "connecting" when the Preview tab opens with servers and the
  // helper plumbed: the reconnect effect below only fires after the first
  // paint, so an initial `"idle"` would leave previewConnectComposerBlocked
  // false for one frame, letting the composer briefly accept input before
  // the local mcpClientManager has the servers registered.
  const [previewConnectStatus, setPreviewConnectStatus] = useState<{
    phase: "idle" | "connecting" | "ready" | "blocked";
    readyCount: number;
    totalCount: number;
    blockedReason?: string;
  }>(() => {
    const total = activePreviewServerNames.length;
    if (viewMode === "preview" && ensureServersReady && total > 0) {
      return { phase: "connecting", readyCount: 0, totalCount: total };
    }
    return { phase: "idle", readyCount: 0, totalCount: 0 };
  });

  useEffect(() => {
    // Only run while the Preview tab is active. Switching to setup/usage
    // shouldn't kick off reconnects (and the composer is hidden anyway).
    if (viewMode !== "preview") {
      return;
    }
    if (!ensureServersReady) {
      // No helper plumbed (e.g. in tests or non-app shells). Treat as ready;
      // the composer's other gates still apply.
      setPreviewConnectStatus({
        phase: "idle",
        readyCount: activePreviewServerNames.length,
        totalCount: activePreviewServerNames.length,
      });
      return;
    }
    if (activePreviewServerNames.length === 0) {
      setPreviewConnectStatus({ phase: "ready", readyCount: 0, totalCount: 0 });
      return;
    }

    let cancelled = false;
    setPreviewConnectStatus((prev) => {
      // Don't flash "connecting" when switching back to the preview tab with
      // the same server set already in ready state. ensureServersReady below
      // will still verify and correct if anything actually changed.
      if (prev.phase === "ready" && prev.totalCount === activePreviewServerNames.length) {
        return prev;
      }
      return {
        phase: "connecting",
        readyCount: prev.phase === "ready" ? prev.readyCount : 0,
        totalCount: activePreviewServerNames.length,
      };
    });

    void (async () => {
      try {
        const result = await ensureServersReady(activePreviewServerNames);
        if (cancelled) return;
        const total = activePreviewServerNames.length;
        const ready = result.readyServerNames.length;
        if (result.reauthServerNames.length > 0) {
          setPreviewConnectStatus({
            phase: "blocked",
            readyCount: ready,
            totalCount: total,
            blockedReason: `Reconnect ${result.reauthServerNames.join(", ")} to send messages.`,
          });
          return;
        }
        if (result.missingServerNames.length > 0) {
          setPreviewConnectStatus({
            phase: "blocked",
            readyCount: ready,
            totalCount: total,
            blockedReason: `Add ${result.missingServerNames.join(", ")} to the project to send messages.`,
          });
          return;
        }
        if (result.failedServerNames.length > 0) {
          setPreviewConnectStatus({
            phase: "blocked",
            readyCount: ready,
            totalCount: total,
            blockedReason: `Couldn't connect ${result.failedServerNames.join(", ")}. Retry from the Servers tab.`,
          });
          return;
        }
        setPreviewConnectStatus({
          phase: "ready",
          readyCount: ready,
          totalCount: total,
        });
      } catch (error) {
        if (cancelled) return;
        setPreviewConnectStatus({
          phase: "blocked",
          readyCount: 0,
          totalCount: activePreviewServerNames.length,
          blockedReason:
            error instanceof Error
              ? error.message
              : "Couldn't connect chatbox servers. Try again.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
    // Stable string key avoids reruns on activePreviewServerNames identity
    // churn (the memo above produces a fresh array per render). viewMode
    // gates the effect to the active Preview tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, activePreviewServerNamesKey, ensureServersReady]);

  const previewConnectComposerBlocked =
    previewConnectStatus.phase === "connecting" ||
    previewConnectStatus.phase === "blocked";
  const previewConnectComposerReason =
    previewConnectStatus.phase === "connecting"
      ? "Connecting servers…"
      : previewConnectStatus.phase === "blocked"
        ? previewConnectStatus.blockedReason
        : undefined;
  const composerBlocked =
    introGate.composerBlocked || previewConnectComposerBlocked;
  const composerBlockedReason = introGate.composerBlocked
    ? "Get started or authorize to send messages…"
    : previewConnectComposerReason;

  const handlePreviewOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      markOAuthRequired(details);
    },
    [markOAuthRequired]
  );

  const saveChatbox = useCallback(async (): Promise<boolean> => {
    const trimmedName = draftChatboxConfig.name.trim();
    if (!trimmedName) {
      toast.error("Chatbox name is required");
      return false;
    }
    if (draftChatboxConfig.selectedServerIds.length === 0) {
      toast.error("Select at least one HTTPS server");
      return false;
    }
    if (
      countRequiredServers(
        draftChatboxConfig.selectedServerIds,
        draftChatboxConfig.optionalServerIds
      ) < 1
    ) {
      toast.error("At least one server must be required (on by default)");
      return false;
    }
    const selectedServers = projectServers.filter((server) =>
      draftChatboxConfig.selectedServerIds.includes(server._id)
    );
    if (selectedServers.some((server) => isInsecureUrl(server.url))) {
      toast.error("Only HTTPS servers can be used in chatboxes");
      return false;
    }

    // On an edit route chatboxId is set before useChatbox() resolves;
    // branching the create-vs-update decision below on `chatbox` (the
    // reactive load) would let an early click fall into createChatbox
    // and duplicate the row. Block save until the chatbox record is
    // available, then key the branch off chatboxId.
    if (chatboxId && !chatbox) {
      toast.error("Loading chatbox — try again in a moment");
      return false;
    }

    // The backend's v2 hostConfig path persists connection fields
    // verbatim. Block save until a seed has resolved so we don't ship
    // empty connectionDefaults / clientCapabilities / hostContext and
    // clobber the existing values. For edit-mode chatboxes prefer the
    // chatbox's own config; only fall back to the project default
    // when the chatbox config has *resolved* null (legacy rows) — not
    // while it's still undefined (loading), which would let the
    // project default overwrite an existing chatbox's own connection
    // fields if the project query resolves first. For create mode,
    // use the project default directly.
    const chatboxSeed =
      chatboxHostConfig === null
        ? projectDefaultHostConfig
        : chatboxHostConfig;
    const seedDto = chatboxId ? chatboxSeed : projectDefaultHostConfig;
    if (seedDto === undefined) {
      toast.error("Loading chatbox config — try again in a moment");
      return false;
    }
    const seedInput = seedDto ? hostConfigDtoToInput(seedDto) : null;
    const draftWithTrimmedSystemPrompt: ChatboxDraftConfig = {
      ...draftChatboxConfig,
      systemPrompt:
        draftChatboxConfig.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
    };
    const hostConfigInput = draftToHostConfigInputV2(
      draftWithTrimmedSystemPrompt,
      seedInput
    );

    setIsSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: draftChatboxConfig.description.trim() || undefined,
        chatUi: draftChatboxConfig.chatUi,
        hostConfig: hostConfigInput,
      };

      if (!chatboxId) {
        let created = (await createChatbox({
          projectId,
          ...payload,
        })) as ChatboxSettings;
        if (draftChatboxConfig.mode !== "invited_only") {
          created = (await setChatboxMode({
            chatboxId: created.chatboxId,
            mode: draftChatboxConfig.mode,
          })) as ChatboxSettings;
        }
        toast.success("Chatbox created");
        setViewMode("preview");
        onSavedDraft(created);
        return true;
      }

      await updateChatbox({
        chatboxId,
        ...payload,
      });
      if (chatbox && draftChatboxConfig.mode !== chatbox.mode) {
        await setChatboxMode({
          chatboxId,
          mode: draftChatboxConfig.mode,
        });
      }
      toast.success("Chatbox updated");
      return true;
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to save chatbox"));
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    createChatbox,
    draftChatboxConfig,
    onSavedDraft,
    chatbox,
    chatboxId,
    chatboxHostConfig,
    projectDefaultHostConfig,
    setChatboxMode,
    updateChatbox,
    projectId,
    projectServers,
  ]);

  const saveAndOpenPreview = useCallback(async () => {
    const ok = await saveChatbox();
    if (ok) {
      setViewMode("preview");
    }
  }, [saveChatbox]);

  const handleCopyLink = useCallback(async () => {
    if (!shareLink) {
      toast.error("Chatbox link unavailable");
      return;
    }
    const didCopy = await copyToClipboard(shareLink);
    if (didCopy) {
      toast.success("Chatbox link copied");
    } else {
      toast.error("Failed to copy link");
    }
  }, [shareLink]);

  const handleOpenFullPreview = useCallback(() => {
    if (!chatbox?.link?.token) {
      toast.error("Chatbox link unavailable");
      return;
    }
    const link = buildPlaygroundChatboxLink(
      chatbox.link.token,
      draftChatboxConfig.name || chatbox.name,
      playgroundId
    );
    window.open(link, "_blank", "noopener,noreferrer");
  }, [chatbox, draftChatboxConfig.name, playgroundId]);

  const handleAddServer = useCallback(
    async (formData: ServerFormData) => {
      if (formData.type !== "http") {
        toast.error("Only HTTP servers can be used in chatboxes");
        return;
      }
      if (isInsecureUrl(formData.url)) {
        toast.error("Only HTTPS servers can be used in chatboxes");
        return;
      }
      try {
        const serverId = (await createServer({
          projectId,
          name: formData.name,
          enabled: true,
          transportType: "http",
          url: formData.url,
          headers: formData.headers,
          timeout: formData.requestTimeout,
          useOAuth: formData.useOAuth,
          oauthScopes: formData.oauthScopes,
          clientId: formData.clientId,
        })) as string;
        setDraftChatboxConfig((current) => ({
          ...current,
          selectedServerIds: updateSelectedServerIds(
            current.selectedServerIds,
            serverId,
            true
          ),
        }));
        setSelectedNodeId(`server:${serverId}`);
        setFocusedSetupSection("servers");
        setIsSetupSheetOpen(true);
        toast.success(`Server "${formData.name}" added`);
      } catch (error) {
        toast.error(getBillingErrorMessage(error, "Failed to add server"));
      }
    },
    [createServer, projectId]
  );

  const handleToggleServer = useCallback(
    (serverId: string, checked: boolean) => {
      setDraftChatboxConfig((current) => {
        const selectedServerIds = updateSelectedServerIds(
          current.selectedServerIds,
          serverId,
          checked
        );

        if (selectedServerIds === current.selectedServerIds) {
          return current;
        }

        const optionalServerIds = checked
          ? current.optionalServerIds
          : current.optionalServerIds.filter((id) => id !== serverId);

        return {
          ...current,
          selectedServerIds,
          optionalServerIds,
        };
      });

      if (checked) {
        setSelectedNodeId(`server:${serverId}`);
        setFocusedSetupSection("servers");
        setIsSetupSheetOpen(true);
        return;
      }

      setSelectedNodeId((current) =>
        current === `server:${serverId}` ? "host" : current
      );
    },
    []
  );

  const previewRailConfig = useMemo(() => {
    if (chatbox && isDirty) {
      return {
        hostStyle: chatbox.hostStyle,
        serverCount: chatbox.servers.length,
        welcomeOn: chatbox.chatUi?.surfaces?.welcome?.enabled ?? true,
        feedbackOn: chatbox.chatUi?.surfaces?.feedback?.enabled ?? true,
        feedbackEvery: Math.max(
          1,
          chatbox.chatUi?.surfaces?.feedback?.everyNToolCalls ?? 1
        ),
      };
    }
    return {
      hostStyle: draftChatboxConfig.hostStyle,
      serverCount: draftChatboxConfig.selectedServerIds.length,
      welcomeOn: draftChatboxConfig.chatUi.surfaces.welcome.enabled,
      feedbackOn: draftChatboxConfig.chatUi.surfaces.feedback.enabled,
      feedbackEvery: draftChatboxConfig.chatUi.surfaces.feedback.everyNToolCalls,
    };
  }, [chatbox, isDirty, draftChatboxConfig]);

  const reloadPreview = useCallback(() => {
    const nextId = crypto.randomUUID();
    setPlaygroundId(nextId);
    setChatKey((k) => k + 1);
  }, []);

  const setupPanelSharedProps = {
    chatboxDraft: draftChatboxConfig,
    savedChatbox: chatbox ?? null,
    projectServers,
    projectName,
    focusedSection: focusedSetupSection,
    isUnsavedNewDraft: !chatboxId,
    onDraftChange: (updater: (d: ChatboxDraftConfig) => ChatboxDraftConfig) =>
      setDraftChatboxConfig((current) => updater(current)),
    onOpenAddServer: () => {
      setFocusedSetupSection("servers");
      setIsSetupSheetOpen(true);
      setIsAddServerOpen(true);
    },
    onToggleServer: handleToggleServer,
    inviteChatboxMember: chatboxId
      ? async (email: string) => {
          await upsertChatboxMember({
            chatboxId,
            email: email.trim().toLowerCase(),
            sendInviteEmail: true,
          });
        }
      : undefined,
  };

  const setupPanelDesktop = (
    <div className="chatbox-builder-pane flex h-full min-h-0 flex-col border-l border-border/70">
      <SetupChecklistPanel {...setupPanelSharedProps} />
    </div>
  );

  const setupPanelMobile = (
    <div className="chatbox-builder-pane flex h-full min-h-0 flex-col border-l border-border/70">
      <SetupChecklistPanel
        {...setupPanelSharedProps}
        onCloseMobile={() => setIsSetupSheetOpen(false)}
      />
    </div>
  );

  const showDesktopSetupPanel = viewMode === "setup" && !isMobile;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ChatboxBuilderChrome
        title={viewModel.title}
        isDirty={isDirty}
        isSaving={isSaving}
        hasSavedChatbox={hasSavedChatbox}
        setupHasBlockingSections={setupHasBlockingSections}
        viewMode={viewMode}
        onBack={onBack}
        onSave={() => void saveChatbox()}
        mobilePreviewActions={
          viewMode === "preview" ? (
            <div className="contents md:hidden">
              <ChatboxPreviewActionButtons
                variant="mobileHeader"
                hasSavedChatbox={hasSavedChatbox}
                onCopyLink={() => void handleCopyLink()}
                onOpenFullPreview={handleOpenFullPreview}
                onReloadPreview={reloadPreview}
              />
            </div>
          ) : null
        }
        onModeChange={(mode) => {
          if (mode === "preview" && !chatbox?.link?.token) {
            toast.error("Save the chatbox first to preview");
            return;
          }
          if ((mode === "usage" || mode === "insights") && !chatbox) {
            return;
          }
          setViewMode(mode);
        }}
      />

      {(viewMode === "usage" || viewMode === "insights") && chatbox ? (
        <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
          <ChatboxUsagePanel
            chatbox={chatbox}
            section={viewMode === "insights" ? "insights" : "sessions"}
          />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 p-4">
          {isMobile && viewMode === "setup" && !isSetupSheetOpen ? (
            <Button
              type="button"
              className="absolute right-6 bottom-6 z-10 rounded-full shadow-lg"
              onClick={() => setIsSetupSheetOpen(true)}
            >
              Setup
            </Button>
          ) : null}
          <div ref={panelGroupContainerRef} className="h-full">
            <ResizablePanelGroup direction="horizontal" className="h-full">
              <ResizablePanel
                defaultSize={desktopLeftPanelDefaultSize}
                minSize={30}
              >
                <div className="h-full min-h-0 pr-2">
                  {viewMode === "preview" ? (
                    <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border/70 bg-card/60">
                        {isDirty && chatbox ? (
                          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100">
                            <span className="font-medium">
                              Preview is showing the last saved chatbox
                              configuration.
                            </span>{" "}
                            <Button
                              variant="link"
                              className="h-auto p-0 text-amber-950 underline dark:text-amber-100"
                              onClick={() => void saveChatbox()}
                            >
                              Save changes
                            </Button>
                            {" · "}
                            <Button
                              variant="link"
                              className="h-auto p-0 text-amber-950 underline dark:text-amber-100"
                              onClick={reloadPreview}
                            >
                              Reload preview
                            </Button>
                          </div>
                        ) : null}
                        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                          {chatbox?.link?.token ? (
                            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                              <ChatboxHostStyleProvider
                                value={draftChatboxConfig.hostStyle}
                              >
                              <ChatboxHostCapabilitiesOverrideProvider
                                value={chatboxHostConfig?.hostCapabilitiesOverride}
                              >
                                <ChatTabV2
                                  key={chatKey}
                                  connectedOrConnectingServerConfigs={
                                    chatboxServerConfigs
                                  }
                                  selectedServerNames={Object.keys(
                                    chatboxServerConfigs
                                  )}
                                  minimalMode
                                  reasoningDisplayMode="hidden"
                                  hostedContext={{
                                    chatboxId: chatbox.chatboxId,
                                    chatboxSurface: "preview",
                                    projectId: chatbox!.projectId,
                                    selectedServerIds: activePreviewServers.map(
                                      (s) => s.serverId
                                    ),
                                  }}
                                  executionConfig={{
                                    modelId: draftChatboxConfig.modelId,
                                    systemPrompt:
                                      draftChatboxConfig.systemPrompt,
                                    temperature: draftChatboxConfig.temperature,
                                    requireToolApproval:
                                      draftChatboxConfig.requireToolApproval,
                                  }}
                                  loadingIndicatorVariant={getLoadingIndicatorVariantForHostStyle(
                                    draftChatboxConfig.hostStyle
                                  )}
                                  onOAuthRequired={handlePreviewOAuthRequired}
                                  chatboxComposerBlocked={composerBlocked}
                                  chatboxComposerBlockedReason={
                                    composerBlockedReason ?? ""
                                  }
                                  chatboxOptionalInventory={selectedPreviewServers
                                    .filter(
                                      (s) =>
                                        s.optional &&
                                        !previewEnabledOptionalIds.includes(
                                          s.serverId
                                        )
                                    )
                                    .map((s) => ({
                                      serverId: s.serverId,
                                      serverName: s.serverName,
                                      useOAuth: s.useOAuth,
                                    }))}
                                  onEnableChatboxOptionalServer={(id) => {
                                    setPreviewEnabledOptionalIds((prev) =>
                                      prev.includes(id) ? prev : [...prev, id]
                                    );
                                  }}
                                />
                              </ChatboxHostCapabilitiesOverrideProvider>
                              </ChatboxHostStyleProvider>
                              <ChatboxHostOnboardingOverlays
                                showWelcome={introGate.showWelcome}
                                onGetStarted={introGate.dismissIntro}
                                welcomeBody={
                                  draftChatboxConfig.chatUi.surfaces.welcome.body
                                }
                                showAuthPanel={introGate.showAuthPanel}
                                pendingOAuthServers={pendingOAuthServers}
                                authorizeServer={authorizeServer}
                                isFinishingOAuth={isFinishingPreviewOAuth}
                              />
                            </div>
                          ) : (
                            <div className="flex flex-1 items-center justify-center p-6">
                              <Card className="max-w-sm rounded-3xl border-dashed p-6 text-center">
                                <h3 className="text-base font-semibold">
                                  Preview unavailable
                                </h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                  Save the chatbox to generate a preview link.
                                </p>
                              </Card>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="hidden h-full min-h-0 w-full shrink-0 flex-col gap-4 rounded-[28px] border border-border/70 bg-card/50 p-4 md:flex md:w-[300px] lg:w-[320px]">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Chatbox config
                          </p>
                          <dl className="mt-3 space-y-2 text-sm">
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">
                                Host style
                              </dt>
                              <dd>
                                {getChatboxHostStyleShortLabel(
                                  previewRailConfig.hostStyle
                                )}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Servers</dt>
                              <dd>
                                {previewConnectStatus.totalCount > 0
                                  ? `${previewConnectStatus.readyCount}/${previewConnectStatus.totalCount} connected`
                                  : `${previewRailConfig.serverCount} configured`}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">
                                Welcome dialog
                              </dt>
                              <dd>
                                {previewRailConfig.welcomeOn ? "On" : "Off"}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">
                                Feedback
                              </dt>
                              <dd>
                                {previewRailConfig.feedbackOn
                                  ? `Every ${previewRailConfig.feedbackEvery} tool call(s)`
                                  : "Off"}
                              </dd>
                            </div>
                          </dl>
                        </div>
                        <div
                          className="mt-auto border-t border-border/60 pt-4"
                          data-testid="chatbox-builder-preview-rail-actions"
                        >
                          <ChatboxPreviewActionButtons
                            variant="sidebar"
                            hasSavedChatbox={hasSavedChatbox}
                            onCopyLink={() => void handleCopyLink()}
                            onOpenFullPreview={handleOpenFullPreview}
                            onReloadPreview={reloadPreview}
                          />
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex h-full min-h-0 flex-col">
                      <div className="min-h-0 flex-1">
                        <ReactFlowProvider>
                          <ChatboxCanvas
                            viewModel={viewModel}
                            selectedNodeId={selectedNodeId}
                            canvasViewportRefitNonce={canvasViewportRefitNonce}
                            builderModelId={draftChatboxConfig.modelId}
                            canvasServerPicker={{
                              projectServers,
                              selectedServerIds:
                                draftChatboxConfig.selectedServerIds,
                              onToggleServer: handleToggleServer,
                              onOpenAddProjectServer: () => {
                                setFocusedSetupSection("servers");
                                setIsSetupSheetOpen(true);
                                setIsAddServerOpen(true);
                              },
                            }}
                            onSelectNode={(nodeId) => {
                              setSelectedNodeId(nodeId);
                              setFocusedSetupSection(
                                getSetupSectionForNode(nodeId)
                              );
                              setIsSetupSheetOpen(true);
                            }}
                            onClearSelection={() => {
                              setSelectedNodeId(null);
                            }}
                          />
                        </ReactFlowProvider>
                      </div>
                    </div>
                  )}
                </div>
              </ResizablePanel>

              {showDesktopSetupPanel ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    ref={rightPanelRef}
                    defaultSize={desktopRightPanelDefaultSize}
                    minSize={DESKTOP_SETUP_RAIL_MIN_PERCENT}
                    maxSize={DESKTOP_SETUP_RAIL_MAX_PERCENT}
                    onResize={(size) => setDesktopSettingsPaneSize(size)}
                  >
                    {setupPanelDesktop}
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          </div>
          {viewMode === "setup" ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-4 pb-5">
              <div className="pointer-events-auto flex max-w-lg flex-col items-center gap-2 rounded-4xl border border-border/50 bg-background/90 px-5 py-3 shadow-[0_12px_40px_-8px_rgba(0,0,0,0.28)] backdrop-blur-md dark:shadow-[0_12px_48px_-10px_rgba(0,0,0,0.55)]">
                <Button
                  size="lg"
                  className="h-12 rounded-full px-8 text-base font-semibold shadow-md"
                  onClick={() => void saveAndOpenPreview()}
                  disabled={isSaving || setupHasBlockingSections}
                  title={
                    setupHasBlockingSections
                      ? "Resolve every section marked Attention in Setup before previewing."
                      : undefined
                  }
                >
                  Save and open preview
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}

      <Sheet
        open={isMobile && viewMode === "setup" && isSetupSheetOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsSetupSheetOpen(false);
          }
        }}
      >
        <SheetContent
          side="bottom"
          className="h-[78vh] rounded-t-[28px] border-border/70 p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Chatbox setup</SheetTitle>
            <SheetDescription>
              Configure host style, servers, access, and feedback.
            </SheetDescription>
          </SheetHeader>
          {setupPanelMobile}
        </SheetContent>
      </Sheet>

      <AddServerModal
        isOpen={isAddServerOpen}
        onClose={() => setIsAddServerOpen(false)}
        onSubmit={(formData) => void handleAddServer(formData)}
        initialData={{ type: "http" }}
        requireHttps
      />
    </div>
  );
}
