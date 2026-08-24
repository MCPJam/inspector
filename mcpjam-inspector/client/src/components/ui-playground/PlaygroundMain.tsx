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
import { Braces, Loader2, RotateCcw } from "lucide-react";
import {
  ElicitationRequestDialog,
  UrlElicitationRequiredDialog,
} from "@/components/elicitation/ElicitationRequestDialog";
import { HostedMrtrHost } from "@/components/elicitation/HostedMrtrHost";
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
  buildMcpPromptMessages,
  buildSkillToolMessages,
  DEFAULT_CHAT_COMPOSER_PLACEHOLDER,
  MINIMAL_CHAT_COMPOSER_PLACEHOLDER,
  cloneUiMessages,
  extractUserMessageText,
} from "@/components/chat-v2/shared/chat-helpers";
import { SaveAsTestCaseAction } from "@/components/chat-v2/shared/save-as-test-case-action";
import { MultiModelEmptyTraceDiagnosticsPanel } from "@/components/chat-v2/multi-model-empty-trace-diagnostics";
import {
  MultiModelStarterPromptsBlock,
  MultiModelStartersEmptyLayout,
} from "@/components/chat-v2/multi-model-starters-empty";
import { ErrorBox } from "@/components/chat-v2/error";
import { ConfirmChatResetDialog } from "@/components/chat-v2/chat-input/dialogs/confirm-chat-reset-dialog";
import {
  DETACH_FORK_FAILED_MESSAGE,
  type ChatSessionResetReason,
  useChatSession,
} from "@/hooks/use-chat-session";
import {
  RESUMED_THREAD_CONFLICT_MESSAGE,
  RESUMED_THREAD_UNSAVED_MESSAGE,
  useResumedThreadPersistence,
} from "@/hooks/use-resumed-thread-persistence";
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
  getScenarioChatBackground,
  getScenarioHostFamily,
  getScenarioHostLogo,
  getScenarioShellStyle,
  type ScenarioHostStyle,
} from "@/lib/scenario-client-style";
import { DEFAULT_HOST_STYLE, type ChatUiOverride } from "@/lib/client-styles";
import { detectUiTypeFromTool } from "@/lib/mcp-ui/mcp-apps-utils";
import { PRESET_DEVICE_CONFIGS } from "@/components/shared/ClientContextHeader";
import { track } from "@/lib/analytics";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { FullscreenChatOverlay } from "@/components/chat-v2/fullscreen-chat-overlay";
import { useSharedAppState } from "@/state/app-state-context";
import { Settings2 } from "lucide-react";
import { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import { useConvexAuth, useQuery } from "convex/react";
import { useOrgModelsHandoff } from "@/hooks/use-org-models-handoff";
import {
  useHost,
  useHostList,
  useHostMutations,
  type HostListItem,
  type HostDetail,
} from "@/hooks/useClients";
import {
  cloneHostTemplateInput,
  emptyHostConfigInputV2,
  gateMcpToolResultImageRenderingByModelVisibility,
  DEFAULT_SEEDED_HOST_MODEL_ID,
} from "@/lib/client-config-v2";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { getCatalogHost, getCatalogTemplate } from "@mcpjam/sdk/host-compat";
import { usePreviewedHostId } from "@/hooks/use-previewed-client-id";
import { useComputerEngine } from "@/hooks/useComputerEngine";
import { usePlaygroundEnvironment } from "@/hooks/use-playground-environment";
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";
import { PlaygroundEnvironmentSection } from "@/components/playground/PlaygroundEnvironmentSection";
import { useHarnessBuiltinTools } from "@/hooks/useHarnessBuiltinTools";
import { useComputersEnabled } from "@/hooks/useComputersEnabled";
import { useComputerAttachmentUpload } from "@/hooks/useComputerAttachmentUpload";
import {
  buildComputerAttachmentNote,
  isComputerAttachmentUploadActive,
} from "@/lib/computer-attachments";
import {
  getBillingErrorMessage,
  isComputerStartLimitError,
} from "@/lib/billing-entitlements";
import { useMCPJamLimitDialogStore } from "@/stores/mcpjam-limit-dialog-store";
import { useAgentToolPromptBridge } from "@/stores/agent-tool-prompt-bridge";
import { usePersistedHost } from "@/hooks/use-persisted-host";
import { usePlaygroundHostSlots } from "@/hooks/use-playground-host-slots";
import {
  loadSelectedHostIds,
  replaceLeadHostId,
  saveSelectedHostIds,
} from "@/lib/selected-host-storage";
import {
  loadPreviewedHostId,
  savePreviewedHostId,
} from "@/lib/previewed-client-storage";
import { useProjectServers } from "@/hooks/useViews";
import { useServerActionsOptional } from "@/state/server-actions-context";
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
  ScenarioChatUiOverrideProvider,
  ScenarioHostStyleProvider,
  ScenarioHostThemeProvider,
} from "@/contexts/scenario-client-style-context";
import { ScenarioHostCapabilitiesOverrideProvider } from "@/contexts/scenario-client-capabilities-override-context";
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
import {
  usePlaygroundConversationUrl,
  type ConversationRestoreOutcome,
} from "@/components/ui-playground/use-playground-conversation-url";
import { usePlaygroundChatHistoryBridgeStore } from "@/components/playground/playground-chat-history-bridge";
import {
  resolveSelectablePlaygroundModel,
  usePlaygroundAgentControlsBridgeStore,
} from "@/components/playground/playground-agent-controls-bridge";
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

// Backoff for retrying a failed seed. Deleting the per-project "seeded"
// marker only PERMITS a retry — nothing in the seed effect's dependency list
// changes when a create rejects, so without an explicit nudge the effect
// never runs again and the guest sits on an empty playground for the rest of
// the session. Bounded: a backend that's down stays down, and three spaced
// attempts is the difference between "recovers from a blip" and "hammers a
// struggling server".
const PLAYGROUND_SEED_RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

