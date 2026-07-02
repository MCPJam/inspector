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
import type { CSSProperties, ReactNode } from "react";
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
  getChatboxShellStyle,
  type ChatboxHostStyle,
} from "@/lib/chatbox-client-style";
import { DEFAULT_HOST_STYLE, type ChatUiOverride } from "@/lib/client-styles";
import { detectUiTypeFromTool } from "@/lib/mcp-ui/mcp-apps-utils";
import { PRESET_DEVICE_CONFIGS } from "@/components/shared/ClientContextHeader";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { Settings2 } from "lucide-react";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { useConvexAuth, useQuery } from "convex/react";
import {
  useHost,
  useHostList,
  useHostMutations,
  type HostListItem,
  type HostDetail,
} from "@/hooks/useClients";
import {
  emptyHostConfigInputV2,
  gateMcpToolResultImageRenderingByModelVisibility,
} from "@/lib/client-config-v2";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useHarnessBuiltinTools } from "@/hooks/useHarnessBuiltinTools";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";
import { usePersistedHost } from "@/hooks/use-persisted-host";
import { usePlaygroundHostSlots } from "@/hooks/use-playground-host-slots";
import { replaceLeadHostId } from "@/lib/selected-host-storage";
import { useProjectServers } from "@/hooks/useViews";
import { useProjectMembers } from "@/hooks/useProjects";
import { buildProjectOwnerProfileByUserId } from "@/components/chat-v2/history/project-thread-owner-avatar";
import { buildSenderAvatarResolver } from "@/components/chat-v2/shared/sender-avatar";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { buildOAuthTokensByServerId } from "@/lib/oauth/oauth-tokens";
import { snapshotFromHostConfig, type HostSnapshot } from "@/lib/host-snapshot";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type { HostConfigDtoV2 } from "@/lib/client-config-v2";
import { useHostContextStore } from "@/stores/client-context-store";
import {
  extractEffectiveHostDisplayMode,
  extractHostTheme,
  type ProjectHostContextDraft,
} from "@/lib/client-config";
import { PostConnectGuide } from "@/components/ui-playground/PostConnectGuide";
import {
  ChatboxChatUiOverrideProvider,
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
  hostStyleSupportsModelVisibleMcpToolImages,
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
import { shouldAutoRunPreview, shouldRunPreview } from "./preview-autorun";
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
import { WebApiError } from "@/lib/apis/web/base";
import { useDirectChatSessionSubscription } from "@/hooks/use-direct-chat-session-subscription";
import { WidgetSurfaceProvider } from "@/contexts/widget-surface-context";
import type { RecorderProps } from "@/components/chat-v2/thread/recorder-types";
import {
  isToolPart,
  isDynamicTool,
  getToolInfo,
} from "@/components/chat-v2/thread/thread-helpers";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import { upsertWidgetModelContextEntry } from "@/lib/widget-model-context";

// On post-stream reconcile, the Convex-side detail row may not yet reflect the
// version bump from the turn that just finished. Retry a couple of times.
const RESUMED_THREAD_REFRESH_RETRIES = 2;

function buildHistoryContentSignature(
  session: ChatHistoryDetailSession,
  widgetSnapshots?: ChatHistoryWidgetSnapshot[]
) {
  const snapshotSignature = (widgetSnapshots ?? [])
    .map((snapshot) =>
      [
        snapshot._id,
        snapshot.toolCallId,
        snapshot.resourceUri ?? "",
        snapshot.widgetHtmlUrl ?? "",
        snapshot.toolOutputUrl ?? "",
      ].join(":")
    )
    .sort()
    .join("|");
  return [
    session._id,
    session.chatSessionId,
    session.messagesBlobUrl ?? "",
    snapshotSignature,
  ].join("::");
}

/** Custom device config - dimensions come from store */
const CUSTOM_DEVICE_BASE = {
  label: "Custom",
  icon: Settings2,
};

type ThreadThemeMode = "light" | "dark";

interface PlaygroundCompareThemeScopeProps {
  children: ReactNode;
  hostStyle: ChatboxHostStyle;
  hostCapabilitiesOverride: Record<string, unknown> | undefined;
  chatUiOverride: ChatUiOverride | undefined;
  effectiveThreadTheme: ThreadThemeMode;
  hostShellStyle: CSSProperties;
}

function PlaygroundCompareThemeScope({
  children,
  hostStyle,
  hostCapabilitiesOverride,
  chatUiOverride,
  effectiveThreadTheme,
  hostShellStyle,
}: PlaygroundCompareThemeScopeProps) {
  return (
    <ChatboxHostStyleProvider value={hostStyle}>
      <ChatboxHostCapabilitiesOverrideProvider value={hostCapabilitiesOverride}>
        <ChatboxChatUiOverrideProvider value={chatUiOverride}>
          <ChatboxHostThemeProvider value={effectiveThreadTheme}>
            <div
              className={cn(
                "chatbox-host-shell app-theme-scope flex h-full min-h-0 flex-col overflow-hidden",
                effectiveThreadTheme === "dark" && "dark"
              )}
              data-testid="playground-compare-shell"
              data-host-style={hostStyle}
              data-thread-theme={effectiveThreadTheme}
              style={hostShellStyle}
            >
              {children}
            </div>
          </ChatboxHostThemeProvider>
        </ChatboxChatUiOverrideProvider>
      </ChatboxHostCapabilitiesOverrideProvider>
    </ChatboxHostStyleProvider>
  );
}

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
    modelOutput?: unknown;
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
  hideInlineEdit?: boolean;
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
   * Mirrors the ChatTabV2 behavior so eval "Continue in chat" lands here.
   */
  evalChatHandoff?: EvalChatHandoff | null;
  onEvalChatHandoffConsumed?: (id: string) => void;
  /**
   * Suppress the "This is your playground for MCP" welcome hero in the empty
   * state (the composer still shows). Used by the embedded eval preview, where
   * that onboarding copy doesn't belong.
   */
  hideWelcomeHero?: boolean;
  /**
   * Hide the playground client-context chrome (Compare, locale, host caps, …)
   * in the center header. Used by the embedded eval preview — those controls
   * belong in Playground, not while authoring a case. Trace / Chat / Raw tabs
   * may still show when supported.
   */
  hideCenterHeaderChrome?: boolean;
  /**
   * When set, auto-send this prompt once on mount (after session bootstrap +
   * server readiness), fired a single time while the thread is still empty.
   * Used by the eval preview to "run on open" when the case renders a widget.
   */
  autoRunInput?: string;
  /**
   * Increment to re-run the case in the live preview from outside (eval Quick
   * Run). Each new value resets the thread and re-sends the case prompt
   * (`initialInput`) fresh, once the session is ready.
   */
  runPreviewRequest?: number;
  /**
   * Fires whenever the live chat's messages change. Used by the eval preview to
   * capture the conversation (prompts + observed tool calls) back into the case
   * spec. Pass a STABLE callback (useCallback) — it's an effect dependency.
   */
  onMessagesChange?: (messages: UIMessage[]) => void;
  /**
   * Fires when the live chat's streaming state changes. The eval preview uses
   * the true→false edge to detect that a Quick Run finished. Pass a STABLE
   * callback (useCallback) — it's an effect dependency.
   */
  onStreamingChange?: (streaming: boolean) => void;
  /**
   * Silences the post-stream "this chat changed elsewhere" detach toast. The
   * eval preview is an ephemeral sandbox whose own Quick Run / widget replay
   * mutates the session, so that alarm is self-inflicted noise there.
   */
  suppressHistoryConflictToast?: boolean;
  /**
   * Tier-3 recorder (eval preview only). Forwarded to the single-pane Thread so
   * the armed widget records interaction steps. `resolvePromptIndex` is injected
   * here from the live messages (toolCallId → owning user-turn ordinal).
   */
  recorder?: RecorderProps;
}

type PlaygroundTraceViewMode = "chat" | "timeline" | "raw";

/**
 * Per-column data for the Phase 4 multi-host compare grid. Mirrors the
 * shape `MultiModelPlaygroundCard` consumes; one entry per resolved host.
 *
 * `hostConfig` is the full DTO (used for the `hostCapsResolver` scope
 * prop, which evaluates per-server capability resolution at render
 * time). `hostSnapshot` is the projected subset used for the value-
 * provider shadows (style, caps, chat UI, MCP profile).
 */
interface MultiHostColumn {
  compareId: string;
  compareLabel: string;
  compareKind: "host";
  compareSubLabel: string;
  model: ModelDefinition;
  executionConfig: ExecutionConfig;
  hostSnapshot: HostSnapshot;
  hostConfig: HostConfigDtoV2;
}

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

