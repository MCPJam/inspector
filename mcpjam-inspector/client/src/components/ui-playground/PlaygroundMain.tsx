/**
 * PlaygroundMain
 *
 * Main center panel for the UI Playground that combines:
 * - Deterministic tool execution (injected as messages)
 * - LLM-driven chat continuation
 * - Widget rendering via Thread component
 *
 * Uses the shared useChatSession hook for chat infrastructure.
 * Device/display mode handling is delegated to the Thread component
 * which manages PiP/fullscreen at the widget level.
 */

import {
  FormEvent,
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { Braces, Loader2, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { useAuth } from "@workos-inc/authkit-react";
import type { ContentBlock } from "@modelcontextprotocol/client";
import type { UIMessage } from "ai";
import { toast } from "sonner";
import { ModelDefinition } from "@/shared/types";
import { cn } from "@/lib/utils";
import { Thread } from "@/components/chat-v2/thread";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { StickToBottom } from "use-stick-to-bottom";
import { ScrollToBottomButton } from "@/components/chat-v2/shared/scroll-to-bottom-button";
import {
  formatErrorMessage,
  DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
  MINIMAL_CHAT_COMPOSER_PLACEHOLDER,
  cloneUiMessages,
  extractUserMessageText,
} from "@/components/chat-v2/shared/chat-helpers";
import { SaveAsTestCaseAction } from "@/components/chat-v2/shared/save-as-test-case-action";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import { MultiModelStartersEmptyLayout } from "@/components/chat-v2/multi-model-starters-empty";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
import {
  type ChatSessionResetReason,
  useChatSession,
} from "@/hooks/use-chat-session";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import { createDeterministicToolMessages } from "./playground-helpers";
import type { MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import {
  type FileAttachment,
  attachmentsToFileUIParts,
  revokeFileAttachmentUrls,
} from "@/components/chat-v2/chat-input/attachments/file-utils";
import {
  useUIPlaygroundStore,
  type DeviceType,
  type DisplayMode,
} from "@/stores/ui-playground-store";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import {
  getChatboxChatBackground,
  getChatboxHostFamily,
} from "@/lib/chatbox-client-style";
import { DEFAULT_HOST_STYLE } from "@/lib/client-styles";
import { PRESET_DEVICE_CONFIGS } from "@/components/shared/ClientContextHeader";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { Settings2 } from "lucide-react";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { useConvexAuth } from "convex/react";
import { useHost } from "@/hooks/useClients";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useProjectServers } from "@/hooks/useViews";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import { useHostContextStore } from "@/stores/client-context-store";
import {
  extractEffectiveHostDisplayMode,
  extractHostTheme,
  type ProjectHostContextDraft,
} from "@/lib/client-config";
import { PostConnectGuide } from "@/components/app-builder/PostConnectGuide";
import {
  ChatboxHostStyleProvider,
  ChatboxHostThemeProvider,
} from "@/contexts/chatbox-client-style-context";
import { ChatboxHostCapabilitiesOverrideProvider } from "@/contexts/chatbox-client-capabilities-override-context";
import { useComposerOnboarding } from "@/hooks/use-composer-onboarding";
import { useModelSelectorLayoutLock } from "@/hooks/use-model-selector-layout-lock";
import {
  getChatComposerInteractivity,
  useChatStopControls,
} from "@/hooks/use-chat-stop-controls";
import { HandDrawnSendHint } from "./HandDrawnSendHint";
import { PlaygroundCenterHeaderBar } from "@/components/playground/PlaygroundCenterHeaderBar";
import { SingleModelTraceDiagnosticsBody } from "@/components/evals/single-model-trace-diagnostics-body";
import type { PlaygroundServerSelectorProps } from "@/components/ActiveServerSelector";
import {
  buildPreludeTraceEnvelope,
  type PreludeTraceExecution,
} from "@/components/ui-playground/live-trace-prelude";
import { type BroadcastChatTurnRequest } from "@/components/chat-v2/multi-model-chat-card";
import { type MultiModelCardSummary } from "@/components/chat-v2/model-compare-card-header";
import {
  MultiModelPlaygroundCard,
  type PlaygroundDeterministicExecutionRequest,
} from "@/components/ui-playground/multi-model-playground-card";
import type { EnsureServersReadyResult } from "@/hooks/use-app-state";
import type { EvalChatHandoff } from "@/lib/eval-chat-handoff";
import {
  chatHistoryAction,
  getChatHistoryDetail,
  type ChatHistorySession,
  type ChatHistoryDetailSession,
  type ChatHistoryWidgetSnapshot,
  type ChatHistoryTurnTrace,
} from "@/lib/apis/web/chat-history-api";
import { resolveRestorableServerNames } from "@/components/chat-v2/history/session-restore";
import {
  getCachedChatHistoryDetail,
  prefetchChatHistorySession,
} from "@/components/chat-v2/history/chat-history-prefetch";
import { usePlaygroundChatHistoryBridgeStore } from "@/components/playground/playground-chat-history-bridge";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { WebApiError } from "@/lib/apis/web/base";
import { useDirectChatSessionSubscription } from "@/hooks/use-direct-chat-session-subscription";

// On post-stream reconcile, the Convex-side detail row may not yet reflect the
// version bump from the turn that just finished. Retry a couple of times.
const RESUMED_THREAD_REFRESH_RETRIES = 2;

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
};

type ThreadThemeMode = "light" | "dark";

interface PlaygroundMainProps {
  activeProjectId?: string | null;
  serverName: string;
  ensureServersReady?: (
    serverNames: string[]
  ) => Promise<EnsureServersReadyResult>;
  onSaveHostContext?: (
    projectId: string,
    hostContext: ProjectHostContextDraft
  ) => Promise<void>;
  enableMultiModelChat?: boolean;
  onWidgetStateChange?: (toolCallId: string, state: unknown) => void;
  playgroundServerSelectorProps?: PlaygroundServerSelectorProps;
  // Execution state for "Invoking" indicator
  isExecuting?: boolean;
  executingToolName?: string | null;
  invokingMessage?: string | null;
  // Deterministic execution
  pendingExecution: {
    toolName: string;
    params: Record<string, unknown>;
    result: unknown;
    toolMeta: Record<string, unknown> | undefined;
    state?: "output-available" | "output-error";
    errorText?: string;
    renderOverride?: ToolRenderOverride;
    toolCallId?: string;
    replaceExisting?: boolean;
  } | null;
  onExecutionInjected: (toolCallId?: string) => void;
  toolRenderOverrides?: Record<string, ToolRenderOverride>;
  // Device emulation
  deviceType?: DeviceType;
  onDeviceTypeChange?: (type: DeviceType) => void;
  displayMode?: DisplayMode;
  onDisplayModeChange?: (mode: DisplayMode) => void;
  // Locale (BCP 47)
  locale?: string;
  onLocaleChange?: (locale: string) => void;
  // Timezone (IANA) per SEP-1865
  timeZone?: string;
  onTimeZoneChange?: (timeZone: string) => void;
  // View-mode controls
  disableChatInput?: boolean;
  hideSaveViewButton?: boolean;
  disabledInputPlaceholder?: string;
  // Onboarding
  initialInput?: string;
  /** When true with `initialInput`, reveals the string with a typewriter effect (App Builder NUX). */
  initialInputTypewriter?: boolean;
  /** When true, Send / Enter are blocked until the playground server is connected. */
  blockSubmitUntilServerConnected?: boolean;
  pulseSubmit?: boolean;
  showPostConnectGuide?: boolean;
  onFirstMessageSent?: () => void;
  /**
   * When set, Playground consumes the handoff once `isSessionBootstrapComplete`
   * flips true: applies executionConfig (model, system prompt, temperature,
   * tool-approval), seeds the thread, and calls `onEvalChatHandoffConsumed`.
   * Mirrors the ChatTabV2 behavior so eval "Continue in chat" lands here when
   * `playground-tab-enabled` is on.
   */
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
}

type PlaygroundTraceViewMode = "chat" | "timeline" | "raw";

// Invoking indicator component (ChatGPT-style "Invoking [toolName]")
function InvokingIndicator({
  toolName,
  customMessage,
}: {
  toolName: string;
  customMessage?: string | null;
}) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <Braces className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        {customMessage ? (
          <span>{customMessage}</span>
        ) : (
          <>
            <span>Invoking</span>
            <code className="text-primary font-mono">{toolName}</code>
          </>
        )}
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground ml-auto" />
      </div>
    </div>
  );
}