// PUR-11: the 3 catalog templates a first-run guest's Playground compare
// lineup is seeded from, lead first. See the "Seed backstop" effect below.
// Keep every id here flag-free: guests never match a rollout gate, and the
// seed refuses a partial lineup (falling back to one blank host), so a gated
// template like "claude-code" would both leak the gated client to everyone
// and have no working way to be filtered out.
const PLAYGROUND_SEED_TEMPLATE_IDS = ["claude", "chatgpt", "cursor"] as const;

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
  hostStyle: ScenarioHostStyle;
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
    <ScenarioHostStyleProvider value={hostStyle}>
      <ScenarioHostCapabilitiesOverrideProvider
        value={hostCapabilitiesOverride}
      >
        <ScenarioChatUiOverrideProvider value={chatUiOverride}>
          <ScenarioHostThemeProvider value={effectiveThreadTheme}>
            <div
              className={cn(
                "scenario-host-shell app-theme-scope flex h-full min-h-0 flex-col overflow-hidden",
                effectiveThreadTheme === "dark" && "dark"
              )}
              data-testid="playground-compare-shell"
              data-host-style={hostStyle}
              data-thread-theme={effectiveThreadTheme}
              style={hostShellStyle}
            >
              {children}
            </div>
          </ScenarioHostThemeProvider>
        </ScenarioChatUiOverrideProvider>
      </ScenarioHostCapabilitiesOverrideProvider>
    </ScenarioHostStyleProvider>
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
  /** Suppresses the per-user-message edit/branch affordance. */
  hideMessageEdit?: boolean;
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
  /**
   * Mirror the active conversation into `?conversation=<chatSessionId>` and
   * reopen it on load. Opt-in because only the routed Playground owns the URL —
   * the eval preview embeds this same surface in a docked panel, where writing
   * the page's query string would be a side effect on someone else's route.
   */
  syncConversationToUrl?: boolean;
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
  hideMessageEdit = false,
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
  syncConversationToUrl = false,
}: PlaygroundMainProps) {
  const { signUp } = useAuth();
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
  // Model from a restored conversation that the catalog didn't know yet. Kept
  // WITH its session id: the catalog can arrive after the user has moved to a
  // different thread, and applying it then would retag their new thread with
  // the old one's model.
  const pendingRestoredModelRef = useRef<{
    chatSessionId: string;
    modelId: string;
  } | null>(null);
  // Set by `usePlaygroundConversationUrl` below; called from the chat hook's
  // `onReset` above it, which is why this is a ref rather than the callback.
  const clearConversationUrlRef = useRef<() => void>(() => {});
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

  // Resolved Local⇄Cloud engine for this project's personal computer. Passed
  // into useChatSession so a direct turn runs this host's bash on the local
  // machine when the user has selected + consented to "This machine". The
  // config fetch lives here (the surface that uses it), not in the central
  // chat hook. Hosted mode / no local engine ⇒ cloud, and the turn sends
  // nothing extra.
  const playgroundComputerEngine = useComputerEngine(convexProjectId);
  // The resolved engine passed to every chat session on this tab — the root
  // and each comparison column — so "This machine" runs bash consistently
  // across model/host comparison, not just the primary session.
  const personalComputerEngineOption = useMemo(
    () => ({
      engine: playgroundComputerEngine.engine,
      consentToken: playgroundComputerEngine.consent.token,
    }),
    [playgroundComputerEngine.engine, playgroundComputerEngine.consent.token]
  );

  // COMP-14: when the previewed host attaches a personal computer, composer
  // attachments are ALSO uploaded into the sandbox (reserve → mint → upload,
  // the same primitives the Shell uses) and the outgoing message carries a
  // system-visible note with the sandbox paths so the model's bash tool can
  // reach them. Signed-in only — guests keep today's inline-only attachments
  // (the backend rejects guest computer reservations for host-bound previews).
  // The `computer` gate itself lives below, once the previewed host resolves.
  const computersEnabled = useComputersEnabled();
  const computerAttachmentUpload = useComputerAttachmentUpload({
    projectId: convexProjectId,
    isAuthenticated: isConvexAuthenticated,
  });
  const attachmentUploadInFlightRef = useRef(false);
  const projectOrganizationId = activeProject?.organizationId ?? null;
  const hostedOrgModelConfig = useHostedOrgModelConfig({
    projectId: convexProjectId,
    organizationId: projectOrganizationId,
  });
  const manageOrgProviders = useOrgModelsHandoff(projectOrganizationId);
  const { serversById, serversByName } = useProjectServers({
    isAuthenticated: isConvexAuthenticated,
    projectId: convexProjectId,
  });
  // Optional: present app-wide, absent in isolated embeds. Drives the hosted
  // harness preflight (resolve/persist selected server names → Convex ids).
  const playgroundServerActions = useServerActionsOptional();
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
  // Same storage scope as `usePersistedHost` / `usePreviewedHostId` below.
  // Hoisted above `useChatSession` because the environment target has to be in
  // the hosted context before the first transport body is built.
  const multiHostProjectId = convexProjectId ?? activeProjectId ?? null;
  // Project Environments (Phase 2). Flag-gated and fail-closed inside the hook;
  // outside environment mode every field below is inert and the Playground
  // behaves exactly as it does today.
  const playgroundEnvironment = usePlaygroundEnvironment(multiHostProjectId);
  const isEnvironmentMode = playgroundEnvironment.isEnvironmentMode;
  const environmentsEnabled = useProjectEnvironmentsEnabled();
  const { host: previewedHost } = useHost({
    isAuthenticated: isConvexAuthenticated,
    hostId: previewedHostId,
  });
  // A newly selected host is unknown for one render while its config loads.
  // Fail closed in that gap: it may resolve to Codex or Claude Code, whose
  // opaque harness sessions cannot be safely rewound. Ordinary model hosts get
  // editing back as soon as their config resolves.
  const previewedHostConfigUnresolved =
    previewedHostId !== null && previewedHost?.hostId !== previewedHostId;
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
  // `harnessId` is non-null exactly when this chat executes inside a harness
  // runtime (Claude Code, Codex), which is what gates the edit affordance below.
  const { tools: harnessBuiltinTools, harnessId: previewedHarnessId } =
    useHarnessBuiltinTools(previewedHostId);

  // COMP-14 gate: composer attachments go into the sandbox only when the
  // previewed host actually attaches a computer (honesty rule — no computer, no
  // sandbox upload; attachments stay inline-only exactly as before) AND the
  // resolved engine is cloud — the upload targets the CLOUD box, so on "This
  // machine" it would wake a sandbox the local bash tool can't see.
  const computerAttachmentsActive = isComputerAttachmentUploadActive({
    computersEnabled: computersEnabled === true,
    isAuthenticated: isConvexAuthenticated,
    hostHasComputer: !!previewedHost?.config?.computer,
    engine: playgroundComputerEngine.engine,
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
    isSelectedModelResolved,
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
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    mcpToolsTokenCountErrors,
    resetChat,
    startChatWithMessages,
    detachToLocalFork,
    consumePersistReceipt,
    consumeTurnAborted,
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
    rewindToMessage,
    syncResumedVersion,
    resumedVersion,
    restoredToolRenderOverrides,
    status,
    authHeaders,
    pendingElicitations,
    respondToElicitation,
    elicitationResponding,
    urlElicitationRequired,
    dismissUrlElicitationRequired,
  } = useChatSession({
    selectedServers,
    directVisibility: pendingDirectVisibility,
    hostedOrgModelConfig,
    hostedContext: {
      projectId: convexProjectId,
      selectedServerIds: hostedSelectedServerIds,
      oauthTokens: hostedOAuthTokens,
      // ENVIRONMENT MODE (Phase 2) and host mode are mutually exclusive on the
      // wire — `normalizeExecutionTarget` 400s a body carrying both pointers.
      ...(isEnvironmentMode
        ? {
            executionTarget: playgroundEnvironment.executionTarget,
            // Only present when the user explicitly overrode the server set.
            ...(playgroundEnvironment.environmentOverrides
              ? {
                  environmentOverrides:
                    playgroundEnvironment.environmentOverrides,
                }
              : {}),
            // The environment's servers resolve by Convex id server-side (and
            // some are plugin-contributed, i.e. invisible to the browser's
            // catalog), so the turn MUST go through /api/web/chat-v2 — the local
            // /api/mcp engine cannot connect them and rejects the target
            // outright.
            requiresWebChatApi: true,
            // Deliberately NO `ensureServerIds`: resolving environment servers
            // by NAME would fail for plugin-contributed ones and bypass plugin
            // lifecycle semantics for the rest.
            //
            // NOT a second execution pointer — a client-side cache key. The
            // environment's host is already the previewed host (presentation
            // only), and host-keyed client caches (the harness workdir the
            // Shell opens a terminal in) are read by that id, so the write side
            // has to know it. The server still resolves the host from the
            // environment.
            ...(previewedHostId ? { presentationHostId: previewedHostId } : {}),
          }
        : {
            // Resolve/persist selected server names → Convex ids before a hosted
            // harness send (ad-hoc/App servers included), so the proxy never
            // sees a display name. Absent in isolated embeds → falls back to the
            // pre-resolved selection above.
            ...(playgroundServerActions?.ensureHostedServerIdsForNames
              ? {
                  ensureServerIds:
                    playgroundServerActions.ensureHostedServerIdsForNames,
                }
              : {}),
            // Forward the previewed host id so the server re-resolves its
            // authoritative runtime config (harness/computer) for this direct
            // session, and so switching hosts forks the chat session.
            ...(previewedHostId ? { hostId: previewedHostId } : {}),
          }),
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
    // execution-context helper, so this also flows through scenario sessions
    // (where the persisted host config wins via the runtime-config fetch).
    builtInToolIds: previewedHost?.config?.builtInToolIds,
    personalComputerEngine: personalComputerEngineOption,
    onReset: (reason?: ChatSessionResetReason) => {
      setModelContextQueue([]);
      setPreludeTraceExecutions([]);
      setInjectedToolRenderOverrides({});
      if (reason === "servers-changed") {
        return;
      }
      // Only an explicit New Chat drops the conversation from the URL. The
      // other reasons that empty the transcript — `auth-bootstrap` above all —
      // are re-mints of the SAME conversation, and clearing on those would
      // strip the id right before the restore effect goes looking for it.
      if (reason === "reset") {
        pendingRestoredModelRef.current = null;
        clearConversationUrlRef.current();
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
  const hostStyleFamily = getScenarioHostFamily(hostStyle) ?? "claude";
  const hostBackgroundColor =
    getScenarioChatBackground(hostStyle, effectiveThreadTheme) ??
    DEFAULT_HOST_STYLE.chatUi.resolveChatBackground(effectiveThreadTheme);
  const hostShellStyle = getScenarioShellStyle(
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
  // `!isEnvironmentMode`: like multi-HOST below, model comparison is mutually
  // exclusive with environment mode in v1. Each comparison card runs its own
  // request against `hostId`, so leaving it enabled would silently execute the
  // cards against the host instead of the environment. Withdrawing the
  // affordance also drives the "reset a stale persisted multiModelEnabled"
  // effect below, so it cannot be re-enabled behind the environment's back.
  const canEnableMultiModel =
    enableMultiModelChat &&
    availableModels.length > 1 &&
    !isSharedSession &&
    !isEnvironmentMode;

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
  const {
    selectedHostIds,
    setSelectedHostIds,
    multiHostEnabled,
    setMultiHostEnabled,
  } = usePersistedHost(multiHostProjectId);

  // Environment mode ⇒ single host, always.
  //
  //  1. Multi-host comparison is switched OFF. Comparison runs one turn against
  //     several hosts; an environment names exactly one, so the two states
  //     cannot both be true without one of them lying about what ran.
  //  2. The environment's host becomes the PREVIEWED host — for PRESENTATION
  //     only (model chip, harness built-ins, host chrome). It is not sent as a
  //     `hostId` on the wire; `executionTarget` is the single statement about
  //     what executes, and the server re-resolves this host from the
  //     environment itself.
  const environmentHostId = playgroundEnvironment.preview?.host.hostId ?? null;
  useEffect(() => {
    if (!isEnvironmentMode) return;
    if (multiHostEnabled) setMultiHostEnabled(false);
    if (environmentHostId && previewedHostId !== environmentHostId) {
      setPreviewedHostId(environmentHostId);
    }
  }, [
    isEnvironmentMode,
    environmentHostId,
    multiHostEnabled,
    setMultiHostEnabled,
    previewedHostId,
    setPreviewedHostId,
  ]);

  const { hosts: hostList, isLoading: hostListLoading } = useHostList({
    isAuthenticated: isConvexAuthenticated,
    projectId: multiHostProjectId,
  });
  const { createHost: createPlaygroundHost, deleteHost: deletePlaygroundHost } =
    useHostMutations();
  const seedCatalogState = useHostCatalog();
  const seedThemeMode = usePreferencesStore((s) => s.themeMode);
  // Mirrors `multiHostProjectId` so the seed effect's async continuation
  // (below) can detect a navigate-away while its mutations were in flight —
  // without this, a slow seed could apply project A's freshly-created host
  // ids/lead to whatever project the user has since switched to. A layout
  // effect (not a passive one) so the ref is current before any already-
  // in-flight promise continuation's microtask can observe it — a passive
  // effect can still be pending when a `.then()` callback runs in the same
  // tick as the commit that changed `multiHostProjectId`.
  const activeMultiHostProjectIdRef = useRef(multiHostProjectId);
  useLayoutEffect(() => {
    activeMultiHostProjectIdRef.current = multiHostProjectId;
  }, [multiHostProjectId]);
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
  // Seed backstop: the global host bar (which normally auto-creates a single
  // default "MCPJam" host for empty projects) is hidden on the playground, so
  // this replicates that one-shot seed — but with the immediate client-
  // comparison value prop (PUR-11): guests land with 3 pre-selected clients
  // (ChatGPT, Claude, Cursor) instead of one blank host + a toggle they'd
  // have to find and flip themselves. Guarded by `hostList.length === 0` + a
  // per-project ref so it fires at most once per empty project and never
  // blocks a different empty project from getting its own default hosts.
  const playgroundSeededProjectIdsRef = useRef(new Set<string>());
  // While the three first-run hosts are being created, a subscription can
  // surface ChatGPT before Claude. Do not let the generic missing-preview
  // fallback turn that timing artifact into the selected default; the seed
  // writes Claude as the lead after all three creates succeed.
  const playgroundSeedingProjectIdsRef = useRef(new Set<string>());
  // Retry plumbing for the two failure paths below (single-host create
  // rejected / 3-host seed rolled back). Both clear the project's "seeded"
  // marker, which permits a retry but cannot cause one — this tick is what
  // actually re-runs the effect. Attempts are counted per project so one
  // project exhausting its budget doesn't spend another's.
  const seedRetryCountsRef = useRef(new Map<string, number>());
  const seedRetryTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [seedRetryTick, setSeedRetryTick] = useState(0);
  // A seed completion only mutates a ref. This tick lets the missing-preview
  // fallback run again when a user changed the compare lineup mid-seed and
  // the seed correctly declined to overwrite that choice.
  const [seedCompletionTick, setSeedCompletionTick] = useState(0);
  useEffect(() => {
    const timers = seedRetryTimersRef.current;
    return () => {
      // Unmounting drops the retry: a pending timer would setState on a dead
      // component, and a remount re-runs the seed effect from scratch anyway.
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);
  const schedulePlaygroundSeedRetry = useCallback((projectId: string) => {
    const attempt = seedRetryCountsRef.current.get(projectId) ?? 0;
    const delay = PLAYGROUND_SEED_RETRY_DELAYS_MS[attempt];
    // Budget exhausted — stop retrying. The guest can still recover with a
    // reload, which re-fetches the catalog and resets this state entirely.
    if (delay === undefined) return;
    seedRetryCountsRef.current.set(projectId, attempt + 1);
    const timer = setTimeout(() => {
      seedRetryTimersRef.current.delete(timer);
      setSeedRetryTick((tick) => tick + 1);
    }, delay);
    seedRetryTimersRef.current.add(timer);
  }, []);
  useEffect(() => {
    if (
      !isConvexAuthenticated ||
      hostListLoading ||
      !multiHostProjectId ||
      hostList.length > 0 ||
      playgroundSeededProjectIdsRef.current.has(multiHostProjectId) ||
      seedCatalogState.status === "loading"
    ) {
      return;
    }
    const seedProjectId = multiHostProjectId;
    // A degraded catalog is NOT a transient gap worth waiting out:
    // `useHostCatalog` fetches once per page load and memoizes the result for
    // the rest of the session, so "fallback"/"error" never upgrade to "live"
    // without a full reload. The playground hides the global host bar, so this
    // effect is the only thing between a guest and a project with zero
    // clients — every resolved status therefore has to produce something:
    //   - "fallback" (the server served its bundled catalog): that catalog
    //     carries all 3 seed templates, so the full lineup still lands. Treated
    //     exactly like "live".
    //   - "error" (no catalog at all), or a catalog somehow missing a seed
    //     template: nothing to clone from, so fall back to the pre-PUR-11
    //     backstop — one blank "MCPJam" host, no compare lineup. Worse than the
    //     3-client default, far better than an empty playground the guest has
    //     no way to recover from.
    const catalog =
      seedCatalogState.status === "error" ? null : seedCatalogState.catalog;
    const seeds = catalog
      ? PLAYGROUND_SEED_TEMPLATE_IDS.map((id) => ({
          id,
          host: getCatalogHost(catalog, id),
          template: getCatalogTemplate(catalog, id),
        }))
      : [];
    // Never seed a partial (e.g. 2-client) lineup: it is neither the intended
    // default nor the known-good single-host backstop.
    const canSeedFullLineup =
      seeds.length > 0 && seeds.every(({ host, template }) => host && template);
    if (!canSeedFullLineup) {
      // Same mid-seed snapshot discipline as the 3-host path below — see the
      // long comment there for why the lead and the lineup are tracked
      // separately, and why the snapshot (not a bare `length > 0` on the
      // final value) is what distinguishes a real user choice from a stale
      // array left behind by deleted hosts.
      const preFallbackSelectedHostIds = loadSelectedHostIds(seedProjectId);
      const preFallbackPreviewedHostId = loadPreviewedHostId(seedProjectId);
      playgroundSeededProjectIdsRef.current.add(seedProjectId);
      createPlaygroundHost({
        projectId: seedProjectId,
        name: "MCPJam",
        // Pin a cheap default model — see HostOverlayBar's seed for why a
        // modelless default host breaks synthetic/swarm runs.
        input: emptyHostConfigInputV2({
          modelId: DEFAULT_SEEDED_HOST_MODEL_ID,
        }),
      })
        .then(({ hostId }) => {
          // As in the 3-host path: a lead now pointing at the host THIS
          // fallback just created is our own "no valid previewed host"
          // effect auto-picking it once the host list caught up, not a user
          // choice — it must not veto the lineup write below.
          const currentPreviewedHostId = loadPreviewedHostId(seedProjectId);
          const leadIsSeededHost = currentPreviewedHostId === hostId;
          const currentSelectedHostIds = loadSelectedHostIds(seedProjectId);
          const selectionChangedMidSeed =
            (!leadIsSeededHost &&
              currentPreviewedHostId !== preFallbackPreviewedHostId) ||
            currentSelectedHostIds.length !==
              preFallbackSelectedHostIds.length ||
            currentSelectedHostIds.some(
              (id, index) => id !== preFallbackSelectedHostIds[index]
            );
          if (selectionChangedMidSeed) return;
          // Persisted to the project it belongs to (not just React state) for
          // the same navigate-away reason as the 3-host path below.
          savePreviewedHostId(seedProjectId, hostId);
          // The lineup is overwritten, not left alone, because "no compare"
          // is not the same as "don't touch": a project reseeded after its
          // hosts were deleted still has those dead ids in storage, and
          // `usePersistedHost` PRESERVES the stored column count at read time
          // (it replaces slot 0 with the lead rather than shrinking), so they
          // would come back as a 3-column compare lineup wrapped around one
          // real host — `isComparingHosts` reads `selectedHostIds.length > 1`
          // and would happily switch on. Writing `[hostId]` collapses it.
          saveSelectedHostIds(seedProjectId, [hostId]);
          if (activeMultiHostProjectIdRef.current === seedProjectId) {
            setPreviewedHostId(hostId);
            setSelectedHostIds([hostId]);
          }
        })
        .catch(() => {
          playgroundSeededProjectIdsRef.current.delete(seedProjectId);
          schedulePlaygroundSeedRetry(seedProjectId);
        });
      return;
    }
    // Snapshot the persisted lineup as it stood the moment we decided to
    // seed, so the completion below can tell "nothing touched this since
    // we started" (safe to apply the seed) from "something changed while
    // we were creating hosts" (respect whatever's there now instead of
    // overwriting it) — regardless of whether the snapshot itself was
    // empty (a genuinely fresh project) or already non-empty (e.g. a
    // reseed after the project's prior hosts were deleted, leaving a
    // stale-but-present array — a bare `length > 0` check on the FINAL
    // value alone can't distinguish that from a real manual selection
    // made mid-seed, and would wrongly skip applying the new lineup).
    //
    // The lead is snapshotted separately from the array because it moves
    // separately: the global host bar switches the previewed client through
    // `savePreviewedHostId` alone, without touching the compare lineup, so a
    // guard that watched only the array would still let the seed overwrite a
    // client the user picked there mid-seed.
    const preSeedSelectedHostIds = loadSelectedHostIds(seedProjectId);
    const preSeedPreviewedHostId = loadPreviewedHostId(seedProjectId);
    playgroundSeededProjectIdsRef.current.add(seedProjectId);
    playgroundSeedingProjectIdsRef.current.add(seedProjectId);
    Promise.allSettled(
      seeds.map(({ host, template }) =>
        createPlaygroundHost({
          projectId: seedProjectId,
          name: host!.label,
          input: cloneHostTemplateInput(template, {
            themeMode: seedThemeMode,
          }),
        })
      )
    )
      .then(async (results) => {
        const fulfilled = results.filter(
          (
            result
          ): result is PromiseFulfilledResult<
            Awaited<ReturnType<typeof createPlaygroundHost>>
          > => result.status === "fulfilled"
        );
        if (fulfilled.length < results.length) {
          // Partial failure: a half-seeded project (1-2 hosts, no compare) is
          // worse than an empty one that can cleanly retry — roll back
          // whichever calls DID succeed. Only clear the "seeded" marker (and
          // schedule the retry that actually re-runs this effect) if every
          // rollback delete succeeded; if one fails, the partial hosts are
          // stuck either way, and retrying would just hammer the same
          // struggling backend with the other two creates too.
          const rollback = await Promise.allSettled(
            fulfilled.map((result) =>
              deletePlaygroundHost({ hostId: result.value.hostId })
            )
          );
          if (rollback.every((result) => result.status === "fulfilled")) {
            playgroundSeededProjectIdsRef.current.delete(seedProjectId);
            schedulePlaygroundSeedRetry(seedProjectId);
          }
          return;
        }
        const hostIds = fulfilled.map((result) => result.value.hostId);
        // The user may have already picked something for this project since
        // the seed started — e.g. manually added/selected a host via "Add
        // client", or switched the previewed client in the global host bar,
        // while these mutations were still in flight. The seed is a first-run
        // default, not an authoritative overwrite: if either the lineup or the
        // lead has changed since the snapshots above (whether those snapshots
        // were empty or already stale-non-empty), leave both alone rather than
        // clobbering a choice the user has already made. Both are checked
        // because the seed writes both, and the two move independently — the
        // global host bar moves the lead through `savePreviewedHostId` alone
        // and never touches the lineup.
        //
        // One lead move is NOT a user choice, though: the "no valid previewed
        // host" fallback effect below auto-picks a lead as soon as the host-
        // list query catches up to the FIRST of these creates, which routinely
        // lands while the other two are still in flight. That is our own
        // write, so a lead now pointing at a host THIS seed just created must
        // not veto the lineup — vetoing would strand the guest with 3 hosts
        // and no compare lineup, the exact half-seeded state this backstop
        // exists to prevent. Whichever seed host holds the lead is kept as
        // lead (so a user who did pick one of them in the host bar keeps it),
        // and the full 3-way lineup lands either way.
        const currentPreviewedHostId = loadPreviewedHostId(seedProjectId);
        const leadIsSeededHost =
          currentPreviewedHostId !== null &&
          hostIds.includes(currentPreviewedHostId);
        const currentSelectedHostIds = loadSelectedHostIds(seedProjectId);
        const selectionChangedMidSeed =
          (!leadIsSeededHost &&
            currentPreviewedHostId !== preSeedPreviewedHostId) ||
          currentSelectedHostIds.length !== preSeedSelectedHostIds.length ||
          currentSelectedHostIds.some(
            (id, index) => id !== preSeedSelectedHostIds[index]
          );
        if (selectionChangedMidSeed) return;
        const leadHostId = leadIsSeededHost
          ? currentPreviewedHostId
          : hostIds[0];
        // Persist directly to `seedProjectId`'s OWN storage — bypassing the
        // current React state setters, which are scoped to whatever project
        // is ACTIVE right now — so a seed that resolves after the user has
        // navigated away still lands correctly for the project it belongs to,
        // rather than being dropped or misapplied to whatever's open when
        // this resolves. `usePersistedHost`/`usePreviewedHostId` re-read from
        // storage whenever their `projectId` changes, so returning to
        // `seedProjectId` later picks this up. Lead is set explicitly
        // alongside the array since a bare array write can't promote a lead
        // when `previewedHostId` is still null (brand-new project).
        savePreviewedHostId(seedProjectId, leadHostId);
        saveSelectedHostIds(seedProjectId, hostIds);
        if (activeMultiHostProjectIdRef.current === seedProjectId) {
          // Still on the seeded project — also reflect it in live React state
          // so the lead/lineup update immediately instead of waiting for a
          // remount. Not touching `multiHostEnabled` here: nothing renders
          // off it anymore (see `isComparingHosts` above `isMultiHostMode`,
          // and the multi-model mutual-exclusion check below reads
          // `selectedHostIds.length` directly for the same reason) — setting
          // it would just get silently reverted by the "!canEnableMultiHost
          // -> disable" effect before the host-list query catches up anyway.
          setPreviewedHostId(leadHostId);
          setSelectedHostIds(hostIds);
        }
      })
      .finally(() => {
        playgroundSeedingProjectIdsRef.current.delete(seedProjectId);
        setSeedCompletionTick((tick) => tick + 1);
      });
  }, [
    isConvexAuthenticated,
    hostListLoading,
    multiHostProjectId,
    hostList.length,
    createPlaygroundHost,
    deletePlaygroundHost,
    setPreviewedHostId,
    setSelectedHostIds,
    seedCatalogState,
    seedThemeMode,
    schedulePlaygroundSeedRetry,
    // Re-runs the effect after a failed attempt cleared the project's marker;
    // nothing else in this list changes when a create rejects.
    seedRetryTick,
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
    if (playgroundSeedingProjectIdsRef.current.has(multiHostProjectId)) {
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
    seedCompletionTick,
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
  // `!isEnvironmentMode`: comparison and environment mode are mutually
  // exclusive in v1 (see the effect above). Withdrawing the affordance also
  // drives the existing "reset a stale persisted multiHostEnabled" effect
  // below, so the two can't be re-enabled behind the environment's back.
  const canEnableMultiHost =
    hostList.length > 1 && !isSharedSession && !isEnvironmentMode;

  // The "is the user actually comparing right now" signal for render-
  // gating and mutual-exclusion, computed fresh every render from
  // `selectedHostIds` (reliably persisted — see the seed effect above and
  // `usePersistedHost`) rather than trusted from the separately-persisted
  // `multiHostEnabled` flag. Removing the "Multiple clients" toggle
  // (PUR-11) means there's no longer any legitimate way to have 2+ hosts
  // checked with comparison intentionally off, so `multiHostEnabled` no
  // longer needs to be an imperatively-synchronized source of truth for
  // this — which matters because keeping a stateful flag in sync across
  // async seeding, Convex host-list catch-up lag, and navigate-away/back
  // is exactly the kind of thing that's easy to get subtly wrong (an
  // earlier version of this seed tracked "pending enable" per project in
  // a ref, which worked for the common case but could still strand a
  // project in single-pane if the user navigated away and back before its
  // host list caught up, since the ref doesn't survive a remount).
  // Deriving this fresh from already-correct persisted data has no state
  // to fall out of sync in the first place, including across a remount.
  const isComparingHosts = canEnableMultiHost && selectedHostIds.length > 1;

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
  // on the single session). When `isComparingHosts` is true but the lead
  // host or its model isn't resolved yet (loading, deleted, missing from
  // `availableModels`), fall through to single-pane — don't render a
  // degraded grid where the lead identity is wrong.
  // Multi-host compare requires at least 2 resolved columns. Without
  // this guard a stale persisted `selectedHostIds` paired with a single
  // selected host (or only the lead resolving) would render the compare
  // grid as a one-column variant of single-pane — visually confusing and
  // routed through the compare submit/stop/state path unnecessarily.
  const isMultiHostMode =
    isComparingHosts &&
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
  // Project Environments (Phase 2). Selecting an environment activates the new
  // `executionTarget` synchronously, but the things that must agree with it do
  // not land in the same tick: the chat scope re-keys on the new target, and
  // the environment's host only becomes the previewed host once the preview
  // resolves. A turn submitted inside that window carries the NEW environment
  // id with the PREVIOUS host's model, system prompt and approval setting, and
  // the scope reset that follows can drop the in-flight message. Block SENDS
  // (not typing) until the transition has settled.
  //
  // `isPreviewLoading` is load-bearing separately from `isResolutionPending`
  // and the host comparison, and covers the case neither can see: a live EDIT
  // of the SELECTED environment. That refetch deliberately KEEPS the previous
  // body on screen (live-config semantics), so mid-flight `preview` is the
  // STALE one — `isResolutionPending` is false because a preview exists, and
  // `environmentHostId` still reads the OLD host, which the previewed host
  // already matches. If the edit repointed the environment at a different
  // host, every clause would read "settled" while the next turn resolves
  // server-side against the new host.
  const isEnvironmentTargetPending =
    isEnvironmentMode &&
    (playgroundEnvironment.isResolutionPending ||
      playgroundEnvironment.isPreviewLoading ||
      !isSessionBootstrapComplete ||
      (!!environmentHostId && previewedHostId !== environmentHostId));
  const { composerDisabled, sendBlocked } = getChatComposerInteractivity({
    isStreamingActive: isStreamingActive || isPreparingServerForSend,
    composerDisabled:
      disableChatInput || submitBlocked || isPreparingServerForSend,
    submitDisabled:
      disableChatInput ||
      submitBlocked ||
      composer.submitGatedByServer ||
      isPreparingServerForSend ||
      isEnvironmentTargetPending,
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
    // Mirrors the gate in ChatTabV2's copy of this effect. Both branches below
    // end in `setSelectedModelIds`, which persists the lead model id
    // (`use-persisted-model.ts:150-159`) under a key every chat surface reads
    // back. While the persisted selection has not resolved against
    // `availableModels` — the window where an org-managed provider config is
    // still in flight — `selectedModel` is only a derived fallback, and
    // writing it destroys the user's own-provider pick. See BACK2-628.
    if (!isSelectedModelResolved) {
      return;
    }

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
    isSelectedModelResolved,
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

      // The eval preview is an ephemeral sandbox: its own Quick Run / replay
      // mutates the session (e.g. a replayed "Add to cart" click fires a tool
      // call), so a "changed elsewhere" alarm there is self-inflicted noise. The
      // detach still happens; we just skip the user-facing toast.
      const notify = (message: string) => {
        if (!opts?.silent) {
          toast.error(message);
        }
      };

      // Gated on the ROOT transcript, which is what gets forked below —
      // `effectiveHasMessages` is compare-aware and reads the columns in
      // compare layout, so the two can disagree. The dangerous direction is a
      // root that holds messages while the columns do not: the fork would be
      // skipped and the guard dropped on a transcript that can still be written
      // back to the old row. (The old code gated on the compare-aware value.)
      if (isThreadEmpty) {
        // Nothing to fork — with no transcript there is no snapshot that could
        // be written back over the old row, so dropping the guard is enough.
        syncResumedVersion(null);
        notify(toastMessage);
        return;
      }

      // Verified rather than fire-and-forget: the reassuring toast may only be
      // shown once the fork is confirmed live. `resumedVersion` is cleared by
      // the fork's own hydration, so it survives a fork that never commits.
      void detachToLocalFork(cloneUiMessages(messagesRef.current), {
        toolRenderOverrides: restoredToolRenderOverrides,
      })
        .then((fork) => {
          notify(fork ? toastMessage : DETACH_FORK_FAILED_MESSAGE);
        })
        .catch((error) => {
          // `void` silences the linter, not the rejection. Routed through
          // `notify` so the eval preview's suppression still applies.
          console.error(
            "[PlaygroundMain] Failed to fork the detached thread",
            error
          );
          notify(DETACH_FORK_FAILED_MESSAGE);
        });
    },
    [
      cancelPendingHistorySelection,
      isThreadEmpty,
      restoredToolRenderOverrides,
      detachToLocalFork,
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
          // Anything else — a network blip, a 5xx — is RETHROWN rather than
          // flattened to null, matching ChatTabV2's twin of this helper. `null`
          // is the caller's signal that the thread is gone, and callers act on
          // it by detaching; collapsing a transient failure into that signal
          // would tear users off perfectly valid conversations during a brief
          // history-API outage. Every caller already distinguishes the two: the
          // pre-send sync reports the error and refuses the send, the
          // share/unshare handler logs and leaves the thread alone, and the
          // post-stream rail refresh catches and ignores.
          throw error;
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
  /**
   * Sync the resumed thread's cursor before a send, so the turn carries a
   * current `expectedVersion` rather than one that went stale while the user
   * sat idle. ChatTabV2 has always done this; the Playground had no pre-send
   * sync at all, which mattered little while hosted turns ignored
   * `expectedVersion` and matters now that they honor it — a stale baseline
   * becomes a real 409 and a forced new thread.
   *
   * Returns false when the send must not proceed: the sync failed (the user is
   * told, and a blind send could clobber another writer), or the thread is gone
   * and the surface has detached from it.
   */
  const ensureThreadReadyForSend = useCallback(async () => {
    if (!activeHistorySessionId) return true;

    let detail: Awaited<ReturnType<typeof refreshCurrentHistorySession>> = null;
    try {
      detail = await refreshCurrentHistorySession();
    } catch (error) {
      console.error(
        "[PlaygroundMain] Failed to sync chat history before send",
        error
      );
      toast.error("Failed to sync chat history. Try again.");
      return false;
    }
    if (detail) return true;

    detachHistorySession(
      "This chat is no longer available. Your draft stayed local, and the next send will start a new thread."
    );
    return false;
  }, [
    activeHistorySessionId,
    detachHistorySession,
    refreshCurrentHistorySession,
  ]);

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

  // Reopen the conversation named in the URL. Same machinery as picking the
  // thread from the rail (`handleSelectThread`), minus the discard-draft
  // confirm — this only ever runs against an empty transcript.
  const restoreConversationFromUrl = useCallback(
    async (conversationId: string): Promise<ConversationRestoreOutcome> => {
      const selectionRequestId = historySelectionRequestIdRef.current + 1;
      historySelectionRequestIdRef.current = selectionRequestId;
      // Same as picking the thread from the rail: the restored transcript
      // lives on the single chat session, so the compare grid must stand down
      // rather than render over it.
      setViewingHistoryReplay(true);
      let restored = false;

      try {
        const detail = await getCachedChatHistoryDetail({
          chatSessionId: conversationId,
          projectId: convexProjectId ?? undefined,
        });

        if (historySelectionRequestIdRef.current !== selectionRequestId) {
          return "failed";
        }

        await loadHistorySession(detail.session, detail.widgetSnapshots, {
          turnTraces: detail.turnTraces,
          shouldApply: () =>
            historySelectionRequestIdRef.current === selectionRequestId,
        });

        if (historySelectionRequestIdRef.current !== selectionRequestId) {
          return "failed";
        }
        restoreHistoryServerSelection(
          detail.session.resumeConfig?.selectedServers
        );
        // `loadHistorySession` skips the model when the catalog hasn't loaded
        // yet; remember it so the effect below can apply it on arrival.
        pendingRestoredModelRef.current = detail.session.modelId
          ? {
              chatSessionId: detail.session.chatSessionId,
              modelId: detail.session.modelId,
            }
          : null;
        restored = true;
        return "restored";
      } catch (error) {
        // 404: deleted, archived away, or never existed. 403: someone else's.
        // Either way this id will never restore — say so, so the caller drops
        // it from the URL instead of retrying on every scope change.
        if (
          error instanceof WebApiError &&
          (error.status === 403 || error.status === 404)
        ) {
          if (error.status === 403) {
            toast.error("You no longer have access to that chat.");
          }
          return "unavailable";
        }
        console.error(
          "[PlaygroundMain] Failed to restore conversation from URL",
          error
        );
        return "failed";
      } finally {
        // Nothing restored means nothing to replay — release the compare
        // suppression so the user's own layout isn't stuck off.
        if (
          !restored &&
          historySelectionRequestIdRef.current === selectionRequestId
        ) {
          setViewingHistoryReplay(false);
        }
      }
    },
    [convexProjectId, loadHistorySession, restoreHistoryServerSelection]
  );

  const { isRestoringConversation, clearConversation } =
    usePlaygroundConversationUrl({
      enabled: syncConversationToUrl,
      chatSessionId,
      hasMessages: !isThreadEmpty,
      isSessionBootstrapComplete,
      isStreaming,
      projectId: convexProjectId,
      isMultiModelLayoutMode,
      isEvalHandoffPending:
        !!evalChatHandoff &&
        appliedEvalChatHandoffIdRef.current !== evalChatHandoff.id,
      activeHistorySessionId,
      restoreConversation: restoreConversationFromUrl,
    });
  clearConversationUrlRef.current = clearConversation;

  // The model catalog can arrive after the transcript. Apply the restored
  // model once — and only while the restored conversation is still the one on
  // screen, so a thread the user opened in the meantime keeps its own model.
  useEffect(() => {
    const pending = pendingRestoredModelRef.current;
    if (!pending) return;
    if (pending.chatSessionId !== chatSessionId) {
      pendingRestoredModelRef.current = null;
      return;
    }
    const matchingModel = availableModels.find(
      (model) => String(model.id) === pending.modelId
    );
    if (!matchingModel) return;
    pendingRestoredModelRef.current = null;
    if (String(selectedModel?.id ?? "") === pending.modelId) return;
    setSelectedModel(matchingModel);
  }, [availableModels, chatSessionId, selectedModel, setSelectedModel]);

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

  useResumedThreadPersistence({
    sendBaselineRef: resumedThreadSendBaselineRef,
    enabled: true,
    status,
    activeHistorySessionId,
    resumedVersion,
    consumePersistReceipt,
    consumeTurnAborted,
    reactiveSessionVersion: reactiveHistorySession?.version,
    syncResumedVersion,
    markHistorySessionRead: (sessionId) => {
      void markHistorySessionRead(sessionId);
    },
    refreshAfterStream: () => {
      void refreshCurrentHistorySession({ markRead: true }).catch((error) => {
        console.error("[PlaygroundMain] Failed to refresh chat history", error);
      });
    },
    onConflict: () => {
      detachHistorySession(RESUMED_THREAD_CONFLICT_MESSAGE, {
        silent: suppressHistoryConflictToastRef.current,
      });
    },
    onUnsaved: () => {
      // The eval preview mutates its own session by design, so its
      // self-inflicted noise stays suppressed here too.
      if (!suppressHistoryConflictToastRef.current) {
        toast.error(RESUMED_THREAD_UNSAVED_MESSAGE);
      }
    },
  });

  // Delay the spinner so a hover-prefetched (instant) load doesn't flash an
  // overlay for one frame. After ~120 ms the load is "slow enough" to warrant
  // visible feedback.
  const [showLoadingOverlay, setShowLoadingOverlay] = useState(false);
  useEffect(() => {
    // A URL restore is the same "fetching a transcript" wait, and it happens on
    // a cold load — without it the user stares at an empty composer until the
    // messages land.
    if (!loadingHistorySessionId && !isRestoringConversation) {
      setShowLoadingOverlay(false);
      return;
    }
    const timerId = window.setTimeout(() => setShowLoadingOverlay(true), 120);
    return () => window.clearTimeout(timerId);
  }, [isRestoringConversation, loadingHistorySessionId]);

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
        // Every send entry point takes the same thread preflight, not just the
        // composer: a resumed session that moved between subscription updates
        // would otherwise send with a stale `expectedVersion`, and now that the
        // hosted route honors it, the turn runs in full and only THEN takes a
        // 409 and a conflict detach. A no-op when no history thread is open.
        if (!(await ensureThreadReadyForSend())) {
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
      ensureThreadReadyForSend,
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
    // Clearing empties the transcript and mints a fresh `chatSessionId`, so the
    // next turn persists to a NEW history row. Keeping the previously-opened
    // thread attached would leave the post-stream reconciliation above checking
    // a baseline this session can never advance — the turn lands elsewhere, the
    // old row's version never moves, and the user gets a false "This chat
    // changed elsewhere" detach toast on a chat they just cleared. Same detach
    // `handleNewChat` does, since a cleared thread IS a new one.
    resumedThreadSendBaselineRef.current = null;
    cancelPendingHistorySelection();
    syncResumedVersion(null);
    setPendingDirectVisibility("private");
    resetChat();
    clearLogs();
    setInjectedToolRenderOverrides({});
    setPreludeTraceExecutions([]);
    resetMultiModelSessions();
    setViewingHistoryReplay(false);
  }, [
    cancelPendingHistorySelection,
    clearLogs,
    composer,
    resetChat,
    resetMultiModelSessions,
    syncResumedVersion,
  ]);

  const handleClearChat = useCallback(() => {
    handleResetAllChats();
    setShowClearConfirm(false);
  }, [handleResetAllChats]);

  const handleSingleModelChange = useCallback(
    (model: ModelDefinition, options?: { userInitiated?: boolean }) => {
      setSelectedModel(model, options);
      setSelectedModelIds([String(model.id)]);
      setMultiModelEnabled(false);
    },
    [setMultiModelEnabled, setSelectedModel, setSelectedModelIds]
  );

  // Publish the chat composer's controls so the global playground agent tools
  // (ui_select_model / ui_set_system_prompt / ui_reset_chat /
  // ui_stop_generation), whose handlers live in the sibling `usePlaygroundState`
  // subtree, can drive this session. Mirrors the chat-history bridge above:
  // replace whole on any dependency change, clear to null on unmount. Only
  // redacted state crosses (model id/name, prompt presence+length, a bounded
  // history count + last role) — never message text or the prompt itself. The
  // actions reuse the exact functions the composer controls call.
  const setAgentControls = usePlaygroundAgentControlsBridgeStore(
    (s) => s.setControls
  );
  useEffect(() => {
    const lastMessage =
      messages.length > 0 ? messages[messages.length - 1] : null;
    setAgentControls({
      selectedModel: selectedModel
        ? { id: String(selectedModel.id), name: selectedModel.name }
        : null,
      systemPrompt: {
        present: systemPrompt.trim().length > 0,
        length: systemPrompt.length,
      },
      history: {
        messageCount: messages.length,
        lastRole: lastMessage ? (lastMessage.role as string) : null,
      },
      // Multi-model-aware streaming flag, matching the composer's stop control.
      isGenerating: isStreamingActive,
      selectModel: (identifier) => {
        // Resolves the identifier AND enforces the picker's availability policy
        // (disabled rows rejected), so the agent can't select a locked model.
        const resolution = resolveSelectablePlaygroundModel(
          identifier,
          availableModels
        );
        if (!resolution.ok) return resolution;
        const { model } = resolution;
        handleSingleModelChange(model);
        return { ok: true, model: { id: String(model.id), name: model.name } };
      },
      setSystemPrompt: (prompt) => setSystemPrompt(prompt),
      resetChat: () => handleResetAllChats(),
      stopGeneration: () => {
        if (!isStreamingActive) return { stopped: false };
        stopActiveChat();
        return { stopped: true };
      },
    });
    return () => setAgentControls(null);
  }, [
    availableModels,
    handleResetAllChats,
    handleSingleModelChange,
    isStreamingActive,
    messages,
    selectedModel,
    setAgentControls,
    setSystemPrompt,
    stopActiveChat,
    systemPrompt,
  ]);

  const handleSelectedModelsChange = useCallback(
    (models: ModelDefinition[]) => {
      const nextSelectedModels = models.slice(0, 3);
      const leadModel = nextSelectedModels[0] ?? selectedModel;

      if (leadModel) {
        // Straight from the multi-model menu, so the lead counts as a pick.
        setSelectedModel(leadModel, { userInitiated: true });
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
      // Checked against `selectedHostIds.length` directly, NOT
      // `isComparingHosts` (which also requires `canEnableMultiHost`, a
      // transient signal that lags behind the Convex host-list query) and
      // NOT the separately-persisted `multiHostEnabled` flag. The lineup
      // itself is the durable signal of user intent — if `canEnableMultiHost`
      // happened to be momentarily false when the user enabled multi-model,
      // gating on `isComparingHosts` would skip clearing the lineup, and
      // once the host list caught up afterward `isMultiHostMode` would win
      // over the multi-model the user just turned on, undoing their action
      // with no visible cause.
      if (enabled && selectedHostIds.length > 1) {
        setMultiHostEnabled(false);
        setSelectedHostIds([]);
      }
    },
    [
      setMultiModelEnabled,
      selectedHostIds.length,
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

  const trackSendMessage = useCallback(
    (captureProps?: Record<string, unknown>) => {
      track("app_builder_send_message", {
        location: "app_builder_tab",
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
        multi_model_enabled: isMultiModelMode,
        multi_model_count: isMultiModelMode ? resolvedSelectedModels.length : 1,
        ...(captureProps ?? {}),
      });
    },
    [
      isMultiModelMode,
      resolvedSelectedModels.length,
      selectedModel?.id,
      selectedModel?.name,
      selectedModel?.provider,
    ]
  );

  // Compare mode ONLY. `broadcastRequest` has no consumer in single-model
  // mode, but freshly mounted compare cards replay whatever request is stored
  // here — so a single-model send that wrote this state would be re-sent to
  // every column when the user later enables compare. Single-model paths call
  // `trackSendMessage` directly instead.
  const queueBroadcastRequest = useCallback(
    (
      request: Omit<BroadcastChatTurnRequest, "id">,
      captureProps?: Record<string, unknown>
    ) => {
      trackSendMessage(captureProps);
      setBroadcastRequest({
        ...request,
        id: Date.now(),
      });
    },
    [trackSendMessage]
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
    track("sign_up_button_clicked", {
      location: "app_builder_tab",
    });
    signUp();
  };

  // A turn's content is text OR anything explicitly attached to it: an
  // expanded MCP prompt, a skill, a file. Text-only would disable Send on a
  // composer that visibly holds an attached skill.
  const composerHasContent =
    composer.input.trim().length > 0 ||
    mcpPromptResults.length > 0 ||
    skillResults.length > 0 ||
    fileAttachments.length > 0;

  // Submit handler — shared by the composer form and eval Quick Run.
  const performComposerSubmit = useCallback(async (): Promise<boolean> => {
    if (!composerHasContent || sendBlocked) {
      return false;
    }
    if (!(await ensureSelectedServerReadyForChat())) {
      return false;
    }
    if (!(await ensureThreadReadyForSend())) {
      return false;
    }

    if (!isCompareMode && displayMode === "fullscreen" && isWidgetFullscreen) {
      setIsFullscreenChatOpen(true);
    }

    // COMP-14: computer-attached host → land the attachments in the sandbox
    // (via the existing reserve → mint → upload path; the upload route enforces
    // the COMP-8 quota) and append a system-visible note with the sandbox paths
    // so the model can reference them. A failed upload ABORTS the send with the
    // composer state intact — an honest error beats a message whose files
    // silently never reached the box. Inline file parts are unchanged (vision
    // et al. keep working).
    let composerText = composer.input;
    if (fileAttachments.length > 0 && computerAttachmentsActive) {
      if (attachmentUploadInFlightRef.current) {
        return false;
      }
      attachmentUploadInFlightRef.current = true;
      try {
        const entries = await computerAttachmentUpload.uploadAttachments(
          fileAttachments.map((a) => a.file)
        );
        const note = buildComputerAttachmentNote(entries);
        if (note) {
          composerText =
            composerText.trim().length > 0
              ? `${composerText}\n\n${note}`
              : note;
        }
        track("computer_chat_attachment_uploaded", {
          file_count: entries.length,
        });
      } catch (err) {
        if (isComputerStartLimitError(err)) {
          track("computer_start_limit_hit", {
            location: "playground_attachments",
          });
          useMCPJamLimitDialogStore.getState().notifyLimitHit();
        } else {
          toast.error(
            getBillingErrorMessage(
              err,
              "Could not upload attachments to the computer."
            )
          );
        }
        return false;
      } finally {
        attachmentUploadInFlightRef.current = false;
      }
    }

    const files =
      fileAttachments.length > 0
        ? await attachmentsToFileUIParts(fileAttachments)
        : undefined;

    // EXPLICIT injection (INS-4): a prompt the user expanded and a skill they
    // attached are turn CONTENT, not context the model has to go fetch. The
    // Playground was building neither, so an explicitly attached skill was
    // silently dropped — a skill-only send left the composer and produced an
    // empty turn. Same construction as ChatTabV2; the helpers own the shapes.
    const promptMessages = buildMcpPromptMessages(
      mcpPromptResults
    ) as UIMessage[];
    const skillMessages = buildSkillToolMessages(skillResults) as UIMessage[];
    const prependMessages = [...promptMessages, ...skillMessages];

    if (isCompareMode) {
      // Each card prepends the same messages to its own thread.
      queueBroadcastRequest({
        text: composerText,
        files,
        prependMessages,
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
    } else {
      trackSendMessage({ single_model_send: true });
      // Single-model mode has no broadcast consumer, so the prepends have to
      // land in the thread here — before `sendMessage`, so the request carries
      // them as history rather than arriving after the model answered.
      if (prependMessages.length > 0) {
        setMessages((prev) => [...prev, ...prependMessages]);
      }
      sendMessage({
        text: composerText,
        files,
        metadata: outgoingSenderMetadata,
        widgetModelContext: modelContextQueue,
      });
      setModelContextQueue([]);
    }

    composer.setInput("");
    setMcpPromptResults([]);
    setSkillResults([]);
    revokeFileAttachmentUrls(fileAttachments);
    setFileAttachments([]);
    onFirstMessageSent?.();
    return true;
  }, [
    composer,
    composerHasContent,
    mcpPromptResults,
    skillResults,
    fileAttachments,
    sendBlocked,
    ensureSelectedServerReadyForChat,
    ensureThreadReadyForSend,
    isCompareMode,
    displayMode,
    isWidgetFullscreen,
    queueBroadcastRequest,
    trackSendMessage,
    modelContextQueue,
    sendMessage,
    setMessages,
    outgoingSenderMetadata,
    onFirstMessageSent,
    computerAttachmentsActive,
    computerAttachmentUpload,
  ]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await performComposerSubmit();
  };

  // Rewind to a past user message and re-run the turn from edited text. The
  // thread BRANCHES — `rewindToMessage` seeds a fresh session with the prefix,
  // so the original transcript survives in history.
  //
  // Server readiness is checked BEFORE the branch is minted: a branch that
  // never sends would leave an empty orphan thread behind.
  const handleEditUserMessage = useCallback(
    async (message: UIMessage, text: string) => {
      if (sendBlocked) return false;
      // Same fire-and-forget exposure as the rewind below, and it lands FIRST:
      // `ensureSelectedServerReadyForChat` wraps `ensureServersReady` in
      // try/FINALLY with no catch, so a rejected connect propagates straight
      // out of this handler. `UserMessageRow.submitEdit` does not await it, so
      // that surfaces as an unhandled rejection with the editor already closed.
      let serverReady: boolean;
      try {
        serverReady = await ensureSelectedServerReadyForChat();
      } catch (error) {
        console.error(
          "[PlaygroundMain] Failed to prepare the server for an edit",
          error
        );
        toast.error("Couldn't prepare the server for that edit. Try again.");
        return false;
      }
      if (!serverReady) return false;
      // Editing revises the prompt text; the original attachments ride along.
      const files = (message.parts ?? []).filter(
        (part): part is Extract<UIMessage["parts"][number], { type: "file" }> =>
          part.type === "file"
      );
      // `rewindToMessage` guards its own send, but the branch mint ahead of it
      // (`startChatWithMessages`) can still reject. `UserMessageRow.submitEdit`
      // invokes this handler fire-and-forget, so a rejection escapes as an
      // unhandled one and the user is left on a closed editor with no turn and
      // no explanation. Refusal (`null`) stays silent; a throw does not.
      let outcome: Awaited<ReturnType<typeof rewindToMessage>>;
      try {
        outcome = await rewindToMessage({
          messageId: message.id,
          text,
          files: files.length > 0 ? files : undefined,
          metadata: outgoingSenderMetadata,
          // Detach from the resumed thread as the branch is minted, not before
          // the rewind. The teardown has to precede the branch's turn — the
          // post-stream conflict check captures its baseline the instant that
          // turn starts, and still attached it would name the ORIGINAL thread,
          // surfacing the deliberate branch as a phantom "this chat changed
          // elsewhere" and re-forking into a third session. But running it up
          // front meant a refusal left the original stripped of its concurrency
          // guard (next ordinary send overwrote its row blind) and stripped of
          // its `?conversation=` id for good, since `clearConversation` masks
          // the param it cleared. `onBeforeBranch` fires only once the rewind is
          // past every refusal that leaves the thread untouched.
          //
          // `cancelPendingHistorySelection` is load-bearing beyond the
          // baseline: it clears `activeHistorySessionId`, which is what stops
          // the reactive history effect from reloading the ORIGINAL transcript
          // over the branch. The conversation has to leave the URL with it —
          // that clearing removes one of the two guards holding the restore
          // effect back, and the other (`hasMessages`) falls too whenever the
          // FIRST message is the one being edited, because the prefix before it
          // is empty. With both down and `?conversation=` still naming the
          // ORIGINAL, the restore refetched the original and reloaded it over
          // the branch. `onReset("fork")` deliberately will not do this — an
          // auth-bootstrap re-mint is the SAME conversation and must keep its
          // id — so a branch says so here, the way New Chat does through
          // `onReset("reset")`.
          onBeforeBranch: () => {
            resumedThreadSendBaselineRef.current = null;
            cancelPendingHistorySelection();
            syncResumedVersion(null);
            pendingRestoredModelRef.current = null;
            clearConversationUrlRef.current();
          },
        });
      } catch (error) {
        console.error("[PlaygroundMain] Failed to rewind to message", error);
        toast.error("Couldn't apply that edit. Try again.");
        return false;
      }
      // `null` means the rewind was refused — nothing branched, so say nothing.
      if (!outcome) return false;
      track("edit_message", {
        location: "playground",
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });
      // Nothing is announced. A rewind forks the session so the original
      // transcript survives in the database, but that is deliberately invisible
      // — same as Claude Code and Codex, where editing a message just edits it.
      // This used to raise a "New branch created" toast with an "Open original"
      // action; both were removed on the task author's call.
      return true;
    },
    [
      sendBlocked,
      ensureSelectedServerReadyForChat,
      cancelPendingHistorySelection,
      syncResumedVersion,
      rewindToMessage,
      outgoingSenderMetadata,
      selectedModel,
    ]
  );

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

  // Starter chips render in both empty states (compare grid and single-model
  // hero), so route by mode like `submitAgentToolPrompt`: compare mode feeds
  // the broadcast queue, single mode must call `sendMessage` itself — there is
  // no broadcast consumer in single-model mode.
  const handleStarterPrompt = useCallback(
    (prompt: string) => {
      track("chat_starter_prompt_clicked", {
        prompt,
        location: isCompareMode ? "playground_compare" : "playground_single",
      });
      if (composerDisabled || sendBlocked) {
        composer.setInput(prompt);
        return;
      }
      void (async () => {
        if (!(await ensureSelectedServerReadyForChat())) {
          composer.setInput(prompt);
          return;
        }
        if (!(await ensureThreadReadyForSend())) {
          composer.setInput(prompt);
          return;
        }
        if (isCompareMode) {
          queueBroadcastRequest({
            text: prompt,
            prependMessages: [],
            widgetModelContext: modelContextQueue,
          });
        } else {
          trackSendMessage({ single_model_send: true });
          sendMessage({
            text: prompt,
            metadata: outgoingSenderMetadata,
            widgetModelContext: modelContextQueue,
          });
        }
        setModelContextQueue([]);
        composer.setInput("");
        // Starter sends are text-only: staged prompt/skill results are
        // discarded like the typed draft and file attachments, so they don't
        // silently ride along on the next composer submit.
        setMcpPromptResults([]);
        setSkillResults([]);
        revokeFileAttachmentUrls(fileAttachments);
        setFileAttachments([]);
        onFirstMessageSent?.();
      })();
    },
    [
      composer,
      composerDisabled,
      ensureSelectedServerReadyForChat,
      ensureThreadReadyForSend,
      fileAttachments,
      isCompareMode,
      modelContextQueue,
      onFirstMessageSent,
      outgoingSenderMetadata,
      queueBroadcastRequest,
      sendBlocked,
      sendMessage,
      trackSendMessage,
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
      if (!(await ensureThreadReadyForSend())) {
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
        trackSendMessage({ single_model_send: true });
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
      ensureThreadReadyForSend,
      isCompareMode,
      queueBroadcastRequest,
      trackSendMessage,
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
      isPreparingServerForSend ||
      // Same environment-transition gate as `sharedChatInputProps` above.
      isEnvironmentTargetPending,
    tokenUsage,
    selectedServers,
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    mcpToolsTokenCountErrors,
    connectedOrConnectingServerConfigs: Object.fromEntries(
      selectedServers.map((name) => [name, { name }])
    ),
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
    // ENVIRONMENT MODE swaps the "+" menu's server section wholesale: the
    // backend connects the environment's servers on every turn, so the
    // browser-connection rows (Connect/Retry, Add server) would all be dead
    // controls against the wrong system. The rows shown instead come from the
    // preview and their toggle is the SAME per-turn narrowing override as the
    // header chips (`setServerEnabled`), so the two surfaces cannot disagree.
    ...(isEnvironmentMode
      ? {
          environmentServers: playgroundEnvironment.servers,
          onEnvironmentServerToggle: playgroundEnvironment.setServerEnabled,
          environmentServersOverridden:
            playgroundEnvironment.hasExplicitOverride,
          onResetEnvironmentServers:
            playgroundEnvironment.resetServersToEnvironment,
        }
      : {
          allServerConfigs: playgroundServerSelectorProps?.serverConfigs,
          onServerToggle: handlePlaygroundServerToggle,
          onReconnectServer: playgroundServerSelectorProps?.onReconnect,
          onDisconnectServer: playgroundServerSelectorProps?.onDisconnect,
          onAddServer: playgroundServerSelectorProps?.onConnect,
        }),
    voiceInputContext: convexProjectId
      ? {
          projectId: convexProjectId,
          ...(hostedSelectedServerIds.length > 0
            ? { selectedServerIds: hostedSelectedServerIds }
            : {}),
        }
      : undefined,
    voiceInputAuthHeaders: authHeaders,
    onManageOrgProviders: manageOrgProviders,
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
                    <MultiModelStarterPromptsBlock
                      onStarterPrompt={handleStarterPrompt}
                    />
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
                // Also gated on `isConvexAuthenticated`, not just compare mode
                // and the evals panel's opt-out. Editing seeds a fresh session
                // with the prefix and leaves the original behind, and the whole
                // justification for that is the original SURVIVING — persisted
                // under its own row, which is what the task author asked for
                // ("if a user decides to rewind messages we shouldn't delete
                // them, from our db"). Signed out there is no row and no
                // persistence: every path needs a bearer token (the reactive
                // Convex query in `use-chat-history.ts`, and the REST fallback
                // whose endpoint `assertBearerToken`s in
                // `server/routes/web/chat-history.ts`). A rewind there is a
                // purely destructive truncation — exactly what this feature
                // exists to replace.
                //
                // NOTE: this gate was originally justified by "signed out there
                // is no way back to the original". That reason no longer
                // separates the two cases — the way back (the branch notice and
                // its "Open original" action) was removed for everyone. The gate
                // now rests only on persistence, which is a narrower but still
                // sufficient reason. Worth a second look if the retention
                // requirement ever changes.
                //
                // Keyed on auth rather than `HOSTED_MODE` or a project id: a
                // signed-in desktop user persists through the same API, and a
                // signed-in user with no project still gets personal history.
                // Withheld on harness hosts (Claude Code, Codex). Those
                // runtimes keep the conversation on their own side, filed under
                // the chat session id, and we send only the newest user message
                // — `@ai-sdk/harness` exposes resume-this-exact-session and
                // nothing else: no fork, no rewind, and the resume payload is
                // opaque so the discarded tail cannot be trimmed out of it. A
                // branch is a NEW session id, so there is no state to resume
                // and the harness would answer the edited message with no
                // memory of the conversation at all, while the persisted
                // transcript still shows the full history — a stored turn that
                // misrepresents what the model was given. Until the harness
                // turn path flattens the copied prefix into the first prompt,
                // withholding is the honest option.
                onEditUserMessage={
                  isCompareMode ||
                  hideMessageEdit ||
                  !isConvexAuthenticated ||
                  previewedHostConfigUnresolved ||
                  previewedHarnessId
                    ? undefined
                    : handleEditUserMessage
                }
                editDisabled={sendBlocked}
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
          canSend={!sendBlocked && composerHasContent}
          isThinking={isStreamingActive}
          onStop={stopActiveChat}
          // Same submit path as the docked composer. Its own copy dropped
          // attached prompts/skills (it sent raw text and then cleared the
          // prompt results), so an explicit attachment vanished from a
          // fullscreen widget session.
          onSend={() => {
            void performComposerSubmit();
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
            // Project Environments (Phase 2.5). The header's leading slot is the
            // Playground's only always-rendered chrome row, so the Environments
            // section lives here rather than beside the run pill's client chip
            // (which is a popover and would hide the resolved bundle behind a
            // click). Flag-gated, fail-closed.
            leading={
              environmentsEnabled && !isSharedSession ? (
                <PlaygroundEnvironmentSection
                  projectId={multiHostProjectId}
                  environment={playgroundEnvironment}
                  // Switching environments forks the chat scope and exits
                  // comparison mode. Doing that mid-turn would strand the
                  // in-flight request — its results vanish from the UI and the
                  // Stop control goes with them. Same gate the chat-input
                  // client selector uses.
                  disabled={isStreamingActive || isPreparingServerForSend}
                />
              ) : null
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
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowClearConfirm(true)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Clear chat
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent
                    variant="muted"
                    sideOffset={6}
                    collisionPadding={12}
                  >
                    <p className="font-medium">Clear chat</p>
                    <p className="text-xs font-light text-muted-foreground">
                      Clears this conversation and starts fresh ·{" "}
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
                  onStarterPrompt={handleStarterPrompt}
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
                          personalComputerEngine={personalComputerEngineOption}
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
                          // `showTraceTabs` inside the header. Show the host
                          // identity row so columns are immediately branded.
                          showComparisonChrome={false}
                          showIdentityHeader
                          logoSrc={getScenarioHostLogo(
                            column.hostSnapshot.hostStyle,
                            column.hostSnapshot.chatUiOverride,
                            effectiveThreadTheme
                          )}
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
                            personalComputerEngine={
                              personalComputerEngineOption
                            }
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
                <ScenarioHostStyleProvider value={hostStyle}>
                  <ScenarioHostCapabilitiesOverrideProvider
                    value={hostCapabilitiesOverride}
                  >
                    <ScenarioHostThemeProvider value={effectiveThreadTheme}>
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
                    </ScenarioHostThemeProvider>
                  </ScenarioHostCapabilitiesOverrideProvider>
                </ScenarioHostStyleProvider>
              )}

              {/* Device frame container */}
              <div
                className="flex h-full items-center justify-center min-h-0 overflow-auto"
                style={
                  showLiveTraceDiagnostics ? { display: "none" } : undefined
                }
              >
                <ScenarioHostStyleProvider value={hostStyle}>
                  <ScenarioHostCapabilitiesOverrideProvider
                    value={hostCapabilitiesOverride}
                  >
                    <ScenarioHostThemeProvider value={effectiveThreadTheme}>
                      <div
                        className={cn(
                          "scenario-host-shell app-theme-scope relative flex flex-col overflow-hidden",
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
                    </ScenarioHostThemeProvider>
                  </ScenarioHostCapabilitiesOverrideProvider>
                </ScenarioHostStyleProvider>
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
      {/*
        Playground had no elicitation UI at all — a server that asked for input
        here would block until the request timed out with no way to answer.
      */}
      <ElicitationRequestDialog
        key={pendingElicitations[0]?.rendezvousId ?? "none"}
        request={pendingElicitations[0] ?? null}
        onRespond={respondToElicitation}
        loading={elicitationResponding}
      />
      <UrlElicitationRequiredDialog
        key={urlElicitationRequired[0]?.toolCallId ?? "no-url-required"}
        event={urlElicitationRequired[0] ?? null}
        onDismiss={dismissUrlElicitationRequired}
      />
      {/* Hosted MRTR (§12.5): a suspended `input_required` round. Durable, so
          it outlives its turn — answering it re-drives the chat turn. */}
      <HostedMrtrHost />
    </WidgetSurfaceProvider>
  );
}