type CompareMode = "none" | "model" | "host";

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
  hideInlineEdit = false,
  disabledInputPlaceholder = "Input disabled in Views",
  initialInput,
  initialInputTypewriter = false,
  blockSubmitUntilServerConnected = false,
  pulseSubmit = false,
  showPostConnectGuide = false,
  onFirstMessageSent,
  evalChatHandoff = null,
  onEvalChatHandoffConsumed,
  hideWelcomeHero = false,
  hideCenterHeaderChrome = false,
  autoRunInput,
  runPreviewRequest,
  onMessagesChange,
  onStreamingChange,
  suppressHistoryConflictToast,
  recorder,
}: PlaygroundMainProps) {
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const clearLogs = useTrafficLogStore((s) => s.clear);

  // Chat-history coordination — Playground equivalent of ChatTabV2's history
  // machinery, scoped down to what the docked rail actually needs.
  const [activeHistorySessionId, setActiveHistorySessionId] = useState<
    string | null
  >(null);
  // Stable thread-owner userId captured at history-load time so sender-avatar
  // resolution doesn't flash the current user's avatar in the window before
  // the reactive Convex subscription lands. Cleared on detach/reset/new-chat.
  const [loadedThreadOwnerUserId, setLoadedThreadOwnerUserId] = useState<
    string | null
  >(null);
  // True only when the user is viewing an OLD history session they explicitly
  // selected (or that was restored on bootstrap). `activeHistorySessionId`
  // alone is too coarse: it also gets auto-assigned to the LIVE current chat
  // after the first stream completes via `refreshCurrentHistorySession`,
  // which would otherwise collapse the multi-host / multi-model grid on
  // every send. Compare gates key off this flag so the layout only steps
  // aside for genuine replay.
  const [viewingHistoryReplay, setViewingHistoryReplay] = useState(false);
  const [loadingHistorySessionId, setLoadingHistorySessionId] = useState<
    string | null
  >(null);
  const [pendingDirectVisibility, setPendingDirectVisibility] = useState<
    "private" | "project"
  >("private");
  // Shared (project-visible) sessions are collaborative artifacts. Treat
  // multi-model and multi-host compare as experiment-mode controls that
  // would mutate the shared session state for every collaborator, and
  // hide them. The single-model + single-host path stays usable.
  const isSharedSession = pendingDirectVisibility === "project";
  // ChatTabV2 holds this at 0 today; bumping after each completed turn is a
  // follow-up. The rail re-fetches on initial mount + whenever signal changes.
  const historyRefreshSignal = 0;
  const historySelectionRequestIdRef = useRef(0);
  const activeHistorySessionIdRef = useRef<string | null>(null);
  const reactiveHistoryLoadRequestIdRef = useRef(0);
  const appliedHistoryContentSignatureRef = useRef<string | null>(null);
  const resumedThreadSendBaselineRef = useRef<{
    sessionId: string;
    version: number;
  } | null>(null);

  useEffect(() => {
    activeHistorySessionIdRef.current = activeHistorySessionId;
    reactiveHistoryLoadRequestIdRef.current += 1;
    if (!activeHistorySessionId) {
      appliedHistoryContentSignatureRef.current = null;
    }
  }, [activeHistorySessionId]);

  /** Invalidate reactive history loads immediately (refs otherwise lag behind state until useEffect). */
  const invalidatePendingReactiveHistoryLoad = useCallback(() => {
    activeHistorySessionIdRef.current = null;
    reactiveHistoryLoadRequestIdRef.current += 1;
  }, []);

  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    []
  );
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    WidgetModelContextEntry[]
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
  // Phase 3 (multi-host plan): per-column state is keyed by `compareId` — a
  // mode-neutral column identifier. In model mode `compareId === String(model.id)`
  // (unchanged from today); in host mode (Phase 4) it'll be the hostId, so two
  // columns running the same default model can't collide.
  const [compareSummaries, setCompareSummaries] = useState<
    Record<string, MultiModelCardSummary>
  >({});
  const [compareHasMessages, setCompareHasMessages] = useState<
    Record<string, boolean>
  >({});
  const [multiCompareEnterVersion, setMultiCompareEnterVersion] = useState(0);
  const [multiCompareEnterMessages, setMultiCompareEnterMessages] = useState<
    UIMessage[]
  >([]);
  const [compareAddColumnSeeds, setCompareAddColumnSeeds] = useState<
    Record<string, { version: number; messages: UIMessage[] }>
  >({});
  const compareTranscriptsRef = useRef<Record<string, UIMessage[]>>({});
  // Three-state compare mode tracked across renders so transition effects
  // can tell "off → multi-host" from "multi-model → multi-host" (the
  // latter needs cross-mode transcript handoff). Refs are mode-neutral
  // after Phase 3, so harvest/seed reads the same `compareTranscriptsRef`
  // shape regardless of which mode held it.
  const prevCompareModeRef = useRef<CompareMode>("none");
  const lastCompareLeadIdRef = useRef<string | null>(null);
  const prevCompareIdsRef = useRef<Set<string>>(new Set());
  const multiAddColumnSeqRef = useRef(0);
  // Device config from store (managed by ClientContextHeader)
  const storeDeviceType = useUIPlaygroundStore((s) => s.deviceType);
  const customViewport = useUIPlaygroundStore((s) => s.customViewport);
  const hostContext = useHostContextStore((s) => s.draftHostContext);
  const patchHostContext = useHostContextStore((s) => s.patchHostContext);

  // Device config for frame sizing. "fill" (the default) takes the whole
  // panel — no host renders chat inside a fixed-size frame, so emulation
  // presets are opt-in.
  const deviceConfig = useMemo<{
    width: number | string;
    height: number | string;
  }>(() => {
    if (storeDeviceType === "fill") {
      return { width: "100%", height: "100%" };
    }
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
  // Multi-server: `playgroundServerSelectorProps.selectedMultipleServers` is
  // the source of truth for which servers the chat session sees in the
  // Playground tab. Views and other read-only surfaces don't pass this and
  // fall through to the single `serverName` prop below.
  const multiSelectedServerNames = useMemo(() => {
    const propsMulti = playgroundServerSelectorProps?.selectedMultipleServers;
    if (Array.isArray(propsMulti) && propsMulti.length > 0) {
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
      // Playground is always multi-server: toggle membership in the set so
      // users can have several servers active at once. The LLM sees the union
      // of tools, and the docked tools pane aggregates across them.
      playgroundServerSelectorProps?.onMultiServerToggle?.(name);
    },
    [playgroundServerSelectorProps]
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
  // Match the global host picker / HostsTab / useAppState scope: prefer
  // the shared project id (what `GlobalHostBar` and `HostsTab` write),
  // falling back to `activeProjectId` for CLI / no-cloud-sync flows where
  // `convexProjectId` is null. Reading only from `activeProjectId` here
  // silently disabled the reseed in authed projects because the writer
  // wrote under a different storage scope.
  const [previewedHostId, setPreviewedHostId] = usePreviewedHostId(
    convexProjectId ?? activeProjectId
  );
  const { host: previewedHost } = useHost({
    isAuthenticated: isConvexAuthenticated,
    hostId: previewedHostId,
  });
  const effectiveMcpToolResultImageRendering = useMemo(
    () =>
      gateMcpToolResultImageRenderingByModelVisibility(
        previewedHost?.config?.mcpToolResultImageRendering,
        previewedHost?.config?.modelVisibleMcpToolResults
      ),
    [
      previewedHost?.config?.mcpToolResultImageRendering,
      previewedHost?.config?.modelVisibleMcpToolResults,
    ]
  );
  // Native built-in tools for the previewed harness (if any) — fed into the Raw
  // tab so a harness host's empty `tools` is annotated rather than confusing.
  const { tools: harnessBuiltinTools } =
    useHarnessBuiltinTools(previewedHostId);

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
      // Forward the previewed host id so the server re-resolves its
      // authoritative runtime config (harness/computer) for this direct
      // session, and so switching hosts forks the chat session.
      ...(previewedHostId ? { hostId: previewedHostId } : {}),
    },
    // Source the host-level toggle from the previewed host's resolved
    // DTO so flipping it in the host's Agent → Behavior tab takes
    // effect on the very next send without remounting the playground.
    progressiveToolDiscovery: previewedHost?.config?.progressiveToolDiscovery,
    respectToolVisibility: previewedHost?.config?.respectToolVisibility,
    modelVisibleMcpToolResults:
      previewedHost?.config?.modelVisibleMcpToolResults,
    mcpToolResultImageRendering: effectiveMcpToolResultImageRendering,
    // Same live-source pattern: built-in tool attachments flow from the
    // previewed host's hostConfig. The server re-resolves via the shared
    // execution-context helper, so this also flows through chatbox sessions
    // (where the persisted host config wins via the runtime-config fetch).
    builtInToolIds: previewedHost?.config?.builtInToolIds,
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
  // Declared early so the previewed-host reseed effect can early-return
  // while an eval-chat handoff is still pending. The handoff-consume
  // effect that flips this ref runs later in the file.
  const appliedEvalChatHandoffIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!previewedHostId || !previewedHost) {
      // Clear the dedupe ref so a later return to the same (hostId, configId)
      // — after a transient host-unavailable phase or project switch — still
      // reseeds the composer instead of short-circuiting on a stale ref.
      lastSeededHostRef.current = null;
      return;
    }
    // Don't reseed `selectedMultipleServers` from the previewed host while
    // an eval-chat handoff is pending: `handleContinueEvalInChat` has
    // already written `handoff.serverNames` into the multi-set, and the
    // handoff-consume effect (below) doesn't touch the server selection.
    // Without this guard the eval thread opens with the previewed host's
    // server set instead of the eval's.
    //
    // We ALSO mark `lastSeededHostRef` as committed for this (hostId,
    // configId) — otherwise after the handoff is consumed and the parent
    // clears `evalChatHandoff`, this effect re-runs (deps like
    // `serversById` can hydrate later) and the reseed block fires,
    // overwriting `handoff.serverNames` on the previewed host's required
    // set. The eval's selection conceptually IS the seed for the
    // current host this mount; if the user later switches hosts, the
    // (hostId, configId) tuple changes and the reseed fires normally
    // for the new host.
    if (
      evalChatHandoff &&
      appliedEvalChatHandoffIdRef.current !== evalChatHandoff.id
    ) {
      lastSeededHostRef.current = {
        hostId: previewedHostId,
        configId: previewedHost.config.id,
      };
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

  // Currently selected protocol — derived from the selected tool's metadata
  // so the CSP-mode chip in ClientContextHeader matches the active widget
  // family without a redundant store field.
  const selectedToolName = useUIPlaygroundStore((s) => s.selectedTool);
  const playgroundTools = useUIPlaygroundStore((s) => s.tools);
  const selectedProtocol = useMemo(() => {
    if (!selectedToolName) return null;
    const tool = playgroundTools[selectedToolName];
    if (!tool) return null;
    return detectUiTypeFromTool(tool);
  }, [selectedToolName, playgroundTools]);

  // Host chat background: actual chat area colors from each host's UI
  // (separate from the 76 MCP spec widget design tokens)
  const hostStyle = usePreferencesStore((s) => s.hostStyle);
  const hostCapabilitiesOverride = usePreferencesStore(
    (s) => s.hostCapabilitiesOverride
  );
  const chatUiOverride = usePreferencesStore((s) => s.chatUiOverride);
  const globalThemeMode = usePreferencesStore(
    (s) => s.themeMode
  ) as ThreadThemeMode;
  const themePreset = usePreferencesStore((s) => s.themePreset);
  const effectiveThreadTheme = extractHostTheme(hostContext) ?? globalThemeMode;
  const hostStyleFamily = getChatboxHostFamily(hostStyle) ?? "claude";
  const hostBackgroundColor =
    getChatboxChatBackground(hostStyle, effectiveThreadTheme) ??
    DEFAULT_HOST_STYLE.chatUi.resolveChatBackground(effectiveThreadTheme);
  const hostShellStyle = getChatboxShellStyle(
    hostStyle,
    effectiveThreadTheme,
    chatUiOverride
  );
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
    enableMultiModelChat && availableModels.length > 1 && !isSharedSession;

  // Phase 4 (multi-host plan): read multi-host state in parallel to
  // multi-model. Lead host is derived inside `usePersistedHost` from the
  // per-project `usePreviewedHostId`, so `selectedHostIds[0]` is always
  // the lead.
  //
  // This is the SINGLE source of truth for picker + grid. The
  // `PlaygroundHostPicker` rendered below is a controlled component —
  // it does NOT call `usePersistedHost` itself. Two sibling hooks
  // wouldn't stay in sync because `selected-host-storage.ts` doesn't
  // dispatch same-tab events on `saveSelectedHostIds` (deliberate, per
  // the Phase-1 multi-select regression fix); lifting state to this
  // common parent is the correct fix instead of adding event traffic.
  const multiHostProjectId = convexProjectId ?? activeProjectId ?? null;
  const {
    selectedHostIds,
    setSelectedHostIds,
    multiHostEnabled,
    setMultiHostEnabled,
  } = usePersistedHost(multiHostProjectId);
  const { hosts: hostList, isLoading: hostListLoading } = useHostList({
    isAuthenticated: isConvexAuthenticated,
    projectId: multiHostProjectId,
  });
  const { createHost: createPlaygroundHost } = useHostMutations();
  const resolveFallbackHostId = useCallback(
    (hosts: HostListItem[]): string | null => {
      const mcpjamHost = hosts.find((host) => host.name === "MCPJam");
      if (mcpjamHost) return mcpjamHost.hostId;
      const [firstHost] = [...hosts].sort((a, b) =>
        a.name.localeCompare(b.name)
      );
      return firstHost?.hostId ?? null;
    },
    []
  );
  // Seed backstop: the global host bar (which normally auto-creates the
  // default "MCPJam" host for empty projects) is hidden on the playground,
  // so replicate its one-shot seed here. Guarded by `hostList.length === 0`
  // + a per-project ref so it fires at most once per empty project and never
  // blocks a different empty project from getting its own default host.
  const playgroundSeededProjectIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (
      !isConvexAuthenticated ||
      hostListLoading ||
      !multiHostProjectId ||
      hostList.length > 0 ||
      playgroundSeededProjectIdsRef.current.has(multiHostProjectId)
    ) {
      return;
    }
    playgroundSeededProjectIdsRef.current.add(multiHostProjectId);
    createPlaygroundHost({
      projectId: multiHostProjectId,
      name: "MCPJam",
      input: emptyHostConfigInputV2(),
    })
      .then(({ hostId }) => {
        setPreviewedHostId(hostId);
      })
      .catch(() => {
        playgroundSeededProjectIdsRef.current.delete(multiHostProjectId);
      });
  }, [
    isConvexAuthenticated,
    hostListLoading,
    multiHostProjectId,
    hostList.length,
    createPlaygroundHost,
    setPreviewedHostId,
  ]);
  useEffect(() => {
    if (
      !isConvexAuthenticated ||
      hostListLoading ||
      !multiHostProjectId ||
      hostList.length === 0
    ) {
      return;
    }
    const previewedHostIsValid =
      previewedHostId !== null &&
      hostList.some((host) => host.hostId === previewedHostId);
    if (previewedHostIsValid) return;
    const fallbackHostId = resolveFallbackHostId(hostList);
    if (fallbackHostId) setPreviewedHostId(fallbackHostId);
  }, [
    isConvexAuthenticated,
    hostListLoading,
    multiHostProjectId,
    hostList,
    previewedHostId,
    resolveFallbackHostId,
    setPreviewedHostId,
  ]);
  // Fixed 3-slot `useHost` calls (the multi-host cap is 3). Each slot
  // short-circuits on null id so passing fewer ids is free. See
  // `usePlaygroundHostSlots` for the rules-of-hooks reasoning.
  const hostSlots = usePlaygroundHostSlots(
    isConvexAuthenticated,
    selectedHostIds
  );
  const resolvedSelectedHosts = useMemo<HostDetail[]>(
    () =>
      hostSlots
        .slice(0, selectedHostIds.length)
        .map((slot) => slot.host)
        .filter((host): host is HostDetail => host !== null),
    [hostSlots, selectedHostIds.length]
  );
  const canEnableMultiHost = hostList.length > 1 && !isSharedSession;

  // Lead identity check — we cannot compact away the lead slot. If
  // `selectedHostIds[0]` is still loading from Convex, the resolved
  // list would collapse so `resolvedSelectedHosts[0]` would no longer
  // be the lead — secondary slot 1 would be misidentified as lead.
  // Gate `isMultiHostMode` on the lead host being resolved AND the
  // chat-input model being selected; fall through to single-pane
  // otherwise. Secondaries are still allowed to be missing — those
  // just render fewer columns until their data arrives.
  //
  // Note: the column model is the chat-input picker's `selectedModel`,
  // NOT the lead host's persisted modelId. Multi-host varies the host
  // axis only — the input model applies to every column.
  const leadHostId = selectedHostIds[0] ?? null;
  const leadHost = leadHostId
    ? resolvedSelectedHosts.find((host) => host.hostId === leadHostId) ?? null
    : null;
  const sharedHostColumnModel = selectedModel ?? null;

  // Same gating as multi-model: history mode wins (transcript replay lives
  // on the single session). When `multiHostEnabled` is true but the lead
  // host or its model isn't resolved yet (loading, deleted, missing from
  // `availableModels`), fall through to single-pane — don't render a
  // degraded grid where the lead identity is wrong.
  // Multi-host compare requires at least 2 resolved columns. Without
  // this guard a stale persisted `multiHostEnabled = true` paired with
  // a single selected host (or only the lead resolving) would render
  // the compare grid as a one-column variant of single-pane — visually
  // confusing and routed through the compare submit/stop/state path
  // unnecessarily. The picker auto-disables `multiHostEnabled` when
  // selection drops to one, but we still want a defensive gate for
  // unresolved secondaries and migrated localStorage.
  const isMultiHostMode =
    canEnableMultiHost &&
    multiHostEnabled &&
    !viewingHistoryReplay &&
    resolvedSelectedHosts.length > 1 &&
    !!leadHost &&
    !!sharedHostColumnModel;

  // When viewing a history session the transcript lives on the single chat
  // session; compare layout would override that render. Matches ChatTabV2.
  // Multi-host wins over multi-model when both flags accidentally race
  // (mutually exclusive at the toggle layer below, but defense in depth).
  const isMultiModelMode =
    canEnableMultiModel &&
    multiModelEnabled &&
    !viewingHistoryReplay &&
    !isMultiHostMode;
  // Unified "the compare grid is live" flag. Submit/stop/deterministic-
  // execution/state-pruning all branch on this — anything that used to
  // gate on `isMultiModelMode` and writes to (or reads from) the
  // compare cards needs to fire for the host-axis grid too. Keep the
  // mode-specific flags around for code that still needs to know
  // WHICH compare grid is up (e.g. the per-column derivation memos).
  const isCompareMode = isMultiModelMode || isMultiHostMode;
  const { isMultiModelLayoutMode, onModelSelectorOpenChange } =
    useModelSelectorLayoutLock(isCompareMode);

  useEffect(() => {
    if (isMultiModelMode && resolvedSelectedModels[0]) {
      lastCompareLeadIdRef.current = String(resolvedSelectedModels[0].id);
    }
  }, [isMultiModelMode, resolvedSelectedModels]);

  // Mirror of the multi-model lead tracker for host mode. The transition
  // effect reads `lastCompareLeadIdRef` to harvest the outgoing lead's
  // transcript on exit/swap; since `compareTranscriptsRef` is keyed by
  // `compareId` (hostId in host mode, modelId in model mode), one ref is
  // enough — but only the in-mode tracker should write to it.
  useEffect(() => {
    if (isMultiHostMode && resolvedSelectedHosts[0]) {
      lastCompareLeadIdRef.current = resolvedSelectedHosts[0].hostId;
    }
  }, [isMultiHostMode, resolvedSelectedHosts]);

  // Multi-host axis is HOST only: every column shares the lead's model
  // and the global chip-edited `executionConfig`. The host axis varies
  // via `hostSnapshot`/`hostConfig` (capabilities, chat UI, MCP profile,
  // style). This mirrors multi-model mode's inverse: there model varies
  // with host pinned; here host varies with model + chat input pinned.
  const multiHostColumns = useMemo<MultiHostColumn[]>(() => {
    if (!isMultiHostMode || !sharedHostColumnModel) return [];
    const sharedExecutionConfig: ExecutionConfig = {
      systemPrompt,
      temperature,
      requireToolApproval,
    };
    const columns: MultiHostColumn[] = [];
    // Iterate `selectedHostIds` (not the compacted `resolvedSelectedHosts`)
    // so the lead is determined by the SLOT INDEX in the canonical
    // line-up. If slot 1 is missing while slot 0 + slot 2 are present,
    // the output is `[leadCol, /* nothing */, slot2Col]` → grid renders
    // 2 columns where the lead is still `selectedHostIds[0]`.
    for (let slotIndex = 0; slotIndex < selectedHostIds.length; slotIndex++) {
      const hostId = selectedHostIds[slotIndex];
      const host = resolvedSelectedHosts.find((h) => h.hostId === hostId);
      if (!host) continue;
      columns.push({
        compareId: host.hostId,
        compareLabel: host.name,
        compareKind: "host",
        compareSubLabel: sharedHostColumnModel.name,
        model: sharedHostColumnModel,
        executionConfig: sharedExecutionConfig,
        hostSnapshot: snapshotFromHostConfig(host.config),
        hostConfig: host.config,
      });
    }
    return columns;
  }, [
    isMultiHostMode,
    sharedHostColumnModel,
    selectedHostIds,
    resolvedSelectedHosts,
    systemPrompt,
    temperature,
    requireToolApproval,
  ]);

  const handleMultiModelTranscriptSync = useCallback(
    (compareId: string, transcript: UIMessage[]) => {
      compareTranscriptsRef.current[compareId] = cloneUiMessages(transcript);
    },
    []
  );

  const clearMultiModelUiState = useCallback(() => {
    setBroadcastRequest(null);
    setDeterministicExecutionRequest(null);
    setStopBroadcastRequestId(0);
    setCompareSummaries({});
    setCompareHasMessages({});
    setCompareAddColumnSeeds({});
    prevCompareIdsRef.current = new Set();
  }, []);

  // Three-mode transition machinery (Phase 6 core). Handles every direction:
  //
  //   none → model   : seed each column with current single-pane messages.
  //   none → host    : same — seed columns with single-pane messages.
  //   model → none   : harvest lead column's transcript, replay into single.
  //   host  → none   : same — harvest lead, replay into single.
  //   model ↔ host   : harvest outgoing lead, seed incoming columns with it
  //                    (the mutual-exclusion writes batch into one render,
  //                    so we observe a direct cross-mode transition here).
  //
  // Without this, toggling the picker drops the conversation on the floor —
  // either the single-pane transcript vanishes when entering compare, or
  // the lead column's transcript vanishes when exiting. That's the
  // "dead-on-arrival" UX the multi-host plan warned about.
  const currentCompareMode: CompareMode = isMultiHostMode
    ? "host"
    : isMultiModelMode
    ? "model"
    : "none";
  useLayoutEffect(() => {
    const prev = prevCompareModeRef.current;
    if (prev === currentCompareMode) return;

    const harvestLeadTranscript = (): UIMessage[] | null => {
      const leadId = lastCompareLeadIdRef.current;
      if (!leadId) return null;
      const transcript = compareTranscriptsRef.current[leadId];
      const hasConversation =
        transcript?.some((m) => m.role === "user" || m.role === "assistant") ??
        false;
      return hasConversation && transcript ? cloneUiMessages(transcript) : null;
    };

    if (prev === "none" && currentCompareMode !== "none") {
      // Enter compare from single-pane: seed every column with the
      // current single-pane transcript so the conversation continues
      // visibly in each card.
      setMultiCompareEnterVersion((v) => v + 1);
      setMultiCompareEnterMessages(cloneUiMessages(messages));
    } else if (prev !== "none" && currentCompareMode === "none") {
      // Exit compare to single-pane: replay the lead column's transcript
      // into the single chat so the user doesn't lose work.
      const harvested = harvestLeadTranscript();
      if (harvested) startChatWithMessages(harvested);
      clearMultiModelUiState();
    } else if (prev !== "none" && currentCompareMode !== "none") {
      // Direct model ↔ host swap (mutual exclusion fires both writes in
      // one batched render). Harvest the outgoing lead and seed the
      // incoming columns with the same transcript. Reset the in-flight
      // per-column UI state so the new mode starts clean.
      const harvested = harvestLeadTranscript();
      clearMultiModelUiState();
      setMultiCompareEnterVersion((v) => v + 1);
      setMultiCompareEnterMessages(harvested ?? cloneUiMessages(messages));
    }

    prevCompareModeRef.current = currentCompareMode;
  }, [
    currentCompareMode,
    messages,
    startChatWithMessages,
    clearMultiModelUiState,
  ]);

  useEffect(() => {
    if (!isMultiModelMode) {
      prevCompareIdsRef.current = new Set();
      return;
    }
    const current = new Set(resolvedSelectedModels.map((m) => String(m.id)));
    const prev = prevCompareIdsRef.current;
    const added = [...current].filter((id) => !prev.has(id));
    const leadId = resolvedSelectedModels[0]
      ? String(resolvedSelectedModels[0].id)
      : null;
    if (prev.size > 0 && added.length > 0 && leadId) {
      const src = compareTranscriptsRef.current[leadId] ?? [];
      multiAddColumnSeqRef.current += 1;
      const v = multiAddColumnSeqRef.current;
      setCompareAddColumnSeeds((s) => {
        const next = { ...s };
        for (const id of added) {
          next[id] = { version: v, messages: cloneUiMessages(src) };
        }
        return next;
      });
    }
    prevCompareIdsRef.current = current;
  }, [isMultiModelMode, resolvedSelectedModels]);

  // Host-mode sibling of the multi-model added-column effect above.
  // Without this, adding a host after the conversation has continued
  // in compare mode would seed the new column from the original
  // `compareEnterMessages` snapshot (the transcript at the moment
  // compare was first entered) instead of the lead's current state.
  // Mirrors the model branch: diff `prev` vs current host column ids,
  // and for any newly-added id, seed it from the lead's live
  // `compareTranscriptsRef` entry. `prevCompareIdsRef` is shared with
  // the model effect; that's safe because `isMultiHostMode` and
  // `isMultiModelMode` are mutually exclusive — whichever mode is off
  // clears the ref on its first run, so the active mode never sees a
  // foreign-id `prev` set.
  useEffect(() => {
    if (!isMultiHostMode) {
      prevCompareIdsRef.current = new Set();
      return;
    }
    const current = new Set(multiHostColumns.map((c) => c.compareId));
    const prev = prevCompareIdsRef.current;
    const added = [...current].filter((id) => !prev.has(id));
    const leadId = multiHostColumns[0]?.compareId ?? null;
    if (prev.size > 0 && added.length > 0 && leadId) {
      const src = compareTranscriptsRef.current[leadId] ?? [];
      multiAddColumnSeqRef.current += 1;
      const v = multiAddColumnSeqRef.current;
      setCompareAddColumnSeeds((s) => {
        const next = { ...s };
        for (const id of added) {
          next[id] = { version: v, messages: cloneUiMessages(src) };
        }
        return next;
      });
    }
    prevCompareIdsRef.current = current;
  }, [isMultiHostMode, multiHostColumns]);

  const effectiveHasMessages = isMultiModelLayoutMode
    ? Object.values(compareHasMessages).some(Boolean)
    : !isThreadEmpty;
  const preludeTraceEnvelope = useMemo(
    () =>
      buildPreludeTraceEnvelope(preludeTraceExecutions, {
        ...hostStyleSupportsModelVisibleMcpToolImages(hostStyle),
      }),
    [hostStyle, preludeTraceExecutions]
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
    isCompareMode,
    isStreaming,
    multiModelSummaries: compareSummaries,
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

  // Mirror of the `canEnableMultiModel` cleanup below: when the multi-host
  // gate flips false (host count drops, or the session becomes shared) and
  // the persisted `multiHostEnabled` is still true, reset it. Without this,
  // a user who had compare on in a private session would silently re-enter
  // compare the next time `canEnableMultiHost` flips back to true.
  useEffect(() => {
    if (!canEnableMultiHost && multiHostEnabled) {
      setMultiHostEnabled(false);
    }
  }, [canEnableMultiHost, multiHostEnabled, setMultiHostEnabled]);

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

  // Eval "Continue in chat" handoff. Mirrors ChatTabV2:1283-1340 so that the
  // handoff seeds a chat in Playground with the eval's model + messages.
  // `appliedEvalChatHandoffIdRef` is declared earlier so the previewed-host
  // reseed effect can gate on the handoff being pending.
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

    // Only clear the composer when the handoff actually seeds a conversation
    // (the "Continue in chat" flow). The eval live preview hands off an
    // EMPTY-message config-only handoff with the case prompt prefilled via
    // `initialInput`; clearing here would wipe that prefill.
    if (evalChatHandoff.messages.length > 0) {
      composer.setInput("");
    }
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
    fileAttachments.length > 0;

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
    invalidatePendingReactiveHistoryLoad();
    setLoadingHistorySessionId(null);
    setActiveHistorySessionId(null);
    setLoadedThreadOwnerUserId(null);
    setViewingHistoryReplay(false);
  }, [invalidatePendingReactiveHistoryLoad]);

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
      setLoadedThreadOwnerUserId(detail.userId ?? null);
      setPendingDirectVisibility(detail.directVisibility);
      appliedHistoryContentSignatureRef.current = buildHistoryContentSignature(
        detail,
        widgetSnapshots
      );
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

  // Shared-session sender attribution: only active for project-visible
  // threads. Members load via Convex for authenticated users with a
  // projectId; private sessions skip the avatar entirely.
  const { activeMembers: senderActiveMembers } = useProjectMembers({
    isAuthenticated: isConvexAuthenticated,
    projectId: convexProjectId ?? null,
  });
  const senderProfileByUserId = useMemo(
    () => buildProjectOwnerProfileByUserId(senderActiveMembers),
    [senderActiveMembers]
  );
  const currentUserForSender = useQuery(
    "users:getCurrentUser" as any,
    isConvexAuthenticated ? ({} as any) : "skip"
  ) as { _id?: string } | undefined;
  const senderFallbackUserId =
    reactiveHistorySession?.userId ??
    loadedThreadOwnerUserId ??
    currentUserForSender?._id ??
    null;
  const showSenderAvatars = pendingDirectVisibility === "project";
  const resolveSenderAvatar = useMemo(
    () =>
      buildSenderAvatarResolver({
        profileByUserId: senderProfileByUserId,
        fallbackOwnerUserId: senderFallbackUserId,
      }),
    [senderProfileByUserId, senderFallbackUserId]
  );
  // Stamp current user onto live outgoing prompts in shared sessions so the
  // transcript can attribute them before persistence round-trips.
  const outgoingSenderMetadata = useMemo<
    Record<string, unknown> | undefined
  >(() => {
    if (!showSenderAvatars) return undefined;
    const id = currentUserForSender?._id;
    if (!id) return undefined;
    return { senderUserId: id };
  }, [showSenderAvatars, currentUserForSender?._id]);

  const suppressHistoryConflictToastRef = useRef(suppressHistoryConflictToast);
  suppressHistoryConflictToastRef.current = suppressHistoryConflictToast;

  const detachHistorySession = useCallback(
    (toastMessage: string, opts?: { silent?: boolean }) => {
      resumedThreadSendBaselineRef.current = null;
      cancelPendingHistorySelection();
      setPendingDirectVisibility("private");
      setLoadedThreadOwnerUserId(null);
      syncResumedVersion(null);
      if (effectiveHasMessages) {
        startChatWithMessages(cloneUiMessages(messagesRef.current), {
          toolRenderOverrides: restoredToolRenderOverrides,
        });
      }
      // The eval preview is an ephemeral sandbox: its own Quick Run / replay
      // mutates the session (e.g. a replayed "Add to cart" click fires a tool
      // call), so a "changed elsewhere" alarm there is self-inflicted noise. The
      // detach still happens; we just skip the user-facing toast.
      if (!opts?.silent) {
        toast.error(toastMessage);
      }
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

    if (loadingHistorySessionId === activeHistorySessionId) {
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

    const contentSignature = buildHistoryContentSignature(
      reactiveHistorySession,
      reactiveHistoryWidgetSnapshots
    );
    if (appliedHistoryContentSignatureRef.current === contentSignature) {
      setPendingDirectVisibility(reactiveHistorySession.directVisibility);
      syncResumedVersion(reactiveHistorySession.version);
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
    loadingHistorySessionId,
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
          setLoadedThreadOwnerUserId(detail.session.userId ?? null);
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
      setViewingHistoryReplay(true);
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
          setViewingHistoryReplay(false);
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

  const resetMultiModelSessions = useCallback(() => {
    clearMultiModelUiState();
    setMultiModelSessionGeneration((previous) => previous + 1);
  }, [clearMultiModelUiState]);

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
      // Compare lanes hold their own useChatSession state; resetting the
      // root single-model session alone leaves the visible lane transcripts
      // intact and the user sees nothing happen.
      resetMultiModelSessions();
      setLoadedThreadOwnerUserId(null);
      setPendingDirectVisibility(options?.shared ? "project" : "private");
    },
    [
      cancelPendingHistorySelection,
      clearComposerDraft,
      ensureDiscardDraftConfirmed,
      isStreaming,
      resetChat,
      resetMultiModelSessions,
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
      resetMultiModelSessions();
      setLoadedThreadOwnerUserId(null);
      setPendingDirectVisibility("private");
    },
    [
      cancelPendingHistorySelection,
      clearComposerDraft,
      resetChat,
      resetMultiModelSessions,
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
            "This chat changed elsewhere. This reply stayed local, and your next send will continue in a new thread.",
            { silent: suppressHistoryConflictToastRef.current }
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

  // `compareSummaries` / `compareHasMessages` are keyed by `compareId`,
  // which is a modelId in multi-model mode and a hostId in multi-host
  // mode. Pre-fix the prune set was model-ids only, so changing the
  // chat-input model in host compare would evict every host-keyed
  // entry — the grid would hide despite the cards still holding live
  // transcripts. Include both axes in the active set.
  //
  // Depend on a derived STRING KEY of the live compareIds, not the
  // array refs themselves: `multiHostColumns` recomputes every render
  // (`resolvedSelectedHosts` is fed by `usePlaygroundHostSlots`, which
  // returns a fresh tuple per call). With the arrays in `useEffect`'s
  // deps the effect re-ran every render, `setCompareSummaries({})`
  // wrote a new ref, that triggered another render, and so on
  // — "Maximum update depth exceeded". Primitives are compared by
  // value so the key is stable across renders when the id set hasn't
  // changed.
  const activeCompareIdsKey = useMemo(() => {
    const parts: string[] = [];
    for (const model of resolvedSelectedModels) {
      parts.push(`m:${String(model.id)}`);
    }
    for (const column of multiHostColumns) {
      parts.push(`h:${column.compareId}`);
    }
    parts.sort();
    return parts.join("|");
  }, [resolvedSelectedModels, multiHostColumns]);

  useEffect(() => {
    const activeIds = new Set<string>();
    for (const model of resolvedSelectedModels) {
      activeIds.add(String(model.id));
    }
    for (const column of multiHostColumns) {
      activeIds.add(column.compareId);
    }

    setCompareSummaries((previous) => {
      const filtered = Object.fromEntries(
        Object.entries(previous).filter(([compareId]) =>
          activeIds.has(compareId)
        )
      );
      // Bail when the filter would be a no-op so we don't write a new
      // reference into state for an unchanged value.
      return Object.keys(filtered).length === Object.keys(previous).length
        ? previous
        : filtered;
    });
    setCompareHasMessages((previous) => {
      const filtered = Object.fromEntries(
        Object.entries(previous).filter(([compareId]) =>
          activeIds.has(compareId)
        )
      );
      return Object.keys(filtered).length === Object.keys(previous).length
        ? previous
        : filtered;
    });
    // The set itself is read from `resolvedSelectedModels` and
    // `multiHostColumns` (latest values via closure). The dep is a
    // stable string key — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCompareIdsKey]);

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
    // Both compare modes fan out via `deterministicExecutionRequest`;
    // the hidden-root path is only for single-pane. Pre-fix, host
    // compare wrote to the hidden root session instead of the visible
    // cards.
    if (isCompareMode) {
      const requestId = Date.now();
      const toolCallId =
        pendingExecution.toolCallId ?? `playground-tool-${requestId}`;
      setDeterministicExecutionRequest({
        id: requestId,
        toolName: pendingExecution.toolName,
        params: pendingExecution.params,
        result: pendingExecution.result,
        modelOutput: pendingExecution.modelOutput,
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
    const deterministicOptions = {
      ...(pendingExecution.state === "output-error"
        ? {
            state: "output-error" as const,
            errorText: pendingExecution.errorText,
            toolCallId: pendingExecution.toolCallId,
          }
        : pendingExecution.toolCallId
        ? {
            toolCallId: pendingExecution.toolCallId,
            modelOutput: pendingExecution.modelOutput,
          }
        : pendingExecution.modelOutput
        ? { modelOutput: pendingExecution.modelOutput }
        : {}),
      mcpToolResultImageRendering: effectiveMcpToolResultImageRendering,
    };
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
        modelOutput: pendingExecution.modelOutput,
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
  }, [
    isCompareMode,
    onExecutionInjected,
    pendingExecution,
    effectiveMcpToolResultImageRendering,
    setMessages,
  ]);

  useEffect(() => {
    if (!isCompareMode && hasTraceSnapshot) {
      setPreludeTraceExecutions([]);
    }
  }, [hasTraceSnapshot, isCompareMode]);

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
        sendMessage({
          text,
          metadata: outgoingSenderMetadata,
          widgetModelContext: modelContextQueue,
        });
        setModelContextQueue([]);
      })();
    },
    [
      ensureSelectedServerReadyForChat,
      modelContextQueue,
      sendMessage,
      outgoingSenderMetadata,
    ]
  );

  // Auto-run: when `autoRunInput` is set (eval preview "run on open"), send it
  // once after the session has bootstrapped and while the thread is still
  // empty. `handleSendFollowUp` ensures the server is connected first. The ref
  // makes it fire exactly once per mount even as deps change.
  const autoRanRef = useRef(false);
  useEffect(() => {
    const handoffPending =
      !!evalChatHandoff &&
      appliedEvalChatHandoffIdRef.current !== evalChatHandoff.id;
    if (
      !shouldAutoRunPreview({
        autoRunInput,
        alreadyRan: autoRanRef.current,
        isSessionBootstrapComplete,
        isThreadEmpty,
        isStreaming,
        handoffPending,
      })
    ) {
      return;
    }
    autoRanRef.current = true;
    handleSendFollowUp(autoRunInput as string);
    // The prompt was just auto-sent, so clear it out of the composer. The
    // composer is otherwise seeded with the same `initialInput` (so it mirrors
    // the eval editor's left-pane prompt); leaving the sent text behind would
    // both look stale and invite an accidental duplicate send. The mirror only
    // re-seeds when `initialInput` itself changes, so this clear sticks.
    composer.setInput("");
  }, [
    autoRunInput,
    composer,
    evalChatHandoff,
    isSessionBootstrapComplete,
    isThreadEmpty,
    isStreaming,
    handleSendFollowUp,
  ]);

  // Surface the live conversation to embedders (eval preview captures it back
  // into the case spec). Effect-driven so it tracks streaming updates too.
  useEffect(() => {
    onMessagesChange?.(messages);
  }, [messages, onMessagesChange]);

  // Surface "is the run busy" to embedders. The eval preview uses the
  // true→false edge to know a Quick Run finished and grade/replay the result.
  // It must stay true across the WHOLE agent loop — including client-side tool
  // execution, when `isStreaming` briefly drops between the model's segments —
  // or the preview would finalize mid-loop (replay clicks while the model is
  // still calling tools). `isStreaming || isExecuting` only goes false when the
  // model AND any tool execution are both done.
  const isRunBusy = isStreaming || !!isExecuting;
  useEffect(() => {
    onStreamingChange?.(isRunBusy);
  }, [isRunBusy, onStreamingChange]);

  // Handle model context updates from widgets (SEP-1865 ui/update-model-context)
  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      }
    ) => {
      setModelContextQueue((previous) =>
        upsertWidgetModelContextEntry(previous, toolCallId, context)
      );
    },
    []
  );

  const handleResetAllChats = useCallback(() => {
    composer.prepareForClearChat();
    resetChat();
    clearLogs();
    setInjectedToolRenderOverrides({});
    setPreludeTraceExecutions([]);
    resetMultiModelSessions();
    setViewingHistoryReplay(false);
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
      // Lightweight mutual exclusion (Phase 4 scope). Flipping multi-
      // model ON force-clears multi-host. Also collapse the host
      // compare lineup so it doesn't linger as "two clients checked,
      // Compare off" — that left the user having to manually
      // uncheck/recheck a host to re-enter compare. Falling back to
      // an empty array lets `effectiveSelectedHostIds` in
      // `MultiHostPicker` pick up the live lead from `currentHostId`.
      if (enabled && multiHostEnabled) {
        setMultiHostEnabled(false);
        setSelectedHostIds([]);
      }
    },
    [
      setMultiModelEnabled,
      multiHostEnabled,
      setMultiHostEnabled,
      setSelectedHostIds,
    ]
  );

  // Phase 4 lightweight mutual exclusion (see comment on
  // `handleMultiModelEnabledChange`). Wired into `PlaygroundHostPicker`
  // via `onMultiHostEnabledChange`. After the "lift state ownership"
  // fix the picker no longer calls `usePersistedHost` itself — both
  // the toggle value and its setter come from THIS component's single
  // hook instance, so any flip propagates without storage events.
  const handleMultiHostEnabledChange = useCallback(
    (enabled: boolean) => {
      setMultiHostEnabled(enabled);
      if (enabled && multiModelEnabled) {
        setMultiModelEnabled(false);
      }
    },
    [setMultiHostEnabled, multiModelEnabled, setMultiModelEnabled]
  );

  // Lead-host promotion: the picker delegates the "make this host the
  // lead" gesture to the parent so the canonical write
  // (`replaceLeadHostId(projectId, hostId)`) targets the SAME project
  // id as `usePersistedHost` above. If the picker called
  // `replaceLeadHostId` itself with a different project id (e.g.
  // `activeProjectId` while the grid was scoped to `convexProjectId`),
  // the storage scope would split and the grid wouldn't see the
  // promotion. See `selected-host-storage.ts` for the canonical-write
  // contract.
  const handlePromoteLead = useCallback(
    (hostId: string) => {
      if (!multiHostProjectId) return;
      replaceLeadHostId(multiHostProjectId, hostId);
    },
    [multiHostProjectId]
  );

  const handleRequireToolApprovalChange = useCallback(
    (enabled: boolean) => {
      setRequireToolApproval(enabled);
      // Approval is plumbed into per-card sessions via `executionConfig`,
      // not the hidden root chat. Both compare grids need a fresh
      // session generation so the new approval setting takes effect on
      // the next turn.
      if (isCompareMode) {
        handleResetAllChats();
      }
    },
    [handleResetAllChats, isCompareMode, setRequireToolApproval]
  );

  const handleMultiModelSummaryChange = useCallback(
    (summary: MultiModelCardSummary) => {
      setCompareSummaries((previous) => ({
        ...previous,
        // `summary.modelId` is the legacy field name; in multi-host mode
        // (Phase 4) it carries the host's `compareId` — see the card.
        [summary.modelId]: summary,
      }));
    },
    []
  );

  const handleMultiModelHasMessagesChange = useCallback(
    (compareId: string, hasMessages: boolean) => {
      setCompareHasMessages((previous) => ({
        ...previous,
        [compareId]: hasMessages,
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

  const recorderPromptIndexSnapshotRef = useRef<{
    key: string;
    entries: Array<[string, number]>;
  } | null>(null);

  // Tier-3 recorder: map each assistant tool call's toolCallId → the ordinal of
  // the user turn that produced it, so part-switch can attribute a recorded
  // widget step to the right turn in the live (span-less) preview. Streaming
  // text changes `messages` often; keep the snapshot identity stable unless the
  // actual toolCallId → promptIndex mapping changes.
  const recorderPromptIndexSnapshot = useMemo(() => {
    if (!recorder) {
      const previous = recorderPromptIndexSnapshotRef.current;
      if (previous?.key === "") return previous;
      const next = { key: "", entries: [] };
      recorderPromptIndexSnapshotRef.current = next;
      return next;
    }
    const entries: Array<[string, number]> = [];
    let userOrdinal = -1;
    for (const msg of messages) {
      if (msg.role === "user") {
        userOrdinal += 1;
        continue;
      }
      if (msg.role !== "assistant") continue;
      for (const part of msg.parts ?? []) {
        if (!isToolPart(part) && !isDynamicTool(part)) continue;
        const info = getToolInfo(part as never);
        if (info.toolCallId && userOrdinal >= 0) {
          entries.push([info.toolCallId, userOrdinal]);
        }
      }
    }
    const key = JSON.stringify(entries);
    const previous = recorderPromptIndexSnapshotRef.current;
    if (previous?.key === key) return previous;
    const next = { key, entries };
    recorderPromptIndexSnapshotRef.current = next;
    return next;
  }, [recorder, messages]);

  const recorderWithResolver = useMemo<RecorderProps | undefined>(() => {
    if (!recorder) return undefined;
    const toolCallPromptIndex = new Map(recorderPromptIndexSnapshot.entries);
    return {
      ...recorder,
      resolvePromptIndex: (toolCallId: string) =>
        toolCallPromptIndex.get(toolCallId),
    };
  }, [recorder, recorderPromptIndexSnapshot]);

  // Placeholder: Chat tab strings for either compare grid; playground
  // default for true single-pane.
  let placeholder = showPostConnectGuide
    ? MINIMAL_CHAT_COMPOSER_PLACEHOLDER
    : isCompareMode
    ? DEFAULT_CHAT_COMPOSER_PLACEHOLDER
    : "Try a prompt that could call your tools...";
  if (disableChatInput) {
    placeholder = disabledInputPlaceholder;
  }
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = isCompareMode
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

  // Submit handler — shared by the composer form and eval Quick Run.
  const performComposerSubmit = useCallback(async (): Promise<boolean> => {
    const hasContent =
      composer.input.trim() ||
      mcpPromptResults.length > 0 ||
      fileAttachments.length > 0;
    if (!hasContent || sendBlocked) {
      return false;
    }
    if (!(await ensureSelectedServerReadyForChat())) {
      return false;
    }

    if (!isCompareMode && displayMode === "fullscreen" && isWidgetFullscreen) {
      setIsFullscreenChatOpen(true);
    }

    const files =
      fileAttachments.length > 0
        ? await attachmentsToFileUIParts(fileAttachments)
        : undefined;

    if (isCompareMode) {
      queueBroadcastRequest({
        text: composer.input,
        files,
        prependMessages: [],
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
    } else {
      queueBroadcastRequest(
        {
          text: composer.input,
          files,
          prependMessages: [],
        },
        { single_model_send: true }
      );
      sendMessage({
        text: composer.input,
        files,
        metadata: outgoingSenderMetadata,
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
    }

    composer.setInput("");
    setMcpPromptResults([]);
    revokeFileAttachmentUrls(fileAttachments);
    setFileAttachments([]);
    onFirstMessageSent?.();
    return true;
  }, [
    composer,
    mcpPromptResults.length,
    fileAttachments,
    sendBlocked,
    ensureSelectedServerReadyForChat,
    isCompareMode,
    displayMode,
    isWidgetFullscreen,
    queueBroadcastRequest,
    modelContextQueue,
    sendMessage,
    outgoingSenderMetadata,
    onFirstMessageSent,
  ]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await performComposerSubmit();
  };

  // Eval Quick Run: re-run the case in the live preview. Two phases so the send
  // never races the reset's `setMessages`:
  //   1. On a new `runPreviewRequest` nonce, reset the thread and mark a pending
  //      run. (If streaming or not yet bootstrapped, the gate defers — the nonce
  //      is left unconsumed so the effect re-fires when those clear.)
  //   2. Once the reset has flushed (thread empty, not streaming), send the
  //      current case prompt (`initialInput`) fresh — NOT the composer content,
  //      so an empty composer or a just-cleared one still re-runs.
  const lastRunPreviewRequestRef = useRef(0);
  const [quickRunPending, setQuickRunPending] = useState(false);
  useEffect(() => {
    const handoffPending =
      !!evalChatHandoff &&
      appliedEvalChatHandoffIdRef.current !== evalChatHandoff.id;
    if (
      !shouldRunPreview({
        runPreviewRequest,
        alreadyHandledRequest: lastRunPreviewRequestRef.current,
        isSessionBootstrapComplete,
        isStreaming,
        handoffPending,
      })
    ) {
      return;
    }
    lastRunPreviewRequestRef.current = runPreviewRequest!;
    handleResetAllChats();
    setQuickRunPending(true);
  }, [
    runPreviewRequest,
    evalChatHandoff,
    isSessionBootstrapComplete,
    isStreaming,
    handleResetAllChats,
  ]);
  useEffect(() => {
    if (!quickRunPending) return;
    if (!isThreadEmpty || isStreaming) return;
    const text = (initialInput ?? "").trim();
    setQuickRunPending(false);
    if (text) handleSendFollowUp(text);
  }, [
    quickRunPending,
    isThreadEmpty,
    isStreaming,
    initialInput,
    handleSendFollowUp,
  ]);

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
          widgetModelContext: modelContextQueue,
        });
        setModelContextQueue([]);
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
  // "Ask agent to run" (harness built-in tools): the rail builds a structured
  // prompt and requests a send via the bridge; we route it through the SAME
  // single-model send path as the composer (send-if-ready, else leave it in the
  // composer as a draft). No bespoke execution path — it's a normal turn.
  const submitAgentToolPrompt = useCallback(
    async (text: string) => {
      if (composerDisabled || sendBlocked) {
        composer.setInput(text);
        return;
      }
      if (!(await ensureSelectedServerReadyForChat())) {
        composer.setInput(text);
        return;
      }
      if (isCompareMode) {
        queueBroadcastRequest({
          text,
          prependMessages: [],
          widgetModelContext: modelContextQueue,
        });
        setModelContextQueue([]);
      } else {
        queueBroadcastRequest(
          { text, prependMessages: [] },
          { single_model_send: true }
        );
        sendMessage({
          text,
          metadata: outgoingSenderMetadata,
          widgetModelContext: modelContextQueue,
        });
        setModelContextQueue([]);
      }
      onFirstMessageSent?.();
    },
    [
      composer,
      composerDisabled,
      sendBlocked,
      ensureSelectedServerReadyForChat,
      isCompareMode,
      queueBroadcastRequest,
      sendMessage,
      outgoingSenderMetadata,
      modelContextQueue,
      onFirstMessageSent,
    ]
  );

  const pendingAgentToolPrompt = useAgentToolPromptBridge((s) => s.pending);
  const consumeAgentToolPrompt = useAgentToolPromptBridge((s) => s.consume);
  const handledAgentToolNonce = useRef<number | null>(null);
  useEffect(() => {
    const req = pendingAgentToolPrompt;
    if (!req || req.nonce === handledAgentToolNonce.current) return;
    handledAgentToolNonce.current = req.nonce;
    consumeAgentToolPrompt();
    void submitAgentToolPrompt(req.prompt);
  }, [pendingAgentToolPrompt, consumeAgentToolPrompt, submitAgentToolPrompt]);

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
    // Client chip in the chat input toolbar (sibling to the model chip).
    // Replaces the standalone "Compare" button that used to live in the
    // playground header. Shared sessions can't switch hosts, so leave it off.
    clientSelector: isSharedSession
      ? undefined
      : {
          hosts: hostList,
          projectId: multiHostProjectId,
          // Cloud skills are Convex-scoped: use the real Convex project id
          // (null for the synthetic "Default" project), never the UUID fallback
          // baked into `multiHostProjectId`, which 500s the listSkills query.
          cloudProjectId: convexProjectId,
          currentHostId: previewedHostId ?? null,
          selectedHostIds,
          multiHostEnabled,
          onHostChange: (hostId: string) => setPreviewedHostId(hostId),
          onSelectedHostIdsChange: setSelectedHostIds,
          onMultiHostEnabledChange: handleMultiHostEnabledChange,
          onPromoteLead: handlePromoteLead,
          enableMultiHost: canEnableMultiHost,
        },
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
    onDisconnectServer: playgroundServerSelectorProps?.onDisconnect,
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
    // "fill" is the desktop-like default layout — it keeps the overlay
    // composer/chat affordance fullscreen widgets had under "desktop".
    (storeDeviceType === "fill" || storeDeviceType === "desktop") &&
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
                ) : hideWelcomeHero ? null : (
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
                chatSessionId={chatSessionId}
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
                onToolApprovalResponse={addToolApprovalResponse}
                toolRenderOverrides={mergedToolRenderOverrides}
                mcpToolResultImageRendering={
                  effectiveMcpToolResultImageRendering
                }
                showInlineEdit={!hideInlineEdit}
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
                showSenderAvatars={showSenderAvatars}
                resolveSenderAvatar={resolveSenderAvatar}
                recorder={recorderWithResolver}
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
          chatSessionId={chatSessionId}
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
              sendMessage({
                text: composer.input,
                metadata: outgoingSenderMetadata,
                widgetModelContext: modelContextQueue,
              });
              setModelContextQueue([]);
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
    // Surface signal for `MCPAppsRenderer` / `chatgpt-app-renderer`: the
    // `cspMode` they compute on first render must already see
    // "playground" before any descendant subscribes. The legacy
    // `isPlaygroundActive` store flag was set in a passive `useEffect`,
    // which committed on render #2 and flipped `cspMode` mid-session —
    // tearing down the iframe and dropping View state (the
    // "draw a cat, then it vanishes" bug). Context propagates
    // synchronously on the first render, so the fetch-source key is
    // stable from mount #1.
    <WidgetSurfaceProvider value="playground">
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
        {/* Center header strip — hidden during onboarding and embedded eval preview */}
        {!showPostConnectGuide && !hideCenterHeaderChrome && (
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
            leadHostInMultiHost={
              isMultiHostMode ? leadHost?.name ?? null : null
            }
            // The standalone "Compare" host picker moved into the chat-input
            // run pill (see `hostCompare` in `sharedChatInputProps`). Single-host
            // switching still lives in the global `GlobalHostBar`.
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
            <PlaygroundCompareThemeScope
              hostStyle={hostStyle}
              hostCapabilitiesOverride={hostCapabilitiesOverride}
              chatUiOverride={chatUiOverride}
              effectiveThreadTheme={effectiveThreadTheme}
              hostShellStyle={hostShellStyle}
            >
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
                data-testid={
                  isMultiHostMode
                    ? "playground-multi-host-compare-section"
                    : "playground-multi-model-compare-section"
                }
                className={cn(
                  "flex flex-1 min-h-0 flex-col overflow-hidden",
                  !effectiveHasMessages && "hidden"
                )}
                aria-hidden={!effectiveHasMessages}
              >
                <div className="flex min-h-64 flex-1 flex-col overflow-hidden px-4 py-4">
                  {isMultiHostMode ? (
                    // Phase 4 multi-host compare grid. Project-scoped
                    // server config means `selectedServers`,
                    // `hostedSelectedServerIds`, and `hostedOAuthTokens`
                    // are SHARED across all columns — there is no
                    // per-host server set in v1 (see plan §"What v1 does
                    // NOT compare"). Each column gets its own
                    // `hostSnapshot` (style, caps, chat UI, MCP profile)
                    // and its own `hostCapsResolver` so per-server
                    // capability gating evaluates under the right host
                    // identity. Every column shares the lead's model and
                    // the global chip `executionConfig` — host is the only
                    // varying axis. See `multiHostColumns` memo above.
                    <div
                      data-testid="playground-multi-host-grid"
                      className={cn(
                        "grid h-full min-h-0 w-full min-w-0 gap-4 auto-rows-[minmax(0,1fr)] [&>*]:min-h-0",
                        multiHostColumns.length <= 1 && "grid-cols-1",
                        multiHostColumns.length === 2 &&
                          "grid-cols-1 xl:grid-cols-2",
                        multiHostColumns.length >= 3 &&
                          "grid-cols-1 xl:grid-cols-3"
                      )}
                    >
                      {multiHostColumns.map((column) => (
                        <MultiModelPlaygroundCard
                          // Include `compareKind` in the key so a mode
                          // swap between multi-model and multi-host can't
                          // accidentally reuse a card instance keyed by a
                          // hostId that happens to equal a modelId string.
                          key={`${multiModelSessionGeneration}:host:${column.compareId}`}
                          compareId={column.compareId}
                          compareLabel={column.compareLabel}
                          compareKind="host"
                          compareSubLabel={column.compareSubLabel}
                          model={column.model}
                          comparisonSummaries={Object.values(compareSummaries)}
                          selectedServers={selectedServers}
                          broadcastRequest={broadcastRequest}
                          deterministicExecutionRequest={
                            deterministicExecutionRequest
                          }
                          stopRequestId={stopBroadcastRequestId}
                          executionConfig={column.executionConfig}
                          hostedContext={{
                            projectId: convexProjectId,
                            selectedServerIds: hostedSelectedServerIds,
                            oauthTokens: hostedOAuthTokens,
                            hostId: column.compareId,
                          }}
                          hostedOrgModelConfig={hostedOrgModelConfig}
                          displayMode={displayMode}
                          onDisplayModeChange={handleDisplayModeChange}
                          hostStyle={column.hostSnapshot.hostStyle}
                          effectiveThreadTheme={effectiveThreadTheme}
                          deviceType={storeDeviceType}
                          hideInlineEdit={hideInlineEdit}
                          onWidgetStateChange={onWidgetStateChange}
                          toolRenderOverrides={externalToolRenderOverrides}
                          isExecuting={isExecuting}
                          executingToolName={executingToolName}
                          invokingMessage={invokingMessage}
                          onSummaryChange={handleMultiModelSummaryChange}
                          onHasMessagesChange={
                            handleMultiModelHasMessagesChange
                          }
                          // Multi-host mode varies only the host; per-card
                          // model title + Latency/Tokens chrome is redundant
                          // (same model in every column) and noisy. Keep the
                          // Trace/Chat/Raw tab strip — that comes from
                          // `showTraceTabs` inside the header.
                          showComparisonChrome={false}
                          suppressThreadEmptyHint={false}
                          compareEnterVersion={multiCompareEnterVersion}
                          compareEnterMessages={multiCompareEnterMessages}
                          addColumnSeed={
                            compareAddColumnSeeds[column.compareId] ?? null
                          }
                          onTranscriptSync={handleMultiModelTranscriptSync}
                          showSenderAvatars={showSenderAvatars}
                          resolveSenderAvatar={resolveSenderAvatar}
                          outgoingSenderMetadata={outgoingSenderMetadata}
                          hostSnapshot={column.hostSnapshot}
                          hostCapsResolver={column.hostConfig}
                        />
                      ))}
                    </div>
                  ) : (
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
                      {resolvedSelectedModels.map((model) => {
                        const compareId = String(model.id);
                        return (
                          <MultiModelPlaygroundCard
                            // Phase 3: include `compareKind` in the key so
                            // model-mode and host-mode keys never collide
                            // during mode-swap transitions.
                            key={`${multiModelSessionGeneration}:model:${compareId}`}
                            compareId={compareId}
                            compareLabel={model.name}
                            compareKind="model"
                            model={model}
                            comparisonSummaries={Object.values(
                              compareSummaries
                            )}
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
                              progressiveToolDiscovery:
                                previewedHost?.config?.progressiveToolDiscovery,
                              respectToolVisibility:
                                previewedHost?.config?.respectToolVisibility,
                              modelVisibleMcpToolResults:
                                previewedHost?.config
                                  ?.modelVisibleMcpToolResults,
                              mcpToolResultImageRendering:
                                effectiveMcpToolResultImageRendering,
                              builtInToolIds:
                                previewedHost?.config?.builtInToolIds,
                            }}
                            hostedContext={{
                              projectId: convexProjectId,
                              selectedServerIds: hostedSelectedServerIds,
                              oauthTokens: hostedOAuthTokens,
                              ...(previewedHostId
                                ? { hostId: previewedHostId }
                                : {}),
                            }}
                            displayMode={displayMode}
                            onDisplayModeChange={handleDisplayModeChange}
                            hostStyle={hostStyle}
                            effectiveThreadTheme={effectiveThreadTheme}
                            deviceType={storeDeviceType}
                            hideInlineEdit={hideInlineEdit}
                            onWidgetStateChange={onWidgetStateChange}
                            toolRenderOverrides={externalToolRenderOverrides}
                            isExecuting={isExecuting}
                            executingToolName={executingToolName}
                            invokingMessage={invokingMessage}
                            onSummaryChange={handleMultiModelSummaryChange}
                            onHasMessagesChange={
                              handleMultiModelHasMessagesChange
                            }
                            showComparisonChrome={
                              resolvedSelectedModels.length > 1
                            }
                            suppressThreadEmptyHint={false}
                            compareEnterVersion={multiCompareEnterVersion}
                            compareEnterMessages={multiCompareEnterMessages}
                            addColumnSeed={
                              compareAddColumnSeeds[compareId] ?? null
                            }
                            onTranscriptSync={handleMultiModelTranscriptSync}
                            // Model-mode does NOT pass `hostSnapshot`. The
                            // card falls back to tab-root provider values
                            // via `useContext`, so the rendered tree is
                            // behavior-identical to today.
                          />
                        );
                      })}
                    </div>
                  )}
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
            </PlaygroundCompareThemeScope>
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
                          chatSessionId={chatSessionId}
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
                          harnessBuiltinTools={harnessBuiltinTools}
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
    </WidgetSurfaceProvider>
  );
}
