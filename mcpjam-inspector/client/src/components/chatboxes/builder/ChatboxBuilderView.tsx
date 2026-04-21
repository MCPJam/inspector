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
import { useConvexAuth } from "convex/react";
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
import { useServerMutations, type RemoteServer } from "@/hooks/useWorkspaces";
import { copyToClipboard } from "@/lib/clipboard";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { getChatboxHostStyleShortLabel } from "@/lib/chatbox-host-style";
import { ChatTabV2 } from "@/components/ChatTabV2";
import { getLoadingIndicatorVariantForHostStyle } from "@/components/chat-v2/shared/loading-indicator-content";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { isHostedOAuthBusy } from "@/lib/hosted-oauth-resume";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";
import { ChatboxHostOnboardingOverlays } from "@/components/hosted/ChatboxHostOnboardingOverlays";
import { useChatboxHostIntroGate } from "@/components/hosted/useChatboxHostIntroGate";
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
import type { ServerFormData } from "@/shared/types";
import { buildChatboxCanvas } from "./chatboxCanvasBuilder";
import { ChatboxCanvas } from "./ChatboxCanvas";
import { DEFAULT_SYSTEM_PROMPT, toDraftConfig } from "./drafts";
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
  workspaceId: string;
  workspaceName?: string | null;
  workspaceServers: RemoteServer[];
  chatboxId?: string | null;
  draft: ChatboxDraftConfig | null;
  initialViewMode?: "setup" | "preview" | "usage" | "insights";
  onBack: () => void;
  onSavedDraft: (chatbox: ChatboxSettings) => void;
}

/** Right (setup) rail: favor setup on desktop */
const DESKTOP_SETUP_RAIL_DEFAULT_PERCENT = 60;
const DESKTOP_SETUP_RAIL_MIN_PERCENT = 40;
const DESKTOP_SETUP_RAIL_MAX_PERCENT = 70;

type ViewMode = "setup" | "preview" | "usage" | "insights";