export function PlaygroundMain({
  activeProjectId = null,
  serverName,
  ensureServersReady,
  onSaveHostContext,
  enableMultiModelChat = false,
  onWidgetStateChange,
  playgroundServerSelectorProps,
  isExecuting,
  executingToolName,
  invokingMessage,
  pendingExecution,
  onExecutionInjected,
  toolRenderOverrides: externalToolRenderOverrides = {},
  // Device/locale/timezone props are now managed via the store by ClientContextHeader
  // These are kept for backward compatibility but are no longer used
  deviceType: _deviceType = "mobile",
  onDeviceTypeChange: _onDeviceTypeChange,
  displayMode: displayModeProp = "inline",
  onDisplayModeChange,
  locale: _locale = "en-US",
  onLocaleChange: _onLocaleChange,
  timeZone: _timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC",
  onTimeZoneChange: _onTimeZoneChange,
  disableChatInput = false,
  hideSaveViewButton = false,
  disabledInputPlaceholder = "Input disabled in Views",
  initialInput,
  initialInputTypewriter = false,
  blockSubmitUntilServerConnected = false,
  pulseSubmit = false,
  showPostConnectGuide = false,
  onFirstMessageSent,
  evalChatHandoff = null,
  onEvalChatHandoffConsumed,
}: PlaygroundMainProps) {
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const clearLogs = useTrafficLogStore((s) => s.clear);
  const sharedThreadsEnabled =
    useFeatureFlagEnabled("shared-threads-enabled") === true;

  // Chat-history coordination — Playground equivalent of ChatTabV2's history
  // machinery, scoped down to what the docked rail actually needs.
  const [activeHistorySessionId, setActiveHistorySessionId] = useState<
    string | null
  >(null);
  const [loadingHistorySessionId, setLoadingHistorySessionId] = useState<
    string | null
  >(null);
  const [pendingDirectVisibility, setPendingDirectVisibility] = useState<
    "private" | "project"
  >("private");
  // ChatTabV2 holds this at 0 today; bumping after each completed turn is a
  // follow-up. The rail re-fetches on initial mount + whenever signal changes.
  const historyRefreshSignal = 0;
  const historySelectionRequestIdRef = useRef(0);
  const activeHistorySessionIdRef = useRef<string | null>(null);
  const reactiveHistoryLoadRequestIdRef = useRef(0);
  const resumedThreadSendBaselineRef = useRef<{
    sessionId: string;
    version: number;
  } | null>(null);

  useEffect(() => {
    activeHistorySessionIdRef.current = activeHistorySessionId;
    reactiveHistoryLoadRequestIdRef.current += 1;
  }, [activeHistorySessionId]);

  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    []
  );
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [traceViewMode, setTraceViewMode] =
    useState<PlaygroundTraceViewMode>("chat");
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);
  const [isFullscreenChatOpen, setIsFullscreenChatOpen] = useState(false);
  const [isPreparingServerForSend, setIsPreparingServerForSend] =
    useState(false);
  const [injectedToolRenderOverrides, setInjectedToolRenderOverrides] =
    useState<Record<string, ToolRenderOverride>>({});
  const [preludeTraceExecutions, setPreludeTraceExecutions] = useState<
    PreludeTraceExecution[]
  >([]);
  const [broadcastRequest, setBroadcastRequest] =
    useState<BroadcastChatTurnRequest | null>(null);
  const [deterministicExecutionRequest, setDeterministicExecutionRequest] =
    useState<PlaygroundDeterministicExecutionRequest | null>(null);
  const [stopBroadcastRequestId, setStopBroadcastRequestId] = useState(0);
  const [multiModelSessionGeneration, setMultiModelSessionGeneration] =
    useState(0);
  const [multiModelSummaries, setMultiModelSummaries] = useState<
    Record<string, MultiModelCardSummary>
  >({});
  const [multiModelHasMessages, setMultiModelHasMessages] = useState<
    Record<string, boolean>
  >({});
  const [multiCompareEnterVersion, setMultiCompareEnterVersion] = useState(0);
  const [multiCompareEnterMessages, setMultiCompareEnterMessages] = useState<
    UIMessage[]
  >([]);
  const [multiAddColumnSeeds, setMultiAddColumnSeeds] = useState<
    Record<string, { version: number; messages: UIMessage[] }>
  >({});
  const multiTranscriptsRef = useRef<Record<string, UIMessage[]>>({});
  const prevCompareModeRef = useRef(false);
  const lastMultiLeadIdRef = useRef<string | null>(null);
  const prevCompareModelIdsRef = useRef<Set<string>>(new Set());
  const multiAddColumnSeqRef = useRef(0);
  // Device config from store (managed by ClientContextHeader)
  const storeDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const hostContext = useHostContextStore((s) => s.draftHostContext);
  const patchHostContext = useHostContextStore((s) => s.patchHostContext);

  // Device config for frame sizing
  const deviceConfig = useMemo(() => {
    if (storeDeviceType === "custom") {
      return {
        ...CUSTOM_DEVICE_BASE,
        width: customViewport.width,
        height: customViewport.height,
      };
    }
    return PRESET_DEVICE_CONFIGS[storeDeviceType];
  }, [storeDeviceType, customViewport]);

  const appState = useSharedAppState();
  const servers = appState.servers;
  const { isAuthenticated: isConvexAuthenticated } = useConvexAuth();
  // Multi-server: when the host has flipped `isMultiSelectEnabled` on (today
  // only the Playground does), `playgroundServerSelectorProps.selectedMultipleServers`
  // is the source of truth for which servers the chat session sees. Otherwise
  // fall back to the single `serverName` prop (App Builder / hosted flows).
  const multiSelectedServerNames = useMemo(() => {
    const propsMulti = playgroundServerSelectorProps?.selectedMultipleServers;
    if (
      playgroundServerSelectorProps?.isMultiSelectEnabled &&
      Array.isArray(propsMulti) &&
      propsMulti.length > 0
    ) {
      return propsMulti.filter(
        (name) => servers[name]?.connectionStatus === "connected"
      );
    }
    return [];
  }, [playgroundServerSelectorProps, servers]);

  const selectedServers = useMemo(() => {
    if (multiSelectedServerNames.length > 0) {
      return multiSelectedServerNames;
    }
    return serverName && servers[serverName]?.connectionStatus === "connected"
      ? [serverName]
      : [];
  }, [multiSelectedServerNames, serverName, servers]);

  const serverConnected = Boolean(
    serverName && servers[serverName]?.connectionStatus === "connected"
  );

  const handlePlaygroundServerToggle = useCallback(
    (name: string) => {
      // Multi-server: toggle membership in the multi-server set so users can
      // have several servers active at once (LLM sees the union of tools,
      // docked tools pane aggregates across them).
      if (
        playgroundServerSelectorProps?.isMultiSelectEnabled &&
        playgroundServerSelectorProps?.onMultiServerToggle
      ) {
        playgroundServerSelectorProps.onMultiServerToggle(name);
        return;
      }
      // Single-server (App Builder, hosted): toggle clears if already selected,
      // else switches to the clicked server.
      if (name === serverName) {
        playgroundServerSelectorProps?.onServerChange("none");
      } else {
        playgroundServerSelectorProps?.onServerChange(name);
      }
    },
    [serverName, playgroundServerSelectorProps]
  );

  // Hosted mode context (projectId, serverIds, OAuth tokens)
  const activeProject = appState.projects[appState.activeProjectId];
  const convexProjectId = activeProject?.sharedProjectId ?? null;
  const hostedOrgModelConfig = useHostedOrgModelConfig({
    projectId: convexProjectId,
    organizationId: activeProject?.organizationId ?? null,
  });
  const { serversById, serversByName } = useProjectServers({
    isAuthenticated: isConvexAuthenticated,
    projectId: convexProjectId,
  });
  const hostedSelectedServerIds = useMemo(
    () =>
      selectedServers
        .map((name) => serversByName.get(name))
        .filter((serverId): serverId is string => !!serverId),
    [selectedServers, serversByName]
  );
  const hostedOAuthTokens = useMemo(
    () =>
      buildOAuthTokensByServerId(
        selectedServers,
        (name) => serversByName.get(name),
        (name) => appState.servers[name]?.oauthTokens?.access_token
      ),
    [selectedServers, serversByName, appState.servers]
  );

  // Mirror the previewed host's chat-execution fields (system prompt,
  // temperature, tool approval, selected servers) into the chat session
  // whenever the resolved (hostId, configId) tuple changes. Imperative
  // setters — not `executionConfig` — so the user can tweak any field
  // in-session without being locked out, and a later host switch
  // re-snapshots from the host config (discarding tweaks).
  //
  // `applyHostConfigToPlayground` (via PlaygroundPreviewedClientSync)
  // covers chip-level fields (hostStyle, capabilities, hostContext, CSP,
  // chatUiOverride, and the model id via localStorage). The fields
  // re-seeded here live inside `useChatSession`'s own state, so they
  // need imperative setters.
  // Match the global host picker / ClientsTab / useAppState scope: prefer
  // the shared project id (what `GlobalClientBar` and `ClientsTab` write),
  // falling back to `activeProjectId` for CLI / no-cloud-sync flows where
  // `convexProjectId` is null. Reading only from `activeProjectId` here
  // silently disabled the reseed in authed projects because the writer
  // wrote under a different storage scope.
  const [previewedHostId] = usePreviewedHostId(
    convexProjectId ?? activeProjectId
  );
  const { host: previewedHost } = useHost({
    isAuthenticated: isConvexAuthenticated,
    hostId: previewedHostId,
  });

  // Use shared chat session hook
  const composerOnResetRef = useRef<() => void>(() => {});
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    error,
    chatSessionId,
    selectedModel,
    setSelectedModel,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
    availableModels,
    isAuthLoading,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    toolsMetadata,
    toolServerMap,
    tokenUsage,
    resetChat,
    startChatWithMessages,
    liveTraceEnvelope,
    requestPayloadHistory,
    hasTraceSnapshot,
    hasLiveTimelineContent,
    traceViewsSupported,
    isStreaming,
    disableForAuthentication,
    submitBlocked,
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse,
    isSessionBootstrapComplete,
    loadChatSession,
    syncResumedVersion,
    resumedVersion,
    restoredToolRenderOverrides,
    status,
  } = useChatSession({
    selectedServers,
    directVisibility: pendingDirectVisibility,
    hostedOrgModelConfig,
    hostedContext: {
      projectId: convexProjectId,
      selectedServerIds: hostedSelectedServerIds,
      oauthTokens: hostedOAuthTokens,
    },
    onReset: (reason?: ChatSessionResetReason) => {
      setModelContextQueue([]);
      setPreludeTraceExecutions([]);
      setInjectedToolRenderOverrides({});
      if (reason === "servers-changed") {
        return;
      }
      composerOnResetRef.current();
    },
  });

  // Set playground active flag for widget renderers to read
  const setPlaygroundActive = useUIPlaygroundStore(
    (s) => s.setPlaygroundActive
  );
  useEffect(() => {
    setPlaygroundActive(true);
    return () => setPlaygroundActive(false);
  }, [setPlaygroundActive]);

  // Re-seed chat-session fields from the previewed host on host change.
  // Dedup-key on `(hostId, configId)` so a stable Convex echo doesn't
  // stomp the user's in-session tweaks every render. Re-firing on configId
  // means saving from the host editor (with the playground open) snaps the
  // composer to the saved values too.
  const onSelectMultipleServers =
    playgroundServerSelectorProps?.onSelectMultipleServers;
  const previewedHostConfigId = previewedHost?.config.id;
  const lastSeededHostRef = useRef<{ hostId: string; configId: string } | null>(
    null
  );
  useEffect(() => {
    if (!previewedHostId || !previewedHost) {
      // Clear the dedupe ref so a later return to the same (hostId, configId)
      // — after a transient host-unavailable phase or project switch — still
      // reseeds the composer instead of short-circuiting on a stale ref.
      lastSeededHostRef.current = null;
      return;
    }
    const configId = previewedHost.config.id;
    const last = lastSeededHostRef.current;
    if (last && last.hostId === previewedHostId && last.configId === configId) {
      return;
    }

    const cfg = previewedHost.config;

    // Map host's required + optional server ids to project server names.
    // Servers the host references but the project no longer has are
    // dropped — selectedMultipleServers must contain valid names.
    //
    // Guard the dedupe-ref commit on this resolution: if the host references
    // servers but `serversById` hasn't hydrated yet (empty map on first pass),
    // bail without marking the (hostId, configId) seeded so a later render
    // with a populated map can finish the seed.
    const ids = [...(cfg.serverIds ?? []), ...(cfg.optionalServerIds ?? [])];
    if (ids.length > 0 && serversById.size === 0) return;

    lastSeededHostRef.current = { hostId: previewedHostId, configId };

    setSystemPrompt(cfg.systemPrompt);
    setTemperature(cfg.temperature);
    setRequireToolApproval(cfg.requireToolApproval);

    if (onSelectMultipleServers) {
      const seen = new Set<string>();
      const names: string[] = [];
      for (const id of ids) {
        const name = serversById.get(id);
        if (name && !seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
      }
      onSelectMultipleServers(names);
    }

    // Resolve the host's modelId against the picker's available list and
    // call setSelectedModel so the composer re-renders. The localStorage
    // path in applyHostConfigToPlayground covers cross-tab + cold-start;
    // this covers in-tab host switches without waiting for the storage
    // event round-trip.
    const desiredModelId = cfg.modelId?.trim();
    if (desiredModelId) {
      const match = availableModels.find(
        (m) => String(m.id) === desiredModelId
      );
      if (match) {
        setSelectedModel(match);
      }
    }
    // availableModels intentionally omitted: re-seeding when the model
    // catalog changes (e.g. a BYOK key gets added) would clobber user
    // tweaks. The (hostId, configId) tuple is the seed trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    previewedHostId,
    previewedHostConfigId,
    previewedHost,
    serversById,
    onSelectMultipleServers,
    setSystemPrompt,
    setTemperature,
    setRequireToolApproval,
    setSelectedModel,
  ]);

  // Currently selected protocol (detected from tool metadata)
  const selectedProtocol = useUIPlaygroundStore((s) => s.selectedProtocol);

  // Host chat background: actual chat area colors from each host's UI
  // (separate from the 76 MCP spec widget design tokens)
  const hostStyle = usePreferencesStore((s) => s.hostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (s) => s.hostCapabilitiesOverride
  );
  const globalThemeMode = usePreferencesStore(
    (s) => s.themeMode
  ) as ThreadThemeMode;
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const effectiveThreadTheme = extractHostTheme(hostContext) ?? globalThemeMode;
  const hostStyleFamily = getChatboxHostFamily(hostStyle) ?? "claude";
  const hostBackgroundColor =
    getChatboxChatBackground(hostStyle, effectiveThreadTheme) ??
    DEFAULT_HOST_STYLE.chatUi.resolveChatBackground(effectiveThreadTheme);
  const displayMode =
    extractEffectiveHostDisplayMode(hostContext) ?? displayModeProp;

  const handleDisplayModeChange = useCallback(
    (mode: DisplayMode) => {
      patchHostContext({ displayMode: mode });
      onDisplayModeChange?.(mode);
    },
    [patchHostContext, onDisplayModeChange]
  );

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant"
  );
  const multiModelAvailableModels = useMemo(
    () => new Map(availableModels.map((model) => [String(model.id), model])),
    [availableModels]
  );
  const resolvedSelectedModels = useMemo(() => {
    const persistedModels = selectedModelIds
      .map((modelId) => multiModelAvailableModels.get(modelId))
      .filter((model): model is ModelDefinition => !!model && !model.disabled);

    if (persistedModels.length > 0) {
      return persistedModels.slice(0, 3);
    }

    return selectedModel ? [selectedModel] : [];
  }, [multiModelAvailableModels, selectedModel, selectedModelIds]);
  const canEnableMultiModel =
    enableMultiModelChat && availableModels.length > 1;
  // When viewing a history session the transcript lives on the single chat
  // session; compare layout would override that render. Matches ChatTabV2.
  const isMultiModelMode =
    canEnableMultiModel && multiModelEnabled && !activeHistorySessionId;
  const { isMultiModelLayoutMode, onModelSelectorOpenChange } =
    useModelSelectorLayoutLock(isMultiModelMode);

  useEffect(() => {
    if (isMultiModelMode && resolvedSelectedModels[0]) {
      lastMultiLeadIdRef.current = String(resolvedSelectedModels[0].id);
    }
  }, [isMultiModelMode, resolvedSelectedModels]);

  const handleMultiModelTranscriptSync = useCallback(
    (modelId: string, transcript: UIMessage[]) => {
      multiTranscriptsRef.current[modelId] = cloneUiMessages(transcript);
    },
    []
  );

  const clearMultiModelUiState = useCallback(() => {
    setBroadcastRequest(null);
    setDeterministicExecutionRequest(null);
    setStopBroadcastRequestId(0);
    setMultiModelSummaries({});
    setMultiModelHasMessages({});
    setMultiAddColumnSeeds({});
    prevCompareModelIdsRef.current = new Set();
  }, []);

  useLayoutEffect(() => {
    const prev = prevCompareModeRef.current;
    if (prev && !isMultiModelMode) {
      const leadId = lastMultiLeadIdRef.current;
      if (leadId) {
        const transcript = multiTranscriptsRef.current[leadId];
        const hasConversation =
          transcript?.some(
            (m) => m.role === "user" || m.role === "assistant"
          ) ?? false;
        if (hasConversation && transcript) {
          startChatWithMessages(cloneUiMessages(transcript));
        }
      }
      clearMultiModelUiState();
    }
    if (!prev && isMultiModelMode) {
      setMultiCompareEnterVersion((v) => v + 1);
      setMultiCompareEnterMessages(cloneUiMessages(messages));
    }
    prevCompareModeRef.current = isMultiModelMode;
  }, [
    isMultiModelMode,
    messages,
    startChatWithMessages,
    clearMultiModelUiState,
  ]);

  useEffect(() => {
    if (!isMultiModelMode) {
      prevCompareModelIdsRef.current = new Set();
      return;
    }
    const current = new Set(resolvedSelectedModels.map((m) => String(m.id)));
    const prev = prevCompareModelIdsRef.current;
    const added = [...current].filter((id) => !prev.has(id));
    const leadId = resolvedSelectedModels[0]
      ? String(resolvedSelectedModels[0].id)
      : null;
    if (prev.size > 0 && added.length > 0 && leadId) {
      const src = multiTranscriptsRef.current[leadId] ?? [];
      multiAddColumnSeqRef.current += 1;
      const v = multiAddColumnSeqRef.current;
      setMultiAddColumnSeeds((s) => {
        const next = { ...s };
        for (const id of added) {
          next[id] = { version: v, messages: cloneUiMessages(src) };
        }
        return next;
      });
    }
    prevCompareModelIdsRef.current = current;
  }, [isMultiModelMode, resolvedSelectedModels]);

  const effectiveHasMessages = isMultiModelLayoutMode
    ? Object.values(multiModelHasMessages).some(Boolean)
    : !isThreadEmpty;
  const preludeTraceEnvelope = useMemo(
    () => buildPreludeTraceEnvelope(preludeTraceExecutions),
    [preludeTraceExecutions]
  );
  const effectiveLiveTraceEnvelope =
    hasTraceSnapshot || isStreaming
      ? liveTraceEnvelope
      : preludeTraceEnvelope ?? liveTraceEnvelope;
  // Match ChatTabV2 `showTopTraceViewTabs`: keep Trace/Chat/Raw while multi-model is
  // empty; hide the top bar once compare columns are active (per-card trace tabs take over).
  const showTraceViewTabs =
    traceViewsSupported && (!isMultiModelLayoutMode || !effectiveHasMessages);
  const activeTraceViewMode: PlaygroundTraceViewMode = showTraceViewTabs
    ? traceViewMode
    : "chat";
  const showLiveTraceDiagnostics = activeTraceViewMode !== "chat";
  const showMultiModelTraceEmptyPanel =
    isMultiModelMode &&
    !effectiveHasMessages &&
    showLiveTraceDiagnostics &&
    !showPostConnectGuide;
  const multiModelTracePanelModel =
    selectedModel ?? resolvedSelectedModels[0] ?? null;
  const { isStreamingActive, stopActiveChat } = useChatStopControls({
    isMultiModelMode,
    isStreaming,
    multiModelSummaries,
    setStopBroadcastRequestId,
    stop,
  });

  // Composer onboarding: typewriter effect, guided input, submit gating, NUX CTA
  const composer = useComposerOnboarding({
    initialInput,
    initialInputTypewriter,
    blockSubmitUntilServerConnected,
    pulseSubmit,
    showPostConnectGuide,
    serverConnected,
    isThreadEmpty: !effectiveHasMessages,
  });
  composerOnResetRef.current = composer.onSessionReset;
  const { composerDisabled, sendBlocked } = getChatComposerInteractivity({
    isStreamingActive: isStreamingActive || isPreparingServerForSend,
    composerDisabled:
      disableChatInput || submitBlocked || isPreparingServerForSend,
    submitDisabled:
      disableChatInput ||
      submitBlocked ||
      composer.submitGatedByServer ||
      isPreparingServerForSend,
  });

  useEffect(() => {
    if (!canEnableMultiModel && multiModelEnabled) {
      setMultiModelEnabled(false);
      setSelectedModelIds(selectedModel ? [String(selectedModel.id)] : []);
      return;
    }

    const sanitizedIds = resolvedSelectedModels.map((model) =>
      String(model.id)
    );
    const persistedIds = selectedModelIds.slice(0, 3);
    const idsChanged =
      sanitizedIds.length !== persistedIds.length ||
      sanitizedIds.some((modelId, index) => modelId !== persistedIds[index]);

    if (idsChanged) {
      setSelectedModelIds(
        sanitizedIds.length > 0 && multiModelEnabled
          ? sanitizedIds
          : selectedModel
          ? [String(selectedModel.id)]
          : []
      );
    }
  }, [
    canEnableMultiModel,
    multiModelEnabled,
    resolvedSelectedModels,
    selectedModel,
    selectedModelIds,
    setMultiModelEnabled,
    setSelectedModelIds,
  ]);

  // Eval "Continue in chat" handoff. Mirrors ChatTabV2:1283-1340 so that when
  // `playground-tab-enabled` is on (and `#chat-v2` redirects to `#playground`)
  // the handoff still seeds a chat with the eval's model + messages.
  const appliedEvalChatHandoffIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!evalChatHandoff) return;
    if (!isSessionBootstrapComplete) return;
    if (appliedEvalChatHandoffIdRef.current === evalChatHandoff.id) return;

    const { executionConfig: handoffExec } = evalChatHandoff;
    let matchingModel = null;
    if (handoffExec.modelId) {
      matchingModel = availableModels.find(
        (model) => String(model.id) === handoffExec.modelId
      );
      // Wait for the model list to load — `availableModels.length === 0`
      // means the catalog hasn't arrived yet; re-run when it does.
      if (!matchingModel && availableModels.length === 0) return;
    }

    if (matchingModel) {
      setMultiModelEnabled(false);
      setSelectedModelIds([String(matchingModel.id)]);
      setSelectedModel(matchingModel);
    } else if (selectedModel) {
      setMultiModelEnabled(false);
      setSelectedModelIds([String(selectedModel.id)]);
    }

    startChatWithMessages(evalChatHandoff.messages);
    appliedEvalChatHandoffIdRef.current = evalChatHandoff.id;

    if (typeof handoffExec.systemPrompt === "string") {
      setSystemPrompt(handoffExec.systemPrompt);
    }
    if (typeof handoffExec.temperature === "number") {
      setTemperature(handoffExec.temperature);
    }
    if (typeof handoffExec.requireToolApproval === "boolean") {
      setRequireToolApproval(handoffExec.requireToolApproval);
    }

    composer.setInput("");
    onEvalChatHandoffConsumed?.(evalChatHandoff.id);
  }, [
    availableModels,
    composer,
    evalChatHandoff,
    isSessionBootstrapComplete,
    onEvalChatHandoffConsumed,
    selectedModel,
    setMultiModelEnabled,
    setRequireToolApproval,
    setSelectedModel,
    setSelectedModelIds,
    setSystemPrompt,
    setTemperature,
    startChatWithMessages,
  ]);

  // ------------------------------------------------------------------------
  // Chat history coordination (docked `chatHistory` pane bridge)
  //
  // Ported from ChatTabV2:466-996 with the following intentional differences:
  // - Draft-discard uses `window.confirm` instead of the full DiscardDraftDialog
  //   port (matches PlaygroundHeader's existing window.confirm style).
  // - `widgetStateQueue` is not part of `hasUnsavedDraft` (Playground doesn't
  //   queue widget-state updates the way ChatTabV2 does).
  // - Multi-server restoration: Playground is single-server in v1; if a saved
  //   session selected N servers, we pick the first that maps to a connected
  //   server and call `playgroundServerSelectorProps?.onServerChange(name)`.
  //   If none match we leave the current server selection alone.
  // - `historyRefreshSignal` stays at 0 like ChatTabV2 today; bumping after
  //   completed turns is a follow-up.
  // ------------------------------------------------------------------------

  const hasUnsavedDraft =
    composer.input.trim().length > 0 ||
    mcpPromptResults.length > 0 ||
    skillResults.length > 0 ||
    fileAttachments.length > 0 ||
    modelContextQueue.length > 0;

  const hasUnsavedDraftRef = useRef(hasUnsavedDraft);
  useEffect(() => {
    hasUnsavedDraftRef.current = hasUnsavedDraft;
  }, [hasUnsavedDraft]);

  // Ref so `detachHistorySession` can read the latest messages without
  // listing `messages` in its deps — `messages` churns every streaming
  // token and would otherwise re-create the callback per token, cascading
  // through the bridge into ChatHistoryRail and its rows.
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const [discardDraftDialogOpen, setDiscardDraftDialogOpen] = useState(false);
  const discardDraftResolveRef = useRef<((allow: boolean) => void) | null>(
    null
  );
  const discardDraftSettledRef = useRef(false);

  const settleDiscardDraft = useCallback((confirmed: boolean) => {
    if (discardDraftSettledRef.current) {
      return;
    }
    discardDraftSettledRef.current = true;
    const resolve = discardDraftResolveRef.current;
    discardDraftResolveRef.current = null;
    resolve?.(confirmed);
    setDiscardDraftDialogOpen(false);
  }, []);

  const ensureDiscardDraftConfirmed = useCallback((): Promise<boolean> => {
    if (!hasUnsavedDraftRef.current) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      discardDraftSettledRef.current = false;
      discardDraftResolveRef.current = resolve;
      setDiscardDraftDialogOpen(true);
    });
  }, []);

  const clearComposerDraft = useCallback(() => {
    composer.setInput("");
    setMcpPromptResults([]);
    setSkillResults([]);
    revokeFileAttachmentUrls(fileAttachments);
    setFileAttachments([]);
    setModelContextQueue([]);
  }, [composer, fileAttachments]);

  const cancelPendingHistorySelection = useCallback(() => {
    historySelectionRequestIdRef.current += 1;
    setLoadingHistorySessionId(null);
    setActiveHistorySessionId(null);
  }, []);

  const markHistorySessionRead = useCallback(async (sessionId: string) => {
    try {
      await chatHistoryAction("mark-read", sessionId);
    } catch {
      // Best-effort: unread state should not block chat usage.
    }
  }, []);

  const restoreHistoryServerSelection = useCallback(
    (savedServerNames: string[] | undefined) => {
      if (!Array.isArray(savedServerNames) || savedServerNames.length === 0) {
        return;
      }
      const desired = resolveRestorableServerNames(
        savedServerNames,
        serversById,
        Object.keys(servers)
      );
      if (desired.length === 0) return;

      // Multi-server: reconcile the current selection to exactly match the
      // restored set — add the missing, remove the extras. Without the remove
      // step, restoring a session would leave behind any servers the user had
      // active at restore time, contaminating tool context.
      const onMultiServerToggle =
        playgroundServerSelectorProps?.onMultiServerToggle;
      const currentlyActive =
        playgroundServerSelectorProps?.selectedMultipleServers ?? [];
      const isMulti =
        playgroundServerSelectorProps?.isMultiSelectEnabled === true;

      if (isMulti && onMultiServerToggle) {
        const desiredSet = new Set(desired);
        const activeSet = new Set(currentlyActive);
        for (const name of currentlyActive) {
          if (!desiredSet.has(name)) {
            onMultiServerToggle(name);
          }
        }
        for (const name of desired) {
          if (!activeSet.has(name)) {
            onMultiServerToggle(name);
          }
        }
        return;
      }

      // Single-server fallback: pick the first connected match.
      const onServerChange = playgroundServerSelectorProps?.onServerChange;
      if (!onServerChange) return;
      const firstMatch = desired.find(
        (name) => servers[name]?.connectionStatus === "connected"
      );
      const target = firstMatch ?? desired[0];
      if (target && target !== serverName) {
        onServerChange(target);
      }
    },
    [playgroundServerSelectorProps, serverName, servers, serversById]
  );

  const loadHistorySession = useCallback(
    async (
      detail: ChatHistoryDetailSession,
      widgetSnapshots?: ChatHistoryWidgetSnapshot[],
      options?: {
        shouldRestoreComposerState?: () => boolean;
        shouldApply?: () => boolean;
        turnTraces?: ChatHistoryTurnTrace[];
      }
    ) => {
      await loadChatSession(
        {
          chatSessionId: detail.chatSessionId,
          messagesBlobUrl: detail.messagesBlobUrl,
          resumeConfig: detail.resumeConfig,
          version: detail.version,
          widgetSnapshots,
          turnTraces: options?.turnTraces,
        },
        {
          shouldRestoreResumeConfig: options?.shouldRestoreComposerState,
          shouldApply: options?.shouldApply,
        }
      );
      if (options?.shouldApply && !options.shouldApply()) {
        return;
      }
      const shouldRestoreComposerState =
        options?.shouldRestoreComposerState?.() ?? true;
      if (shouldRestoreComposerState && detail.modelId) {
        const matchingModel = availableModels.find(
          (model) => String(model.id) === detail.modelId
        );
        if (matchingModel) {
          setSelectedModel(matchingModel);
        }
      }
      setActiveHistorySessionId(detail._id);
      setPendingDirectVisibility(detail.directVisibility);
      syncResumedVersion(detail.version);
      void markHistorySessionRead(detail._id);
    },
    [
      availableModels,
      loadChatSession,
      markHistorySessionRead,
      setSelectedModel,
      syncResumedVersion,
    ]
  );

  const {
    session: reactiveHistorySession,
    widgetSnapshots: reactiveHistoryWidgetSnapshots,
  } = useDirectChatSessionSubscription({
    sessionId: activeHistorySessionId,
    projectId: convexProjectId,
    enabled: isConvexAuthenticated && !!activeHistorySessionId && !isStreaming,
  });

  const detachHistorySession = useCallback(
    (toastMessage: string) => {
      resumedThreadSendBaselineRef.current = null;
      cancelPendingHistorySelection();
      setPendingDirectVisibility("private");
      syncResumedVersion(null);
      if (effectiveHasMessages) {
        startChatWithMessages(cloneUiMessages(messagesRef.current), {
          toolRenderOverrides: restoredToolRenderOverrides,
        });
      }
      toast.error(toastMessage);
    },
    [
      cancelPendingHistorySelection,
      effectiveHasMessages,
      restoredToolRenderOverrides,
      startChatWithMessages,
      syncResumedVersion,
    ]
  );

  useEffect(() => {
    if (!activeHistorySessionId || isStreaming) {
      return;
    }

    if (reactiveHistorySession === undefined) {
      return;
    }

    if (reactiveHistorySession === null) {
      detachHistorySession(
        "This chat is no longer available. Continuing locally in a new thread."
      );
      return;
    }

    if (reactiveHistoryWidgetSnapshots === undefined) {
      return;
    }

    if (
      resumedVersion !== null &&
      reactiveHistorySession.version <= resumedVersion
    ) {
      return;
    }

    const requestId = reactiveHistoryLoadRequestIdRef.current + 1;
    reactiveHistoryLoadRequestIdRef.current = requestId;

    void loadHistorySession(
      reactiveHistorySession,
      reactiveHistoryWidgetSnapshots,
      {
        shouldRestoreComposerState: () =>
          !hasUnsavedDraftRef.current &&
          activeHistorySessionIdRef.current === reactiveHistorySession._id,
        shouldApply: () =>
          reactiveHistoryLoadRequestIdRef.current === requestId &&
          activeHistorySessionIdRef.current === reactiveHistorySession._id,
        turnTraces: undefined,
      }
    ).catch((error) => {
      console.error(
        "[PlaygroundMain] Failed to apply reactive chat history",
        error
      );
    });
  }, [
    activeHistorySessionId,
    detachHistorySession,
    isStreaming,
    loadHistorySession,
    reactiveHistorySession,
    reactiveHistoryWidgetSnapshots,
    resumedVersion,
  ]);

  const refreshCurrentHistorySession = useCallback(
    async ({ retries = 0, markRead = false } = {}) => {
      if (!activeHistorySessionId && !chatSessionId) return null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const detail = await getChatHistoryDetail({
            sessionId: activeHistorySessionId ?? undefined,
            chatSessionId,
            projectId: convexProjectId ?? undefined,
          });
          setActiveHistorySessionId(detail.session._id);
          setPendingDirectVisibility(detail.session.directVisibility);
          syncResumedVersion(detail.session.version);
          if (markRead) {
            void markHistorySessionRead(detail.session._id);
          }
          return detail.session;
        } catch (error) {
          if (attempt < retries) {
            await new Promise((resolve) => window.setTimeout(resolve, 250));
            continue;
          }
          // 403/404 means the row is gone or no longer ours — treat as
          // "session unavailable" so callers can detach rather than reporting
          // a transient error.
          if (
            error instanceof WebApiError &&
            (error.status === 403 || error.status === 404)
          ) {
            return null;
          }
          console.error(
            "[PlaygroundMain] Failed to refresh history session",
            error
          );
          return null;
        }
      }
      return null;
    },
    [
      activeHistorySessionId,
      chatSessionId,
      convexProjectId,
      markHistorySessionRead,
      syncResumedVersion,
    ]
  );

  // After a streaming turn ends we re-fetch the active session so the rail
  // reflects the new version and the local resume cursor advances. If the
  // turn was on a resumed thread, we additionally require that the new
  // detail's version actually exceeds the baseline we sent against — that
  // proves the server applied this turn rather than a concurrent edit.
  const refreshHistorySessionAfterStream = useCallback(
    async (
      resumedThreadSendBaseline: {
        sessionId: string;
        version: number;
      } | null
    ) => {
      const maxAttempts = resumedThreadSendBaseline
        ? RESUMED_THREAD_REFRESH_RETRIES + 1
        : 2;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const detail = await refreshCurrentHistorySession({
            markRead: true,
          });
          if (
            !resumedThreadSendBaseline ||
            (detail &&
              detail._id === resumedThreadSendBaseline.sessionId &&
              detail.version > resumedThreadSendBaseline.version)
          ) {
            return detail;
          }
        } catch (error) {
          if (attempt >= maxAttempts - 1) {
            throw error;
          }
        }
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 250));
        }
      }
      return null;
    },
    [refreshCurrentHistorySession]
  );

  const handleSelectThread = useCallback(
    async (session: ChatHistorySession) => {
      if (isStreaming) return;
      if (!(await ensureDiscardDraftConfirmed())) return;
      if (hasUnsavedDraftRef.current) {
        clearComposerDraft();
      }

      const selectionRequestId = historySelectionRequestIdRef.current + 1;
      historySelectionRequestIdRef.current = selectionRequestId;
      setActiveHistorySessionId(session._id);
      setLoadingHistorySessionId(session._id);

      try {
        // Hit the dedup cache: if the user hovered first, this is the same
        // promise the prefetch kicked off and will resolve immediately.
        const detail = await getCachedChatHistoryDetail({
          sessionId: session._id,
          chatSessionId: session.chatSessionId,
          projectId: convexProjectId ?? undefined,
        });

        if (historySelectionRequestIdRef.current !== selectionRequestId) {
          return;
        }

        await loadHistorySession(detail.session, detail.widgetSnapshots, {
          turnTraces: detail.turnTraces,
        });

        if (historySelectionRequestIdRef.current !== selectionRequestId) {
          return;
        }
        restoreHistoryServerSelection(
          detail.session.resumeConfig?.selectedServers
        );
      } catch (err) {
        if (historySelectionRequestIdRef.current === selectionRequestId) {
          setActiveHistorySessionId(null);
        }
        console.error("[PlaygroundMain] Failed to load chat session", err);
        toast.error("Failed to load chat history.");
      } finally {
        if (historySelectionRequestIdRef.current === selectionRequestId) {
          setLoadingHistorySessionId(null);
        }
      }
    },
    [
      clearComposerDraft,
      convexProjectId,
      ensureDiscardDraftConfirmed,
      isStreaming,
      loadHistorySession,
      restoreHistoryServerSelection,
    ]
  );

  const handleNewChat = useCallback(
    async (options?: { shared?: boolean }) => {
      if (isStreaming) return;
      if (!(await ensureDiscardDraftConfirmed())) return;
      if (hasUnsavedDraftRef.current) {
        clearComposerDraft();
      }
      resumedThreadSendBaselineRef.current = null;
      cancelPendingHistorySelection();
      syncResumedVersion(null);
      resetChat();
      setPendingDirectVisibility(options?.shared ? "project" : "private");
    },
    [
      cancelPendingHistorySelection,
      clearComposerDraft,
      ensureDiscardDraftConfirmed,
      isStreaming,
      resetChat,
      syncResumedVersion,
    ]
  );

  const handleArchiveAllComplete = useCallback(
    (hadActiveHistorySelection: boolean) => {
      if (!hadActiveHistorySelection) return;
      if (hasUnsavedDraftRef.current) {
        clearComposerDraft();
      }
      resumedThreadSendBaselineRef.current = null;
      cancelPendingHistorySelection();
      syncResumedVersion(null);
      resetChat();
      setPendingDirectVisibility("private");
    },
    [
      cancelPendingHistorySelection,
      clearComposerDraft,
      resetChat,
      syncResumedVersion,
    ]
  );

  const handleHistorySessionAction = useCallback(
    async ({
      action,
      session,
    }: {
      action:
        | "rename"
        | "archive"
        | "unarchive"
        | "share"
        | "unshare"
        | "pin"
        | "unpin";
      session: ChatHistorySession;
    }) => {
      if (
        (action === "share" || action === "unshare") &&
        session._id === activeHistorySessionId
      ) {
        try {
          const detail = await refreshCurrentHistorySession();
          if (!detail) {
            detachHistorySession(
              "This chat is no longer shared with you. Continuing locally in a new thread."
            );
          }
        } catch (error) {
          console.error(
            "[PlaygroundMain] Failed to refresh unshared chat",
            error
          );
        }
      }
    },
    [activeHistorySessionId, detachHistorySession, refreshCurrentHistorySession]
  );

  // Hover prefetch — fires on row pointer-enter. Warms the detail + blob
  // caches so the click path resolves against an in-flight or completed
  // promise instead of starting fresh round-trips.
  const handlePrefetchThread = useCallback(
    (session: ChatHistorySession) => {
      prefetchChatHistorySession({
        sessionId: session._id,
        chatSessionId: session.chatSessionId,
        projectId: convexProjectId ?? undefined,
      });
    },
    [convexProjectId]
  );

  // Publish the chat-history bridge so the docked Playground pane (outside
  // this subtree) can render `ChatHistoryRail`. Clear on unmount so a stale
  // pane doesn't see a torn-down session after the Playground unmounts.
  const setBridge = usePlaygroundChatHistoryBridgeStore((s) => s.setBridge);
  useEffect(() => {
    setBridge({
      activeSessionId: activeHistorySessionId,
      hostStyle,
      isAuthenticated: isConvexAuthenticated,
      // Use the multi-model-aware streaming flag so the rail disables New Chat
      // / row selection while any broadcast lane is still streaming.
      isStreaming: isStreamingActive,
      sharedThreadsEnabled,
      projectId: convexProjectId,
      enabled: isSessionBootstrapComplete,
      refreshSignal: historyRefreshSignal,
      onSelectThread: handleSelectThread,
      onPrefetchThread: handlePrefetchThread,
      onNewChat: handleNewChat,
      // Without this the rail's "Archive all" path would call resetChat
      // through onArchiveAllComplete and blow away the user's unsaved draft.
      beforeResetChatAfterArchiveAll: ensureDiscardDraftConfirmed,
      onArchiveAllComplete: handleArchiveAllComplete,
      onSessionAction: handleHistorySessionAction,
    });
    return () => setBridge(null);
  }, [
    activeHistorySessionId,
    convexProjectId,
    ensureDiscardDraftConfirmed,
    handleArchiveAllComplete,
    handleHistorySessionAction,
    handleNewChat,
    handlePrefetchThread,
    handleSelectThread,
    historyRefreshSignal,
    hostStyle,
    isConvexAuthenticated,
    isSessionBootstrapComplete,
    isStreamingActive,
    setBridge,
    sharedThreadsEnabled,
  ]);

  // Track streaming baseline + resumedVersion drift while a history session is
  // active. Ports ChatTabV2:1017-1088 so that a turn started on a resumed
  // thread is reconciled against its baseline version when it ends:
  //   - mark active session read on stream completion
  //   - refresh the active session detail (with retry) so the rail picks up
  //     the new version
  //   - detach if the server's version doesn't advance past the baseline
  //     (concurrent edit / fork / deletion)
  const previousStatusRef = useRef(status);
  useEffect(() => {
    const previousStatus = previousStatusRef.current;
    previousStatusRef.current = status;
    const wasStreaming =
      previousStatus === "submitted" || previousStatus === "streaming";
    const isNowStreaming = status === "submitted" || status === "streaming";
    const hasStartedStream = !wasStreaming && isNowStreaming;

    if (hasStartedStream) {
      resumedThreadSendBaselineRef.current =
        activeHistorySessionId && resumedVersion !== null
          ? { sessionId: activeHistorySessionId, version: resumedVersion }
          : null;
      return;
    }

    if (!wasStreaming) {
      return;
    }

    if (status === "error") {
      resumedThreadSendBaselineRef.current = null;
      return;
    }

    // Still mid-stream (submitted ↔ streaming transition). The stream hasn't
    // ended, so don't consume the baseline yet — otherwise the version-conflict
    // check below will read `null` when the stream actually completes.
    if (isNowStreaming) {
      return;
    }

    const resumedThreadSendBaseline = resumedThreadSendBaselineRef.current;
    resumedThreadSendBaselineRef.current = null;
    const hasCompletedStream = status === "ready";
    if (!hasCompletedStream) {
      return;
    }

    if (activeHistorySessionId) {
      void markHistorySessionRead(activeHistorySessionId);
    }

    // Defer slightly so the server has a chance to flush the version bump
    // before we ask for the new detail row.
    const timerId = window.setTimeout(() => {
      void (async () => {
        const detail = await refreshHistorySessionAfterStream(
          resumedThreadSendBaseline
        );
        if (
          resumedThreadSendBaseline &&
          (!detail ||
            detail._id !== resumedThreadSendBaseline.sessionId ||
            detail.version <= resumedThreadSendBaseline.version)
        ) {
          detachHistorySession(
            "This chat changed elsewhere. This reply stayed local, and your next send will continue in a new thread."
          );
        }
      })().catch((error) => {
        console.error("[PlaygroundMain] Failed to refresh chat history", error);
      });
    }, 250);

    return () => window.clearTimeout(timerId);
  }, [
    activeHistorySessionId,
    detachHistorySession,
    markHistorySessionRead,
    refreshHistorySessionAfterStream,
    resumedVersion,
    status,
  ]);

  // Delay the spinner so a hover-prefetched (instant) load doesn't flash an
  // overlay for one frame. After ~120 ms the load is "slow enough" to warrant
  // visible feedback.
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  useEffect(() => {
    if (!loadingHistorySessionId) {
      setShowLoadingOverlay(false);
      return;
    }
    const timerId = window.setTimeout(() => setShowLoadingOverlay(true), 120);
    return () => window.clearTimeout(timerId);
  }, [loadingHistorySessionId]);

  useEffect(() => {
    const activeModelIds = new Set(
      resolvedSelectedModels.map((model) => String(model.id))
    );

    setMultiModelSummaries((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) =>
          activeModelIds.has(modelId)
        )
      )
    );
    setMultiModelHasMessages((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([modelId]) =>
          activeModelIds.has(modelId)
        )
      )
    );
  }, [resolvedSelectedModels]);

  useEffect(() => {
    if (!traceViewsSupported) {
      setTraceViewMode("chat");
    }
  }, [traceViewsSupported]);

  useEffect(() => {
    setTraceViewMode("chat");
    setPreludeTraceExecutions([]);
  }, [chatSessionId]);

  // Keyboard shortcut for clear chat (Cmd/Ctrl+Shift+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        e.preventDefault();
        if (effectiveHasMessages) {
          setShowClearConfirm(true);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [effectiveHasMessages]);

  // Handle deterministic execution injection
  useEffect(() => {
    if (!pendingExecution) return;
    if (isMultiModelMode) {
      const requestId = Date.now();
      const toolCallId =
        pendingExecution.toolCallId ?? `playground-tool-${requestId}`;
      setDeterministicExecutionRequest({
        id: requestId,
        toolName: pendingExecution.toolName,
        params: pendingExecution.params,
        result: pendingExecution.result,
        toolMeta: pendingExecution.toolMeta,
        state: pendingExecution.state,
        errorText: pendingExecution.errorText,
        renderOverride: pendingExecution.renderOverride,
        toolCallId,
        replaceExisting: pendingExecution.replaceExisting,
      });
      onExecutionInjected(toolCallId);
      return;
    }

    const { toolName, params, result, toolMeta } = pendingExecution;
    const deterministicOptions =
      pendingExecution.state === "output-error"
        ? {
            state: "output-error" as const,
            errorText: pendingExecution.errorText,
            toolCallId: pendingExecution.toolCallId,
          }
        : pendingExecution.toolCallId
        ? { toolCallId: pendingExecution.toolCallId }
        : undefined;
    const { messages: newMessages, toolCallId } =
      createDeterministicToolMessages(
        toolName,
        params,
        result,
        toolMeta,
        deterministicOptions
      );

    if (pendingExecution.renderOverride) {
      setInjectedToolRenderOverrides((prev) => ({
        ...prev,
        [toolCallId]: pendingExecution.renderOverride!,
      }));
    }

    const upsertById = (
      current: typeof newMessages,
      nextMessage: (typeof newMessages)[number]
    ) => {
      const idx = current.findIndex((m) => m.id === nextMessage.id);
      if (idx === -1) return [...current, nextMessage];
      const copy = [...current];
      copy[idx] = nextMessage;
      return copy;
    };

    if (pendingExecution.replaceExisting && pendingExecution.toolCallId) {
      setMessages((prev) => {
        let next = [...prev];
        for (const msg of newMessages) {
          next = upsertById(next as typeof newMessages, msg) as typeof prev;
        }
        return next;
      });
    } else {
      setMessages((prev) => [...prev, ...newMessages]);
    }
    setPreludeTraceExecutions((prev) => {
      const nextExecution: PreludeTraceExecution = {
        toolCallId,
        toolName,
        params,
        result,
        state:
          pendingExecution.state === "output-error"
            ? "output-error"
            : "output-available",
        errorText: pendingExecution.errorText,
      };

      if (pendingExecution.replaceExisting && pendingExecution.toolCallId) {
        return prev.map((execution) =>
          execution.toolCallId === pendingExecution.toolCallId
            ? nextExecution
            : execution
        );
      }

      return [...prev, nextExecution];
    });
    onExecutionInjected(toolCallId);
  }, [isMultiModelMode, onExecutionInjected, pendingExecution, setMessages]);

  useEffect(() => {
    if (!isMultiModelMode && hasTraceSnapshot) {
      setPreludeTraceExecutions([]);
    }
  }, [hasTraceSnapshot, isMultiModelMode]);

  // Handle widget state changes
  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      onWidgetStateChange?.(toolCallId, state);
    },
    [onWidgetStateChange]
  );

  const ensureSelectedServerReadyForChat = useCallback(async () => {
    if (!serverName || serverName === "none" || !ensureServersReady) {
      return true;
    }

    const connectionStatus = servers[serverName]?.connectionStatus;
    if (connectionStatus === "connected") {
      return true;
    }

    setIsPreparingServerForSend(true);
    try {
      const result = await ensureServersReady([serverName]);
      if (result.readyServerNames.includes(serverName)) {
        // Yield one frame so React can flush the connection-status state
        // update before the caller proceeds to send a message.
        await new Promise<void>((resolve) => {
          if (typeof window !== "undefined" && window.requestAnimationFrame) {
            window.requestAnimationFrame(() => resolve());
            return;
          }
          setTimeout(resolve, 0);
        });
        return true;
      }

      const errorMessage = result.missingServerNames.includes(serverName)
        ? `${serverName} is no longer available in this project.`
        : result.reauthServerNames.includes(serverName)
        ? `Reauthenticate ${serverName} before sending.`
        : `Couldn't connect to ${serverName}.`;
      toast.error(errorMessage);
      return false;
    } finally {
      setIsPreparingServerForSend(false);
    }
  }, [ensureServersReady, serverName, servers]);

  // Handle follow-up messages from widgets
  const handleSendFollowUp = useCallback(
    (text: string) => {
      void (async () => {
        if (!(await ensureSelectedServerReadyForChat())) {
          return;
        }
        sendMessage({ text });
      })();
    },
    [ensureSelectedServerReadyForChat, sendMessage]
  );

  // Handle model context updates from widgets (SEP-1865 ui/update-model-context)
  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      }
    ) => {
      // Queue model context to be included in next message
      setModelContextQueue((prev) => {
        // Remove any existing context from same widget (overwrite pattern per SEP-1865)
        const filtered = prev.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    []
  );

  const resetMultiModelSessions = useCallback(() => {
    clearMultiModelUiState();
    setMultiModelSessionGeneration((previous) => previous + 1);
  }, [clearMultiModelUiState]);

  const handleResetAllChats = useCallback(() => {
    composer.prepareForClearChat();
    resetChat();
    clearLogs();
    setInjectedToolRenderOverrides({});
    setPreludeTraceExecutions([]);
    resetMultiModelSessions();
  }, [clearLogs, composer, resetChat, resetMultiModelSessions]);

  const handleClearChat = useCallback(() => {
    handleResetAllChats();
    setShowClearConfirm(false);
  }, [handleResetAllChats]);

  const handleSingleModelChange = useCallback(
    (model: ModelDefinition) => {
      setSelectedModel(model);
      setSelectedModelIds([String(model.id)]);
      setMultiModelEnabled(false);
    },
    [setMultiModelEnabled, setSelectedModel, setSelectedModelIds]
  );

  const handleSelectedModelsChange = useCallback(
    (models: ModelDefinition[]) => {
      const nextSelectedModels = models.slice(0, 3);
      const leadModel = nextSelectedModels[0] ?? selectedModel;

      if (leadModel) {
        setSelectedModel(leadModel);
      }
      setSelectedModelIds(
        nextSelectedModels.map((selectedModelItem) =>
          String(selectedModelItem.id)
        )
      );
    },
    [selectedModel, setSelectedModel, setSelectedModelIds]
  );

  const handleMultiModelEnabledChange = useCallback(
    (enabled: boolean) => {
      setMultiModelEnabled(enabled);
    },
    [setMultiModelEnabled]
  );

  const handleRequireToolApprovalChange = useCallback(
    (enabled: boolean) => {
      setRequireToolApproval(enabled);
      if (isMultiModelMode) {
        handleResetAllChats();
      }
    },
    [handleResetAllChats, isMultiModelMode, setRequireToolApproval]
  );

  const handleMultiModelSummaryChange = useCallback(
    (summary: MultiModelCardSummary) => {
      setMultiModelSummaries((previous) => ({
        ...previous,
        [summary.modelId]: summary,
      }));
    },
    []
  );

  const handleMultiModelHasMessagesChange = useCallback(
    (modelId: string, hasMessages: boolean) => {
      setMultiModelHasMessages((previous) => ({
        ...previous,
        [modelId]: hasMessages,
      }));
    },
    []
  );

  const queueBroadcastRequest = useCallback(
    (
      request: Omit<BroadcastChatTurnRequest, "id">,
      captureProps?: Record<string, unknown>
    ) => {
      posthog.capture("app_builder_send_message", {
        location: "app_builder_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
        multi_model_enabled: isMultiModelMode,
        multi_model_count: isMultiModelMode ? resolvedSelectedModels.length : 1,
        ...(captureProps ?? {}),
      });

      setBroadcastRequest({
        ...request,
        id: Date.now(),
      });
    },
    [
      isMultiModelMode,
      posthog,
      resolvedSelectedModels.length,
      selectedModel?.id,
      selectedModel?.name,
      selectedModel?.provider,
    ]
  );

  const mergedToolRenderOverrides = useMemo(
    () => ({
      // `restoredToolRenderOverrides` carries widget snapshots hydrated by
      // `loadChatSession` when a history session is opened. Without it the
      // saved iframes/canvases render as plain attachment cards in the
      // Thread. Live overrides from this turn (`injected*`) and the parent
      // (`external*`) win over restored ones for the same toolCallId.
      ...restoredToolRenderOverrides,
      ...injectedToolRenderOverrides,
      ...externalToolRenderOverrides,
    }),
    [
      restoredToolRenderOverrides,
      injectedToolRenderOverrides,
      externalToolRenderOverrides,
    ]
  );

  // Map UIMessage.id -> promptIndex (0-based ordinal among role: "user"
  // messages). Same key the backend uses to anchor a turn inside the
  // persisted ModelMessage[] transcript blob.
  const userPromptIndexById = useMemo(() => {
    const map = new Map<string, number>();
    let userOrdinal = 0;
    for (const msg of messages) {
      if (msg.role === "user") {
        map.set(msg.id, userOrdinal);
        userOrdinal += 1;
      }
    }
    return map;
  }, [messages]);

  // Placeholder: Chat tab strings for multi-model; playground default for single-model
  let placeholder = showPostConnectGuide
    ? MINIMAL_CHAT_COMPOSER_PLACEHOLDER
    : isMultiModelMode
    ? DEFAULT_CHAT_COMPOSER_PLACEHOLDER
    : "Try a prompt that could call your tools...";
  if (disableChatInput) {
    placeholder = disabledInputPlaceholder;
  }
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = isMultiModelMode
      ? "Sign in to use free chat"
      : "Sign in to use chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const showMultiModelStarterPrompts = !shouldShowUpsell && !isAuthLoading;
  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "app_builder_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  // Submit handler
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const hasContent =
      composer.input.trim() ||
      mcpPromptResults.length > 0 ||
      fileAttachments.length > 0;
    if (hasContent && !sendBlocked) {
      if (!(await ensureSelectedServerReadyForChat())) {
        return;
      }

      if (
        !isMultiModelMode &&
        displayMode === "fullscreen" &&
        isWidgetFullscreen
      ) {
        setIsFullscreenChatOpen(true);
      }

      // Include any pending model context from widgets (SEP-1865 ui/update-model-context)
      // Sent as "user" messages for compatibility with model provider APIs
      const contextMessages = modelContextQueue.map(
        ({ toolCallId, context }) => ({
          id: `model-context-${toolCallId}-${Date.now()}`,
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: `Widget ${toolCallId} context: ${JSON.stringify(context)}`,
            },
          ],
          metadata: {
            source: "widget-model-context",
            toolCallId,
          },
        })
      );

      // Convert file attachments to FileUIPart[] format for the AI SDK
      const files =
        fileAttachments.length > 0
          ? await attachmentsToFileUIParts(fileAttachments)
          : undefined;

      if (isMultiModelMode) {
        queueBroadcastRequest({
          text: composer.input,
          files,
          prependMessages: [],
        });
        setModelContextQueue([]);
      } else {
        if (contextMessages.length > 0) {
          setMessages((prev) => [...prev, ...contextMessages]);
        }
        queueBroadcastRequest(
          {
            text: composer.input,
            files,
            prependMessages: [],
          },
          { single_model_send: true }
        );
        sendMessage({ text: composer.input, files });
        setModelContextQueue([]); // Clear after sending
      }

      composer.setInput("");
      setMcpPromptResults([]);
      // Revoke object URLs and clear file attachments
      revokeFileAttachmentUrls(fileAttachments);
      setFileAttachments([]);

      // Notify onboarding that the first message was sent
      onFirstMessageSent?.();
    }
  };

  const errorMessage = formatErrorMessage(error);

  const handleMultiModelStarterPrompt = useCallback(
    (prompt: string) => {
      if (composerDisabled || sendBlocked) {
        composer.setInput(prompt);
        return;
      }
      void (async () => {
        if (!(await ensureSelectedServerReadyForChat())) {
          composer.setInput(prompt);
          return;
        }
        queueBroadcastRequest({
          text: prompt,
          prependMessages: [],
        });
        composer.setInput("");
        revokeFileAttachmentUrls(fileAttachments);
        setFileAttachments([]);
        onFirstMessageSent?.();
      })();
    },
    [
      composer,
      composerDisabled,
      ensureSelectedServerReadyForChat,
      fileAttachments,
      onFirstMessageSent,
      queueBroadcastRequest,
      sendBlocked,
    ]
  );
  const traceViewerTrace = effectiveLiveTraceEnvelope ?? {
    traceVersion: 1 as const,
    messages: [],
  };
  const showLiveTracePending =
    activeTraceViewMode === "timeline" &&
    !hasLiveTimelineContent &&
    !preludeTraceEnvelope?.spans?.length;

  // Shared chat input props
  const sharedChatInputProps = {
    value: composer.input,
    onChange: composer.handleInputChange,
    onSubmit,
    stop: stopActiveChat,
    disabled: composerDisabled,
    isLoading: isStreamingActive,
    placeholder,
    currentModel: selectedModel,
    availableModels,
    onModelChange: handleSingleModelChange,
    onModelSelectorOpenChange,
    multiModelEnabled: isMultiModelMode,
    selectedModels: resolvedSelectedModels,
    onSelectedModelsChange: handleSelectedModelsChange,
    onMultiModelEnabledChange: handleMultiModelEnabledChange,
    enableMultiModel: canEnableMultiModel,
    systemPrompt,
    onSystemPromptChange: setSystemPrompt,
    temperature,
    onTemperatureChange: setTemperature,
    onResetChat: handleResetAllChats,
    submitDisabled:
      disableChatInput ||
      submitBlocked ||
      composer.submitGatedByServer ||
      isPreparingServerForSend,
    tokenUsage,
    selectedServers,
    mcpToolsTokenCount: null,
    mcpToolsTokenCountLoading: false,
    connectedOrConnectingServerConfigs: { [serverName]: { name: serverName } },
    systemPromptTokenCount: null,
    systemPromptTokenCountLoading: false,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
    skillResults,
    onChangeSkillResults: setSkillResults,
    fileAttachments,
    onChangeFileAttachments: setFileAttachments,
    requireToolApproval,
    onRequireToolApprovalChange: handleRequireToolApprovalChange,
    pulseSubmit: composer.sendButtonOnboardingPulse,
    minimalMode: showPostConnectGuide,
    moveCaretToEndTrigger: composer.moveCaretToEndTrigger,
    allServerConfigs: playgroundServerSelectorProps?.serverConfigs,
    onServerToggle: handlePlaygroundServerToggle,
    onReconnectServer: playgroundServerSelectorProps?.onReconnect,
    onAddServer: playgroundServerSelectorProps?.onConnect,
  };

  // Check if widget should take over the full container
  // Mobile: both fullscreen and pip take over
  // Tablet: only fullscreen takes over (pip stays floating)
  const isMobileFullTakeover =
    storeDeviceType === "mobile" &&
    (displayMode === "fullscreen" || displayMode === "pip");
  const isTabletFullscreenTakeover =
    storeDeviceType === "tablet" && displayMode === "fullscreen";
  const isWidgetFullTakeover =
    isMobileFullTakeover || isTabletFullscreenTakeover;

  const showFullscreenChatOverlay =
    displayMode === "fullscreen" &&
    isWidgetFullscreen &&
    storeDeviceType === "desktop" &&
    !isWidgetFullTakeover;

  useEffect(() => {
    if (!showFullscreenChatOverlay) setIsFullscreenChatOpen(false);
  }, [showFullscreenChatOverlay]);

  const showSingleModelEmptyStateComposer =
    !isAuthLoading &&
    !shouldShowUpsell &&
    (showPostConnectGuide || !showFullscreenChatOverlay);

  // Thread content - single ChatInput that persists across empty/non-empty states
  const threadContent = (
    <div className="relative flex flex-col flex-1 min-h-0">
      {isThreadEmpty ? (
        // Empty state — centered (welcome + composer, or post-connect guide)
        <div
          data-testid="playground-empty-state-shell"
          className={cn(
            "flex flex-1 min-h-0 overflow-hidden",
            // Text color stays family-keyed — built-ins doesn't carry
            // a foreground token yet. Background comes from built-ins
            // via `hostBackgroundColor` (already resolved at L553) so
            // every tab paints the same color for the same host+theme.
            hostStyleFamily === "chatgpt"
              ? effectiveThreadTheme === "dark"
                ? "text-neutral-50"
                : "text-neutral-950"
              : effectiveThreadTheme === "dark"
              ? "text-[#F1F0ED]"
              : "text-[rgba(61,57,41,1)]"
          )}
          style={{ backgroundColor: hostBackgroundColor }}
        >
          <div
            className="flex h-full min-h-0 flex-1 items-center justify-center overflow-hidden px-4"
            data-testid="playground-empty-state-body"
          >
            <div
              className={cn(
                "w-full max-w-4xl shrink-0",
                !showPostConnectGuide && "py-8"
              )}
            >
              <div
                className={cn("w-full", !showPostConnectGuide && "text-center")}
              >
                {isAuthLoading ? (
                  <div className="space-y-4 text-center">
                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                    <p className="text-sm text-muted-foreground">Loading...</p>
                  </div>
                ) : shouldShowUpsell ? (
                  <div className="text-center">
                    <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                  </div>
                ) : showPostConnectGuide ? (
                  <div className="space-y-6">
                    {errorMessage && (
                      <div className="w-full">
                        <ErrorBox
                          message={errorMessage.message}
                          errorDetails={errorMessage.details}
                          code={errorMessage.code}
                          statusCode={errorMessage.statusCode}
                          isRetryable={errorMessage.isRetryable}
                          isMCPJamPlatformError={
                            errorMessage.isMCPJamPlatformError
                          }
                          onResetChat={resetChat}
                        />
                      </div>
                    )}
                    <PostConnectGuide />
                  </div>
                ) : (
                  <div className="flex w-full flex-col items-center gap-8 [-webkit-user-drag:none]">
                    <div className="text-center max-w-md">
                      <img
                        src={
                          effectiveThreadTheme === "dark"
                            ? "/mcp_jam_dark.png"
                            : "/mcp_jam_light.png"
                        }
                        alt="MCPJam"
                        draggable={false}
                        className="h-10 w-auto mx-auto mb-4"
                      />
                      <div className="space-y-3">
                        <h3
                          className={cn(
                            "text-lg font-semibold",
                            hostStyleFamily === "chatgpt"
                              ? effectiveThreadTheme === "dark"
                                ? "text-white"
                                : "text-neutral-950"
                              : effectiveThreadTheme === "dark"
                              ? "text-[#F1F0ED]"
                              : "text-[rgba(61,57,41,1)]"
                          )}
                        >
                          This is your playground for MCP.
                        </h3>
                        <p
                          className={cn(
                            "text-base leading-7",
                            hostStyleFamily === "chatgpt"
                              ? effectiveThreadTheme === "dark"
                                ? "text-neutral-400"
                                : "text-neutral-600"
                              : effectiveThreadTheme === "dark"
                              ? "text-[#F1F0ED]/80"
                              : "text-[rgba(61,57,41,0.72)]"
                          )}
                        >
                          Test prompts, inspect tools, and debug AI-powered
                          apps. Type a message here, or run a tool on the left.
                        </p>
                      </div>
                    </div>
                    {errorMessage && (
                      <div className="w-full">
                        <ErrorBox
                          message={errorMessage.message}
                          errorDetails={errorMessage.details}
                          code={errorMessage.code}
                          statusCode={errorMessage.statusCode}
                          isRetryable={errorMessage.isRetryable}
                          isMCPJamPlatformError={
                            errorMessage.isMCPJamPlatformError
                          }
                          onResetChat={resetChat}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
              {showSingleModelEmptyStateComposer && (
                <div
                  className={cn(
                    "w-full shrink-0",
                    showPostConnectGuide ? "pt-6" : "pt-8"
                  )}
                >
                  <ChatInput {...sharedChatInputProps} hasMessages={false} />
                  {!showPostConnectGuide && composer.sendNuxCtaVisible && (
                    <HandDrawnSendHint
                      hostStyle={hostStyle}
                      theme={effectiveThreadTheme}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        // Thread with messages
        <StickToBottom
          className="relative flex flex-1 flex-col min-h-0"
          resize="smooth"
          initial="smooth"
        >
          <div className="relative flex-1 min-h-0">
            <StickToBottom.Content className="flex flex-col min-h-0">
              <Thread
                messages={messages}
                sendFollowUpMessage={handleSendFollowUp}
                model={selectedModel}
                isLoading={isStreaming}
                toolsMetadata={toolsMetadata}
                toolServerMap={toolServerMap}
                onWidgetStateChange={handleWidgetStateChange}
                onModelContextUpdate={handleModelContextUpdate}
                displayMode={displayMode}
                onDisplayModeChange={handleDisplayModeChange}
                onFullscreenChange={setIsWidgetFullscreen}
                selectedProtocolOverrideIfBothExists={
                  selectedProtocol ?? undefined
                }
                onToolApprovalResponse={addToolApprovalResponse}
                toolRenderOverrides={mergedToolRenderOverrides}
                showSaveViewButton={!hideSaveViewButton}
                renderUserMessageActions={
                  chatSessionId && convexProjectId
                    ? (message) => {
                        const promptIndex = userPromptIndexById.get(message.id);
                        if (promptIndex === undefined) return null;
                        return (
                          <SaveAsTestCaseAction
                            chatSessionId={chatSessionId}
                            promptIndex={promptIndex}
                            promptPreview={extractUserMessageText(message)}
                            projectId={convexProjectId}
                          />
                        );
                      }
                    : undefined
                }
              />
              {/* Invoking indicator while tool execution is in progress */}
              {isExecuting && executingToolName && (
                <InvokingIndicator
                  toolName={executingToolName}
                  customMessage={invokingMessage}
                />
              )}
            </StickToBottom.Content>
            <ScrollToBottomButton />
          </div>
        </StickToBottom>
      )}

      {/* Footer ChatInput: with messages, or empty when center has no composer
          (auth loading / upsell). Otherwise empty thread uses centered composer only. */}
      {!isWidgetFullTakeover &&
        !showFullscreenChatOverlay &&
        (!isThreadEmpty || shouldShowUpsell || isAuthLoading) && (
          <div
            className={cn(
              "mx-auto w-full max-w-4xl shrink-0",
              isThreadEmpty ? "px-4 pb-4" : "p-3"
            )}
          >
            {errorMessage && (
              <div className="pb-3">
                <ErrorBox
                  message={errorMessage.message}
                  errorDetails={errorMessage.details}
                  code={errorMessage.code}
                  statusCode={errorMessage.statusCode}
                  isRetryable={errorMessage.isRetryable}
                  isMCPJamPlatformError={errorMessage.isMCPJamPlatformError}
                  onResetChat={resetChat}
                />
              </div>
            )}
            <ChatInput {...sharedChatInputProps} hasMessages={!isThreadEmpty} />
          </div>
        )}

      {/* Fullscreen overlay chat (input pinned + collapsible thread) */}
      {showFullscreenChatOverlay && (
        <FullscreenChatOverlay
          messages={messages}
          open={isFullscreenChatOpen}
          onOpenChange={setIsFullscreenChatOpen}
          input={composer.input}
          onInputChange={composer.setInput}
          placeholder={placeholder}
          disabled={composerDisabled}
          canSend={!sendBlocked && composer.input.trim().length > 0}
          isThinking={isStreamingActive}
          onStop={stopActiveChat}
          onSend={() => {
            void (async () => {
              if (sendBlocked) {
                return;
              }
              if (!(await ensureSelectedServerReadyForChat())) {
                return;
              }
              sendMessage({ text: composer.input });
              composer.setInput("");
              setMcpPromptResults([]);
            })();
          }}
        />
      )}
    </div>
  );

  // Device frame container - display mode is passed to widgets via Thread
  return (
    <>
      <div
        className={cn(
          "relative h-full flex flex-col overflow-hidden",
          showPostConnectGuide || isMultiModelLayoutMode
            ? "bg-background"
            : "bg-muted/20"
        )}
      >
        {showLoadingOverlay && (
          <div
            className="absolute inset-0 z-30 flex items-center justify-center bg-background/70 backdrop-blur-sm"
            role="status"
            aria-label="Loading chat"
          >
            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
          </div>
        )}
        {/* Center header strip — hidden during onboarding */}
        {!showPostConnectGuide && (
          <PlaygroundCenterHeaderBar
            showTraceTabs={showTraceViewTabs}
            mode={activeTraceViewMode}
            onModeChange={(mode) => {
              if (mode === "tools") return;
              setTraceViewMode(mode);
            }}
            activeProjectId={activeProjectId}
            onSaveHostContext={onSaveHostContext}
            protocol={selectedProtocol}
            isMultiModelLayoutMode={isMultiModelLayoutMode}
            trailing={
              effectiveHasMessages ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowClearConfirm(true)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    variant="muted"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <p className="font-medium">Clear chat</p>
                    <p className="text-xs font-light text-muted-foreground">
                      {navigator.platform.includes("Mac")
                        ? "⌘⇧K"
                        : "Ctrl+Shift+K"}
                    </p>
                  </TooltipContent>
                </Tooltip>
              ) : null
            }
          />
        )}

        <ConfirmChatResetDialog
          open={showClearConfirm}
          onCancel={() => setShowClearConfirm(false)}
          onConfirm={handleClearChat}
        />

        <div className="flex-1 min-h-0 overflow-hidden">
          {isMultiModelLayoutMode ? (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {showMultiModelTraceEmptyPanel && multiModelTracePanelModel ? (
                <MultiModelEmptyTraceDiagnosticsPanel
                  activeTraceViewMode={activeTraceViewMode}
                  effectiveHasMessages={effectiveHasMessages}
                  hasLiveTimelineContent={hasLiveTimelineContent}
                  traceViewerTrace={traceViewerTrace}
                  model={multiModelTracePanelModel}
                  toolsMetadata={toolsMetadata}
                  toolServerMap={toolServerMap}
                  traceStartedAtMs={liveTraceEnvelope?.traceStartedAtMs ?? null}
                  traceEndedAtMs={liveTraceEnvelope?.traceEndedAtMs ?? null}
                  rawRequestPayloadHistory={{
                    entries: requestPayloadHistory,
                    hasUiMessages: effectiveHasMessages,
                  }}
                  rawEmptyTestId="playground-multi-empty-raw-pending"
                  timelineEmptyTestId="playground-multi-empty-trace-pending"
                  onRevealNavigateToChat={() => setTraceViewMode("chat")}
                  errorFooterSlot={
                    errorMessage ? (
                      <div className="max-w-4xl mx-auto px-4 pt-4">
                        <ErrorBox
                          message={errorMessage.message}
                          errorDetails={errorMessage.details}
                          code={errorMessage.code}
                          statusCode={errorMessage.statusCode}
                          isRetryable={errorMessage.isRetryable}
                          isMCPJamPlatformError={
                            errorMessage.isMCPJamPlatformError
                          }
                          onResetChat={handleResetAllChats}
                        />
                      </div>
                    ) : null
                  }
                  chatInputSlot={
                    <ChatInput {...sharedChatInputProps} hasMessages={false} />
                  }
                />
              ) : null}

              {!effectiveHasMessages && !showMultiModelTraceEmptyPanel ? (
                <MultiModelStartersEmptyLayout
                  isAuthLoading={isAuthLoading}
                  showStarterPrompts={showMultiModelStarterPrompts}
                  authPrimarySlot={
                    isAuthLoading ? (
                      <div className="text-center space-y-4">
                        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                        <p className="text-sm text-muted-foreground">
                          Loading...
                        </p>
                      </div>
                    ) : shouldShowUpsell ? (
                      <div className="space-y-4">
                        <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                      </div>
                    ) : null
                  }
                  onStarterPrompt={handleMultiModelStarterPrompt}
                  chatInputSlot={
                    <ChatInput {...sharedChatInputProps} hasMessages={false} />
                  }
                />
              ) : null}

              <div
                data-testid="playground-multi-model-compare-section"
                className={cn(
                  "flex flex-1 min-h-0 flex-col overflow-hidden",
                  !effectiveHasMessages && "hidden"
                )}
                aria-hidden={!effectiveHasMessages}
              >
                <div className="flex min-h-64 flex-1 flex-col overflow-hidden px-4 py-4">
                  <div
                    data-testid="playground-multi-model-grid"
                    className={cn(
                      "grid h-full min-h-0 w-full min-w-0 gap-4 auto-rows-[minmax(0,1fr)] [&>*]:min-h-0",
                      resolvedSelectedModels.length <= 1 && "grid-cols-1",
                      resolvedSelectedModels.length === 2 &&
                        "grid-cols-1 xl:grid-cols-2",
                      resolvedSelectedModels.length >= 3 &&
                        "grid-cols-1 xl:grid-cols-3"
                    )}
                  >
                    {resolvedSelectedModels.map((model) => (
                      <MultiModelPlaygroundCard
                        key={`${multiModelSessionGeneration}:${String(
                          model.id
                        )}`}
                        model={model}
                        comparisonSummaries={Object.values(multiModelSummaries)}
                        selectedServers={selectedServers}
                        broadcastRequest={broadcastRequest}
                        deterministicExecutionRequest={
                          deterministicExecutionRequest
                        }
                        stopRequestId={stopBroadcastRequestId}
                        executionConfig={{
                          systemPrompt,
                          temperature,
                          requireToolApproval,
                        }}
                        hostedContext={{
                          projectId: convexProjectId,
                          selectedServerIds: hostedSelectedServerIds,
                          oauthTokens: hostedOAuthTokens,
                        }}
                        displayMode={displayMode}
                        onDisplayModeChange={handleDisplayModeChange}
                        hostStyle={hostStyle}
                        effectiveThreadTheme={effectiveThreadTheme}
                        deviceType={storeDeviceType}
                        selectedProtocol={selectedProtocol}
                        hideSaveViewButton={hideSaveViewButton}
                        onWidgetStateChange={onWidgetStateChange}
                        toolRenderOverrides={externalToolRenderOverrides}
                        isExecuting={isExecuting}
                        executingToolName={executingToolName}
                        invokingMessage={invokingMessage}
                        onSummaryChange={handleMultiModelSummaryChange}
                        onHasMessagesChange={handleMultiModelHasMessagesChange}
                        showComparisonChrome={resolvedSelectedModels.length > 1}
                        suppressThreadEmptyHint={false}
                        compareEnterVersion={multiCompareEnterVersion}
                        compareEnterMessages={multiCompareEnterMessages}
                        addColumnSeed={
                          multiAddColumnSeeds[String(model.id)] ?? null
                        }
                        onTranscriptSync={handleMultiModelTranscriptSync}
                      />
                    ))}
                  </div>
                </div>

                {!showMultiModelTraceEmptyPanel ? (
                  <div className="shrink-0 border-t border-border bg-background/80 backdrop-blur-sm">
                    {!isAuthLoading ? (
                      <div className="w-full p-4">
                        <ChatInput
                          {...sharedChatInputProps}
                          hasMessages={effectiveHasMessages}
                        />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              {showLiveTraceDiagnostics && (
                <ChatboxHostStyleProvider value={hostStyle}>
                  <ChatboxHostCapabilitiesOverrideProvider
                    value={hostCapabilitiesOverride}
                  >
                    <ChatboxHostThemeProvider value={effectiveThreadTheme}>
                      <div
                        className={cn(
                          "flex h-full min-h-0 flex-col overflow-hidden",
                          effectiveThreadTheme === "dark" && "dark"
                        )}
                        data-testid="playground-trace-diagnostics"
                      >
                        <SingleModelTraceDiagnosticsBody
                          activeTraceViewMode={activeTraceViewMode}
                          isThreadEmpty={isThreadEmpty}
                          showLiveTracePending={showLiveTracePending}
                          trace={traceViewerTrace}
                          model={selectedModel}
                          toolsMetadata={toolsMetadata}
                          toolServerMap={toolServerMap}
                          traceStartedAtMs={
                            effectiveLiveTraceEnvelope?.traceStartedAtMs ?? null
                          }
                          traceEndedAtMs={
                            effectiveLiveTraceEnvelope?.traceEndedAtMs ?? null
                          }
                          onRevealNavigateToChat={() =>
                            setTraceViewMode("chat")
                          }
                          sendFollowUpMessage={handleSendFollowUp}
                          displayMode={displayMode}
                          onDisplayModeChange={handleDisplayModeChange}
                          onFullscreenChange={setIsWidgetFullscreen}
                          rawRequestPayloadHistory={{
                            entries: requestPayloadHistory,
                            hasUiMessages: !isThreadEmpty,
                          }}
                          rawEmptyTestId="playground-live-raw-pending"
                          timelineEmptyTestId="playground-live-trace-pending"
                          nonRawShellClassName="flex-1 min-h-0 overflow-hidden px-4 py-4"
                        />
                        <div className="flex-shrink-0 border-t border-border bg-background/70">
                          <div className="max-w-4xl mx-auto w-full p-3">
                            {errorMessage && (
                              <div className="pb-3">
                                <ErrorBox
                                  message={errorMessage.message}
                                  errorDetails={errorMessage.details}
                                  code={errorMessage.code}
                                  statusCode={errorMessage.statusCode}
                                  isRetryable={errorMessage.isRetryable}
                                  isMCPJamPlatformError={
                                    errorMessage.isMCPJamPlatformError
                                  }
                                  onResetChat={resetChat}
                                />
                              </div>
                            )}
                            <ChatInput
                              {...sharedChatInputProps}
                              hasMessages={!isThreadEmpty}
                            />
                          </div>
                        </div>
                      </div>
                    </ChatboxHostThemeProvider>
                  </ChatboxHostCapabilitiesOverrideProvider>
                </ChatboxHostStyleProvider>
              )}

              {/* Device frame container */}
              <div
                className="flex h-full items-center justify-center min-h-0 overflow-auto"
                style={
                  showLiveTraceDiagnostics ? { display: "none" } : undefined
                }
              >
                <ChatboxHostStyleProvider value={hostStyle}>
                  <ChatboxHostCapabilitiesOverrideProvider
                    value={hostCapabilitiesOverride}
                  >
                    <ChatboxHostThemeProvider value={effectiveThreadTheme}>
                      <div
                        className={cn(
                          "chatbox-host-shell app-theme-scope relative flex flex-col overflow-hidden",
                          effectiveThreadTheme === "dark" && "dark"
                        )}
                        data-testid="playground-thread-shell"
                        data-host-style={hostStyle}
                        data-theme-preset={themePreset}
                        data-thread-theme={effectiveThreadTheme}
                        style={{
                          width: showPostConnectGuide
                            ? "100%"
                            : deviceConfig.width,
                          maxWidth: "100%",
                          height: showPostConnectGuide
                            ? "100%"
                            : isWidgetFullTakeover
                            ? "100%"
                            : deviceConfig.height,
                          maxHeight: "100%",
                          backgroundColor: showPostConnectGuide
                            ? undefined
                            : hostBackgroundColor,
                        }}
                      >
                        <div className="flex flex-col flex-1 min-h-0">
                          {threadContent}
                        </div>
                      </div>
                    </ChatboxHostThemeProvider>
                  </ChatboxHostCapabilitiesOverrideProvider>
                </ChatboxHostStyleProvider>
              </div>
            </>
          )}
        </div>
      </div>
      <AlertDialog
        open={discardDraftDialogOpen}
        onOpenChange={(open) => {
          setDiscardDraftDialogOpen(open);
          if (!open && !discardDraftSettledRef.current) {
            discardDraftSettledRef.current = true;
            const resolve = discardDraftResolveRef.current;
            discardDraftResolveRef.current = null;
            resolve?.(false);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved draft?</AlertDialogTitle>
            <AlertDialogDescription>
              Your chat has text that has not been sent. Discard your current
              draft and continue?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={(event) => {
                event.preventDefault();
                settleDiscardDraft(false);
              }}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                settleDiscardDraft(true);
              }}
            >
              Discard and continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