function normalizeInitialViewMode(
  mode: string | undefined,
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
  const buttonClass = isSidebar ? "w-full justify-start rounded-xl" : "rounded-xl";

  return (
    <div
      className={
        isSidebar
          ? "flex flex-col gap-2"
          : "flex w-full flex-wrap items-center justify-end gap-2"
      }
    >
      {showCopyLink ? (
        <Button
          variant="outline"
          className={buttonClass}
          onClick={onCopyLink}
        >
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

        <nav
          className="order-3 flex w-full justify-center gap-1 overflow-x-auto [-webkit-overflow-scrolling:touch] md:order-2 md:w-auto md:max-w-full md:py-0"
          aria-label="Chatbox modes"
        >
          {(
            [
              ["setup", "Setup"],
              ["preview", "Preview"],
              ["usage", "Sessions"],
              ["insights", "Insights"],
            ] as const
          ).map(([mode, label]) => {
            const active = viewMode === mode;
            const disabled =
              mode === "preview" && !hasSavedChatbox
                ? true
                : (mode === "usage" || mode === "insights") && !hasSavedChatbox;
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                onClick={() => onModeChange(mode)}
                className={`relative min-h-10 shrink-0 px-4 py-2 text-sm font-medium transition-colors sm:min-h-11 sm:px-5 sm:text-base md:min-h-10 md:px-4 lg:px-6 ${
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
              >
                {label}
                {active ? (
                  <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary sm:inset-x-4 md:inset-x-3 lg:inset-x-6" />
                ) : null}
              </button>
            );
          })}
        </nav>

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
  workspaceId,
  workspaceName,
  workspaceServers,
  chatboxId,
  draft,
  initialViewMode,
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

  const [draftChatboxConfig, setDraftChatboxConfig] =
    useState<ChatboxDraftConfig>(() => {
      const base =
        draft ??
        toDraftConfig(
          chatbox ??
            ({
              chatboxId: "",
              workspaceId,
              name: "New Chatbox",
              hostStyle: "claude",
              systemPrompt: DEFAULT_SYSTEM_PROMPT,
              modelId: "openai/gpt-5-mini",
              temperature: 0.7,
              requireToolApproval: false,
              allowGuestAccess: false,
              mode: "any_signed_in_with_link",
              servers: [],
              link: null,
              members: [],
              welcomeDialog: { enabled: true, body: "" },
              feedbackDialog: {
                enabled: true,
                everyNToolCalls: 1,
                promptHint: "",
              },
            } as ChatboxSettings),
        );
      return {
        ...base,
        optionalServerIds: base.optionalServerIds ?? [],
      };
    });
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => normalizeInitialViewMode(initialViewMode) ?? "setup",
  );
  const [chatKey, setChatKey] = useState(0);
  const [playgroundId, setPlaygroundId] = useState(() => crypto.randomUUID());
  const [isSetupSheetOpen, setIsSetupSheetOpen] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("host");
  const [focusedSetupSection, setFocusedSetupSection] =
    useState<SetupSectionId | null>(null);
  const [desktopSettingsPaneSize, setDesktopSettingsPaneSize] = useState(
    DESKTOP_SETUP_RAIL_DEFAULT_PERCENT,
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
      workspaceId,
      chatboxId: chatboxId ?? null,
      draft: draftChatboxConfig as unknown as Record<string, unknown>,
      viewMode,
    });
  }, [workspaceId, chatboxId, draftChatboxConfig, viewMode]);

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
        welcomeDialog: draftChatboxConfig.welcomeDialog,
        feedbackDialog: draftChatboxConfig.feedbackDialog,
        selectedServerIds: [...draftChatboxConfig.selectedServerIds].sort(),
        optionalServerIds: [...draftChatboxConfig.optionalServerIds].sort(),
      }),
    [draftChatboxConfig],
  );

  const setupHasBlockingSections = useMemo(() => {
    const statuses = computeSectionStatuses(
      draftChatboxConfig,
      workspaceServers,
    );
    return Object.values(statuses).some((kind) => kind === "attention");
  }, [draftChatboxConfig, workspaceServers]);

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
        const server = workspaceServers.find((s) => s._id === id);
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
      workspaceId: chatbox.workspaceId,
      chatboxId: chatbox.chatboxId,
      name: draftChatboxConfig.name,
      description: draftChatboxConfig.description || undefined,
      hostStyle: draftChatboxConfig.hostStyle,
      mode: draftChatboxConfig.mode,
      allowGuestAccess: draftChatboxConfig.allowGuestAccess,
      viewerIsWorkspaceMember: true,
      systemPrompt: draftChatboxConfig.systemPrompt,
      modelId: draftChatboxConfig.modelId,
      temperature: draftChatboxConfig.temperature,
      requireToolApproval: draftChatboxConfig.requireToolApproval,
      servers,
      welcomeDialog: draftChatboxConfig.welcomeDialog,
    };

    writePlaygroundSession({
      token: chatbox.link.token,
      payload,
      surface: "preview",
      playgroundId,
      updatedAt: Date.now(),
    });
  }, [draftChatboxConfig, chatbox, workspaceServers, playgroundId]);

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
      workspaceServers,
    }),
    [draftChatboxConfig, chatbox, workspaceServers],
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
      JSON.stringify(draftChatboxConfig.welcomeDialog) !==
        JSON.stringify({
          enabled: chatbox.welcomeDialog?.enabled ?? true,
          body: chatbox.welcomeDialog?.body ?? "",
        }) ||
      JSON.stringify(draftChatboxConfig.feedbackDialog) !==
        JSON.stringify({
          enabled: chatbox.feedbackDialog?.enabled ?? true,
          everyNToolCalls: Math.max(
            1,
            chatbox.feedbackDialog?.everyNToolCalls ?? 1,
          ),
          promptHint: chatbox.feedbackDialog?.promptHint ?? "",
        }) ||
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
        chatboxPreviewEnabledOptionalStorageKey(introChatboxId),
      );
      if (!raw) {
        setPreviewEnabledOptionalIds((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const optionalSet = new Set(draftChatboxConfig.optionalServerIds);
      const next = parsed.filter(
        (id): id is string => typeof id === "string" && optionalSet.has(id),
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
      const server = workspaceServers.find((s) => s._id === id);
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
    workspaceServers,
  ]);

  const requiredPreviewServers = useMemo(
    () => selectedPreviewServers.filter((s) => !s.optional),
    [selectedPreviewServers],
  );

  const activePreviewServers = useMemo(() => {
    const enabled = new Set(previewEnabledOptionalIds);
    const optionalActive = selectedPreviewServers.filter(
      (s) => s.optional && enabled.has(s.serverId),
    );
    return [...requiredPreviewServers, ...optionalActive];
  }, [
    requiredPreviewServers,
    selectedPreviewServers,
    previewEnabledOptionalIds,
  ]);

  const chatboxServerConfigs = useMemo(() => {
    const entries = activePreviewServers.flatMap((preview) => {
      const server = workspaceServers.find((s) => s._id === preview.serverId);
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
  }, [activePreviewServers, workspaceServers]);

  const previewOAuthGateServers = useMemo(
    () => activePreviewServers.map(bootstrapServerToHostedOAuthDescriptor),
    [activePreviewServers],
  );

  const {
    oauthStateByServerId,
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
    hasBusyOAuth,
  } = useHostedOAuthGate({
    surface: "chatbox",
    pendingKey: CHATBOX_OAUTH_PENDING_KEY,
    servers: previewOAuthGateServers,
  });

  const previewOAuthTokens = useMemo(() => {
    const entries = activePreviewServers
      .map((server) => {
        const token = getStoredTokens(server.serverName)?.access_token;
        return token ? ([server.serverId, token] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] =>
        Array.isArray(entry),
      );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [oauthStateByServerId, activePreviewServers]);

  const isFinishingPreviewOAuth =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ state }) => isHostedOAuthBusy(state.status));

  const oauthPending = pendingOAuthServers.length > 0;
  const welcomeAvailable =
    draftChatboxConfig.welcomeDialog.enabled &&
    !!draftChatboxConfig.welcomeDialog.body?.trim();
  const introGate = useChatboxHostIntroGate({
    chatboxId: introChatboxId,
    servers: requiredPreviewServers,
    oauthPending,
    hasBusyOAuth,
    pendingOAuthServers,
    welcomeAvailable,
  });

  const handlePreviewOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      markOAuthRequired(details);
    },
    [markOAuthRequired],
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
        draftChatboxConfig.optionalServerIds,
      ) < 1
    ) {
      toast.error("At least one server must be required (on by default)");
      return false;
    }
    const selectedServers = workspaceServers.filter((server) =>
      draftChatboxConfig.selectedServerIds.includes(server._id),
    );
    if (selectedServers.some((server) => isInsecureUrl(server.url))) {
      toast.error("Only HTTPS servers can be used in chatboxes");
      return false;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: draftChatboxConfig.description.trim() || undefined,
        hostStyle: draftChatboxConfig.hostStyle,
        systemPrompt:
          draftChatboxConfig.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
        modelId: draftChatboxConfig.modelId,
        temperature: draftChatboxConfig.temperature,
        requireToolApproval: draftChatboxConfig.requireToolApproval,
        serverIds: draftChatboxConfig.selectedServerIds,
        optionalServerIds: draftChatboxConfig.optionalServerIds,
        allowGuestAccess: draftChatboxConfig.allowGuestAccess,
        welcomeDialog: draftChatboxConfig.welcomeDialog,
        feedbackDialog: draftChatboxConfig.feedbackDialog,
      };

      if (!chatbox) {
        let created = (await createChatbox({
          workspaceId,
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
        chatboxId: chatbox.chatboxId,
        ...payload,
      });
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
    setChatboxMode,
    updateChatbox,
    workspaceId,
    workspaceServers,
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
      playgroundId,
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
          workspaceId,
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
            true,
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
    [createServer, workspaceId],
  );

  const handleToggleServer = useCallback(
    (serverId: string, checked: boolean) => {
      setDraftChatboxConfig((current) => {
        const selectedServerIds = updateSelectedServerIds(
          current.selectedServerIds,
          serverId,
          checked,
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
        current === `server:${serverId}` ? "host" : current,
      );
    },
    [],
  );

  const previewRailConfig = useMemo(() => {
    if (chatbox && isDirty) {
      return {
        hostStyle: chatbox.hostStyle,
        serverCount: chatbox.servers.length,
        welcomeOn: chatbox.welcomeDialog?.enabled ?? true,
        feedbackOn: chatbox.feedbackDialog?.enabled ?? true,
        feedbackEvery: Math.max(
          1,
          chatbox.feedbackDialog?.everyNToolCalls ?? 1,
        ),
      };
    }
    return {
      hostStyle: draftChatboxConfig.hostStyle,
      serverCount: draftChatboxConfig.selectedServerIds.length,
      welcomeOn: draftChatboxConfig.welcomeDialog.enabled,
      feedbackOn: draftChatboxConfig.feedbackDialog.enabled,
      feedbackEvery: draftChatboxConfig.feedbackDialog.everyNToolCalls,
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
    workspaceServers,
    workspaceName,
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
                                <ChatTabV2
                                  key={chatKey}
                                  connectedOrConnectingServerConfigs={
                                    chatboxServerConfigs
                                  }
                                  selectedServerNames={Object.keys(
                                    chatboxServerConfigs,
                                  )}
                                  minimalMode
                                  reasoningDisplayMode="hidden"
                                  hostedWorkspaceIdOverride={
                                    chatbox!.workspaceId
                                  }
                                  hostedSelectedServerIdsOverride={activePreviewServers.map(
                                    (s) => s.serverId,
                                  )}
                                  hostedOAuthTokensOverride={previewOAuthTokens}
                                  hostedChatboxToken={chatbox.link.token}
                                  hostedChatboxSurface="preview"
                                  initialModelId={draftChatboxConfig.modelId}
                                  initialSystemPrompt={
                                    draftChatboxConfig.systemPrompt
                                  }
                                  initialTemperature={
                                    draftChatboxConfig.temperature
                                  }
                                  initialRequireToolApproval={
                                    draftChatboxConfig.requireToolApproval
                                  }
                                  loadingIndicatorVariant={getLoadingIndicatorVariantForHostStyle(
                                    draftChatboxConfig.hostStyle,
                                  )}
                                  onOAuthRequired={handlePreviewOAuthRequired}
                                  chatboxComposerBlocked={
                                    introGate.composerBlocked
                                  }
                                  chatboxComposerBlockedReason="Get started or authorize to send messages…"
                                  chatboxOptionalInventory={selectedPreviewServers
                                    .filter(
                                      (s) =>
                                        s.optional &&
                                        !previewEnabledOptionalIds.includes(
                                          s.serverId,
                                        ),
                                    )
                                    .map((s) => ({
                                      serverId: s.serverId,
                                      serverName: s.serverName,
                                      useOAuth: s.useOAuth,
                                    }))}
                                  onEnableChatboxOptionalServer={(id) => {
                                    setPreviewEnabledOptionalIds((prev) =>
                                      prev.includes(id) ? prev : [...prev, id],
                                    );
                                  }}
                                />
                              </ChatboxHostStyleProvider>
                              <ChatboxHostOnboardingOverlays
                                showWelcome={introGate.showWelcome}
                                onGetStarted={introGate.dismissIntro}
                                welcomeBody={draftChatboxConfig.welcomeDialog.body}
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
                                  previewRailConfig.hostStyle,
                                )}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Servers</dt>
                              <dd>{previewRailConfig.serverCount} connected</dd>
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
                              workspaceServers,
                              selectedServerIds:
                                draftChatboxConfig.selectedServerIds,
                              onToggleServer: handleToggleServer,
                              onOpenAddWorkspaceServer: () => {
                                setFocusedSetupSection("servers");
                                setIsSetupSheetOpen(true);
                                setIsAddServerOpen(true);
                              },
                            }}
                            onSelectNode={(nodeId) => {
                              setSelectedNodeId(nodeId);
                              setFocusedSetupSection(
                                getSetupSectionForNode(nodeId),
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
