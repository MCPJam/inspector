/**
 * useChatSession
 *
 * Shared hook that encapsulates common chat infrastructure:
 * - Auth header management
 * - Model selection and persistence
 * - Ollama detection
 * - Transport creation
 * - useChat wrapper
 * - Token usage calculation
 *
 * Used by both ChatTabV2 (multi-server) and PlaygroundMain (single-server).
 */

import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  useLayoutEffect,
} from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  convertToModelMessages,
  DefaultChatTransport,
  generateId,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  type ModelMessage,
} from "ai";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ModelDefinition, isGPT5Model } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { usePersistedModel } from "@/hooks/use-persisted-model";
import {
  buildAvailableModels,
  getDefaultModel,
} from "@/components/chat-v2/shared/model-helpers";
import { isMCPJamProvidedModel } from "@/shared/types";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import { DEFAULT_SYSTEM_PROMPT } from "@/components/chat-v2/shared/chat-helpers";
import { getToolsMetadata, ToolServerMap } from "@/lib/apis/mcp-tools-api";
import { countTextTokens } from "@/lib/apis/mcp-tokenizer-api";
import {
  authFetch,
  getAuthHeaders as getSessionAuthHeaders,
} from "@/lib/session-token";
import { getGuestBearerToken } from "@/lib/guest-session";
import { HOSTED_MODE } from "@/lib/config";
import { transcriptToUIMessages } from "@/lib/transcript-to-ui-messages";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import {
  snapshotsToTraceWidgetSnapshots,
  buildToolRenderOverridesFromSnapshots,
} from "@/components/evals/trace-viewer-adapter";
import { GUEST_ALLOWED_MODEL_IDS, isGuestAllowedModel } from "@/shared/types";
import { useSharedChatWidgetCapture } from "@/hooks/useSharedChatWidgetCapture";
import { buildHostedServerRequest } from "@/lib/apis/web/context";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import {
  getTraceSpansDurationMs,
  mergeLiveChatTraceUsage,
  rebaseTraceSpans,
  type LiveChatTraceEnvelope,
  type LiveChatTraceEvent,
  type LiveChatTraceToolCall,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import {
  applyPreviewSpansUserMessageIndices,
  buildLiveChatPreviewSpans,
  pickTranscriptForLiveTracePreview,
} from "@/shared/live-chat-trace-preview";

export interface UseChatSessionOptions {
  /** Server names to connect to */
  selectedServers: string[];
  /** Active Convex workspace ID when running in hosted mode */
  hostedWorkspaceId?: string | null;
  /** Hosted server IDs mapped from selected server names */
  hostedSelectedServerIds?: string[];
  /** OAuth tokens for hosted servers keyed by server ID */
  hostedOAuthTokens?: Record<string, string>;
  /** Optional server-share token for hosted shared chat sessions */
  hostedShareToken?: string;
  /** Optional sandbox token for hosted sandbox chat sessions */
  hostedSandboxToken?: string;
  /** Surface classification for hosted sandbox chat sessions */
  hostedSandboxSurface?: "preview" | "share_link";
  /** Minimal UI mode for shared chat (hides diagnostics surfaces only) */
  minimalMode?: boolean;
  /** Fixed initial model for hosted sandbox sessions */
  initialModelId?: string;
  /** Initial system prompt (defaults to DEFAULT_SYSTEM_PROMPT) */
  initialSystemPrompt?: string;
  /** Initial temperature (defaults to 0.7) */
  initialTemperature?: number;
  /** Initial tool approval mode for hosted sandbox sessions */
  initialRequireToolApproval?: boolean;
  /** Callback when chat is reset */
  onReset?: () => void;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UseChatSessionReturn {
  // Chat state
  messages: UIMessage[];
  setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>;
  sendMessage: (options: {
    text: string;
    files?: Array<{
      type: "file";
      mediaType: string;
      filename?: string;
      url: string;
    }>;
  }) => void;
  stop: () => void;
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  chatSessionId: string;

  // Model state
  selectedModel: ModelDefinition;
  setSelectedModel: (model: ModelDefinition) => void;
  selectedModelIds: string[];
  setSelectedModelIds: (modelIds: string[]) => void;
  multiModelEnabled: boolean;
  setMultiModelEnabled: (enabled: boolean) => void;
  availableModels: ModelDefinition[];
  isMcpJamModel: boolean;

  // Auth state
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  authHeaders: Record<string, string> | undefined;
  isAuthReady: boolean;
  isSessionBootstrapComplete: boolean;

  // Config
  systemPrompt: string;
  setSystemPrompt: (prompt: string) => void;
  temperature: number;
  setTemperature: (temp: number) => void;

  // Tools metadata
  toolsMetadata: Record<string, Record<string, unknown>>;
  toolServerMap: ToolServerMap;

  // Token counts
  tokenUsage: TokenUsage;
  mcpToolsTokenCount: Record<string, number> | null;
  mcpToolsTokenCountLoading: boolean;
  systemPromptTokenCount: number | null;
  systemPromptTokenCountLoading: boolean;

  // Tool approval
  requireToolApproval: boolean;
  setRequireToolApproval: (value: boolean) => void;
  addToolApprovalResponse: (options: {
    id: string;
    approved: boolean;
    reason?: string;
  }) => void;

  // Actions
  resetChat: () => void;
  startChatWithMessages: (messages: UIMessage[]) => void;
  loadChatSession: (session: {
    chatSessionId: string;
    messagesBlobUrl: string | null;
    resumeConfig?: {
      systemPrompt?: string;
      temperature?: number;
      requireToolApproval?: boolean;
      selectedServers?: string[];
      draftInput?: string;
    };
    version: number;
    widgetSnapshots?: Array<{
      toolCallId: string;
      toolName: string;
      serverId: string;
      uiType: "mcp-apps" | "openai-apps";
      resourceUri?: string;
      widgetCsp: Record<string, unknown> | null;
      widgetPermissions: Record<string, unknown> | null;
      widgetPermissive: boolean;
      prefersBorder: boolean;
      widgetHtmlUrl?: string | null;
    }>;
  }) => Promise<void>;
  syncResumedVersion: (version: number | null) => void;

  // Resumed thread version (for optimistic concurrency)
  resumedVersion: number | null;

  // Restored widget render overrides from loaded session
  restoredToolRenderOverrides: Record<string, ToolRenderOverride>;

  // Live trace state
  liveTraceEnvelope: LiveChatTraceEnvelope | null;
  hasTraceSnapshot: boolean;
  /** True when Timeline can show recorded and/or preview waterfall rows. */
  hasLiveTimelineContent: boolean;
  traceViewsSupported: boolean;

  // Computed state for UI
  isStreaming: boolean;
  disableForAuthentication: boolean;
  submitBlocked: boolean;
  inputDisabled: boolean;
}

interface LiveTraceTurnState {
  turnId: string;
  promptIndex: number;
  spans: EvalTraceSpan[];
  usage?: LiveChatTraceUsage;
  actualToolCalls: LiveChatTraceToolCall[];
  /** From `turn_start.startedAtMs` — anchors wall-clock times in TraceTimeline. */
  startedAtMs?: number;
}

interface LiveTraceAccumulatorState {
  turnOrder: string[];
  turns: Record<string, LiveTraceTurnState>;
  messages: ModelMessage[];
  events: LiveChatTraceEvent[];
  activeTurnId: string | null;
  activeTurnHasSnapshot: boolean;
  anySnapshotSeen: boolean;
}

interface PendingSessionHydration {
  sessionId: string;
  messages: UIMessage[];
  resumedVersion: number | null;
  toolRenderOverrides?: Record<string, import("@/components/chat-v2/thread/tool-render-overrides").ToolRenderOverride>;
  resolve?: () => void;
}

const MAX_LIVE_TRACE_EVENTS = 400;

function createEmptyLiveTraceState(): LiveTraceAccumulatorState {
  return {
    turnOrder: [],
    turns: {},
    messages: [],
    events: [],
    activeTurnId: null,
    activeTurnHasSnapshot: false,
    anySnapshotSeen: false,
  };
}

function isTraceEventDataPart(
  value: unknown,
): value is { type: "data-trace-event"; data: LiveChatTraceEvent } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const part = value as { type?: unknown; data?: unknown };
  return part.type === "data-trace-event" && !!part.data;
}

function dedupeTraceToolCalls(
  toolCalls: LiveChatTraceToolCall[] | null | undefined,
): LiveChatTraceToolCall[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  const deduped: LiveChatTraceToolCall[] = [];
  const seen = new Set<string>();

  for (const toolCall of toolCalls) {
    const serializedArguments = (() => {
      try {
        return JSON.stringify(toolCall.arguments ?? {});
      } catch {
        return String(toolCall.toolCallId ?? toolCall.toolName);
      }
    })();
    const dedupeKey =
      toolCall.toolCallId ??
      `${toolCall.toolName}:${toolCall.serverId ?? ""}:${serializedArguments}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(toolCall);
  }

  return deduped;
}

function applyLiveTraceEvent(
  state: LiveTraceAccumulatorState,
  event: LiveChatTraceEvent,
): LiveTraceAccumulatorState {
  const nextEvents = [...state.events, event];
  const baseState: LiveTraceAccumulatorState = {
    ...state,
    events:
      nextEvents.length > MAX_LIVE_TRACE_EVENTS
        ? nextEvents.slice(-MAX_LIVE_TRACE_EVENTS)
        : nextEvents,
  };

  const ensureTurnState = (
    turnId: string,
    promptIndex: number,
  ): LiveTraceTurnState =>
    baseState.turns[turnId] ?? {
      turnId,
      promptIndex,
      spans: [],
      actualToolCalls: [],
    };

  switch (event.type) {
    case "turn_start": {
      const turnExists = baseState.turnOrder.includes(event.turnId);
      const prev = baseState.turns[event.turnId];
      return {
        ...baseState,
        turnOrder: turnExists
          ? baseState.turnOrder
          : [...baseState.turnOrder, event.turnId],
        turns: {
          ...baseState.turns,
          [event.turnId]: {
            turnId: event.turnId,
            promptIndex: event.promptIndex,
            spans: prev?.spans ?? [],
            actualToolCalls: prev?.actualToolCalls ?? [],
            usage: prev?.usage,
            startedAtMs: event.startedAtMs,
          },
        },
        activeTurnId: event.turnId,
        activeTurnHasSnapshot: false,
      };
    }
    case "trace_snapshot": {
      const turnState = ensureTurnState(
        event.turnId,
        event.snapshot.promptIndex,
      );
      const turnExists = baseState.turnOrder.includes(event.turnId);
      return {
        ...baseState,
        turnOrder: turnExists
          ? baseState.turnOrder
          : [...baseState.turnOrder, event.turnId],
        turns: {
          ...baseState.turns,
          [event.turnId]: {
            ...turnState,
            promptIndex: event.snapshot.promptIndex,
            spans: Array.isArray(event.snapshot.spans)
              ? event.snapshot.spans
              : [],
            usage: event.snapshot.usage,
            actualToolCalls: dedupeTraceToolCalls(
              event.snapshot.actualToolCalls,
            ),
          },
        },
        messages: Array.isArray(event.snapshot.messages)
          ? event.snapshot.messages
          : baseState.messages,
        activeTurnId:
          baseState.activeTurnId === null
            ? event.turnId
            : baseState.activeTurnId,
        activeTurnHasSnapshot:
          baseState.activeTurnId === event.turnId ||
          baseState.activeTurnId === null,
        anySnapshotSeen: true,
      };
    }
    case "turn_finish": {
      const turnState = ensureTurnState(event.turnId, event.promptIndex);
      const turnExists = baseState.turnOrder.includes(event.turnId);
      return {
        ...baseState,
        turnOrder: turnExists
          ? baseState.turnOrder
          : [...baseState.turnOrder, event.turnId],
        turns: {
          ...baseState.turns,
          [event.turnId]: {
            ...turnState,
            usage: event.usage ?? turnState.usage,
          },
        },
        activeTurnId:
          baseState.activeTurnId === event.turnId
            ? null
            : baseState.activeTurnId,
        activeTurnHasSnapshot:
          baseState.activeTurnId === event.turnId
            ? false
            : baseState.activeTurnHasSnapshot,
      };
    }
    default:
      return baseState;
  }
}

function buildLiveTraceEnvelope(
  state: LiveTraceAccumulatorState,
): LiveChatTraceEnvelope | null {
  if (state.events.length === 0 && !state.anySnapshotSeen) {
    return null;
  }

  const spans: EvalTraceSpan[] = [];
  const turns: LiveChatTraceEnvelope["turns"] = [];
  let usage: LiveChatTraceUsage | undefined;
  const actualToolCalls: LiveChatTraceToolCall[] = [];
  let nextOffsetMs = 0;
  let traceStartedAtMs: number | undefined;

  for (const turnId of state.turnOrder) {
    const turn = state.turns[turnId];
    if (!turn) {
      continue;
    }

    if (
      typeof turn.startedAtMs === "number" &&
      Number.isFinite(turn.startedAtMs) &&
      traceStartedAtMs === undefined
    ) {
      traceStartedAtMs = turn.startedAtMs;
    }

    const durationMs = getTraceSpansDurationMs(turn.spans);
    if (turn.spans.length > 0) {
      spans.push(...rebaseTraceSpans(turn.spans, nextOffsetMs));
    }
    usage = mergeLiveChatTraceUsage(usage, turn.usage);
    actualToolCalls.push(...turn.actualToolCalls);
    turns.push({
      turnId,
      promptIndex: turn.promptIndex,
      durationMs,
      usage: turn.usage,
      actualToolCalls: turn.actualToolCalls,
    });
    nextOffsetMs += durationMs;
  }

  const envelope: LiveChatTraceEnvelope = {
    traceVersion: 1,
    messages: state.messages,
    spans: spans.length > 0 ? spans : undefined,
    usage,
    actualToolCalls: dedupeTraceToolCalls(actualToolCalls),
    events: state.events,
    turns,
  };

  if (
    typeof traceStartedAtMs === "number" &&
    Number.isFinite(traceStartedAtMs)
  ) {
    envelope.traceStartedAtMs = traceStartedAtMs;
    envelope.traceEndedAtMs = traceStartedAtMs + nextOffsetMs;
  }

  return envelope;
}

function mergePreviewSpansIntoLiveEnvelope(
  envelope: LiveChatTraceEnvelope,
  state: LiveTraceAccumulatorState,
  previewWallElapsedMs: number | undefined,
  transcriptFromUi: ModelMessage[] | null,
): LiveChatTraceEnvelope {
  if (!state.activeTurnId || state.activeTurnHasSnapshot) {
    return envelope;
  }

  const preview = buildLiveChatPreviewSpans({
    events: state.events,
    activeTurnId: state.activeTurnId,
    previewWallElapsedMs,
  });
  if (preview.length === 0) {
    return envelope;
  }

  const transcript = pickTranscriptForLiveTracePreview({
    snapshotMessages: envelope.messages,
    transcriptFromUi,
  });
  const previewIndexed = applyPreviewSpansUserMessageIndices(
    preview,
    transcript,
  );

  const existing = envelope.spans ?? [];
  const baseOffset =
    existing.length > 0 ? Math.max(...existing.map((s) => s.endMs)) : 0;
  const rebased = rebaseTraceSpans(previewIndexed, baseOffset);
  const merged = [...existing, ...rebased];
  const previewDur = getTraceSpansDurationMs(previewIndexed);
  const extent = baseOffset + previewDur;

  return {
    ...envelope,
    messages: transcript,
    spans: merged,
    traceEndedAtMs:
      typeof envelope.traceStartedAtMs === "number" &&
      Number.isFinite(envelope.traceStartedAtMs)
        ? envelope.traceStartedAtMs + extent
        : envelope.traceEndedAtMs,
  };
}

function isTransientMessage(message: UIMessage): boolean {
  if (
    message.role === "system" &&
    (message as { metadata?: { source?: string } }).metadata?.source ===
      "server-instruction"
  ) {
    return true;
  }

  return message.id?.startsWith("widget-state-") ?? false;
}

function shouldForkChatSession(
  previousMessages: UIMessage[],
  nextMessages: UIMessage[],
): boolean {
  const previousPersistentIds = previousMessages
    .filter((message) => !isTransientMessage(message))
    .map((message) => message.id);
  const nextPersistentIds = nextMessages
    .filter((message) => !isTransientMessage(message))
    .map((message) => message.id);

  if (nextPersistentIds.length >= previousPersistentIds.length) {
    return false;
  }

  return nextPersistentIds.every(
    (messageId, index) => messageId === previousPersistentIds[index],
  );
}

function isAuthDeniedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const withStatus = error as { status?: unknown; message?: unknown };
  if (withStatus.status === 401 || withStatus.status === 403) return true;
  if (typeof withStatus.message !== "string") return false;
  return /\b(401|403)\b|unauthorized|forbidden/i.test(withStatus.message);
}

export function useChatSession({
  selectedServers,
  hostedWorkspaceId,
  hostedSelectedServerIds = [],
  hostedOAuthTokens,
  hostedShareToken,
  hostedSandboxToken,
  hostedSandboxSurface,
  minimalMode: _minimalMode = false,
  initialModelId,
  initialSystemPrompt = DEFAULT_SYSTEM_PROMPT,
  initialTemperature = 0.7,
  initialRequireToolApproval = false,
  onReset,
}: UseChatSessionOptions): UseChatSessionReturn {
  const { getAccessToken } = useAuth();

  // Store onReset in a ref to avoid triggering effects when the callback changes identity
  const onResetRef = useRef(onReset);
  useLayoutEffect(() => {
    onResetRef.current = onReset;
  }, [onReset]);
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const {
    hasToken,
    getToken,
    getOpenRouterSelectedModels,
    getOllamaBaseUrl,
    getAzureBaseUrl,
  } = useAiProviderKeys();
  const { customProviders, getCustomProviderByName } = useCustomProviders();

  // Local state
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const [authHeaders, setAuthHeaders] = useState<
    Record<string, string> | undefined
  >(undefined);
  const [isSessionBootstrapComplete, setIsSessionBootstrapComplete] =
    useState(false);
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);
  const [temperature, setTemperature] = useState(initialTemperature);
  const [chatSessionId, setChatSessionId] = useState(generateId());
  const chatSessionIdRef = useRef(chatSessionId);
  chatSessionIdRef.current = chatSessionId;
  const [, setHydrationTick] = useState(0);
  const [resumedVersion, setResumedVersion] = useState<number | null>(null);
  const [restoredToolRenderOverrides, setRestoredToolRenderOverrides] =
    useState<Record<string, ToolRenderOverride>>({});
  const [liveTraceState, setLiveTraceState] =
    useState<LiveTraceAccumulatorState>(() => createEmptyLiveTraceState());
  const resumedVersionRef = useRef<number | null>(null);
  const restoredToolRenderOverridesRef = useRef<
    Record<string, ToolRenderOverride>
  >({});
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, unknown>>
  >({});
  const [toolServerMap, setToolServerMap] = useState<ToolServerMap>({});
  const [mcpToolsTokenCount, setMcpToolsTokenCount] = useState<Record<
    string,
    number
  > | null>(null);
  const [mcpToolsTokenCountLoading, setMcpToolsTokenCountLoading] =
    useState(false);
  const [systemPromptTokenCount, setSystemPromptTokenCount] = useState<
    number | null
  >(null);
  const [systemPromptTokenCountLoading, setSystemPromptTokenCountLoading] =
    useState(false);
  const [requireToolApproval, setRequireToolApproval] = useState(
    initialRequireToolApproval,
  );
  const requireToolApprovalRef = useRef(requireToolApproval);
  requireToolApprovalRef.current = requireToolApproval;
  const directGuestMode =
    HOSTED_MODE &&
    !isAuthenticated &&
    !isAuthLoading &&
    !hostedWorkspaceId &&
    !hostedShareToken;
  const sharedGuestMode =
    HOSTED_MODE &&
    !isAuthenticated &&
    !isAuthLoading &&
    !!hostedWorkspaceId &&
    !!(hostedShareToken || hostedSandboxToken);
  const guestMode = directGuestMode || sharedGuestMode;
  const skipNextForkDetectionRef = useRef(false);
  const pendingSessionHydrationRef = useRef<PendingSessionHydration | null>(
    null,
  );
  const selectedServersSignature = useMemo(
    () => selectedServers.join("\u0000"),
    [selectedServers],
  );
  const liveTraceEnvelopeBase = useMemo(
    () => buildLiveTraceEnvelope(liveTraceState),
    [liveTraceState],
  );
  const hasTraceSnapshot = liveTraceState.activeTurnId
    ? liveTraceState.activeTurnHasSnapshot
    : liveTraceState.anySnapshotSeen;
  const livePreviewSpanCount = useMemo(() => {
    if (!liveTraceState.activeTurnId || liveTraceState.activeTurnHasSnapshot) {
      return 0;
    }
    return buildLiveChatPreviewSpans({
      events: liveTraceState.events,
      activeTurnId: liveTraceState.activeTurnId,
    }).length;
  }, [
    liveTraceState.activeTurnId,
    liveTraceState.activeTurnHasSnapshot,
    liveTraceState.events,
  ]);
  const handleTraceDataPart = useCallback((part: unknown) => {
    if (!isTraceEventDataPart(part)) {
      return;
    }

    setLiveTraceState((current) => applyLiveTraceEvent(current, part.data));
  }, []);

  const syncResumedVersion = useCallback((version: number | null) => {
    resumedVersionRef.current = version;
    setResumedVersion(version);
  }, []);
  const syncRestoredToolRenderOverrides = useCallback(
    (overrides: Record<string, ToolRenderOverride>) => {
      restoredToolRenderOverridesRef.current = overrides;
      setRestoredToolRenderOverrides(overrides);
    },
    [],
  );
  const clearPendingSessionHydration = useCallback(() => {
    const pendingHydration = pendingSessionHydrationRef.current;
    if (!pendingHydration) {
      return;
    }

    pendingSessionHydrationRef.current = null;
    pendingHydration.resolve?.();
  }, []);

  // Build available models
  const availableModels = useMemo(() => {
    const models = buildAvailableModels({
      hasToken,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
      getAzureBaseUrl,
      customProviders,
    });
    if (HOSTED_MODE) {
      const mcpjamModels = models.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      );
      // Guests should see the same MCPJam-hosted free model set as signed-in
      // free users. Shared billing/feature entitlements still require auth.
      if (guestMode) {
        return mcpjamModels.filter((m) =>
          GUEST_ALLOWED_MODEL_IDS.includes(String(m.id)),
        );
      }
      return mcpjamModels;
    }
    // Non-hosted: filter out non-guest MCPJam models when unauthenticated
    // (keep user-provided models + 3 free MCPJam models)
    if (!isAuthenticated) {
      return models.filter(
        (m) =>
          !isMCPJamProvidedModel(String(m.id)) ||
          isGuestAllowedModel(String(m.id)),
      );
    }
    return models;
  }, [
    hasToken,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    getAzureBaseUrl,
    guestMode,
    isAuthenticated,
    customProviders,
  ]);

  // Model selection with persistence
  const {
    selectedModelId,
    setSelectedModelId,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
  } = usePersistedModel();
  const selectedModel = useMemo<ModelDefinition>(() => {
    const fallback = getDefaultModel(availableModels);
    if (initialModelId) {
      return (
        availableModels.find((model) => String(model.id) === initialModelId) ??
        fallback
      );
    }
    if (!selectedModelId) return fallback;
    const found = availableModels.find((m) => String(m.id) === selectedModelId);
    return found ?? fallback;
  }, [availableModels, initialModelId, selectedModelId]);

  const setSelectedModel = useCallback(
    (model: ModelDefinition) => {
      if (initialModelId) {
        return;
      }
      setSelectedModelId(String(model.id));
    },
    [initialModelId, setSelectedModelId],
  );

  const isMcpJamModel = useMemo(() => {
    return selectedModel?.id
      ? isMCPJamProvidedModel(String(selectedModel.id))
      : false;
  }, [selectedModel]);
  const traceViewsSupported = HOSTED_MODE ? isMcpJamModel : true;

  // Create transport
  const transport = useMemo(() => {
    let apiKey: string;
    if (
      selectedModel.provider === "custom" &&
      selectedModel.customProviderName
    ) {
      // For custom providers, the API key is embedded in the provider config
      const cp = getCustomProviderByName(selectedModel.customProviderName);
      apiKey = cp?.apiKey || "";
    } else {
      apiKey = getToken(selectedModel.provider as keyof ProviderTokens);
    }
    const isGpt5 = isGPT5Model(selectedModel.id);

    // Merge session auth headers with workos auth headers
    const sessionHeaders = getSessionAuthHeaders();
    const mergedHeaders = { ...sessionHeaders, ...authHeaders } as Record<
      string,
      string
    >;
    const transportHeaders = HOSTED_MODE
      ? undefined
      : Object.keys(mergedHeaders).length > 0
        ? mergedHeaders
        : undefined;

    const chatApi = HOSTED_MODE ? "/api/web/chat-v2" : "/api/mcp/chat-v2";

    // Build hosted body based on whether we have a workspace.
    // Signed-in users are blocked from submitting until hostedWorkspaceId loads
    // (via hostedContextNotReady), so this branch only runs for guests.
    const buildHostedBody = () => {
      if (!hostedWorkspaceId) {
        if (directGuestMode && selectedServers.length > 0) {
          return {
            chatSessionId,
            ...buildHostedServerRequest(selectedServers[0]),
          };
        }

        return {
          chatSessionId,
        };
      }
      return {
        workspaceId: hostedWorkspaceId,
        chatSessionId,
        selectedServerIds: hostedSelectedServerIds,
        accessScope: "chat_v2" as const,
        ...(hostedShareToken ? { shareToken: hostedShareToken } : {}),
        ...(hostedSandboxToken ? { sandboxToken: hostedSandboxToken } : {}),
        ...(hostedSandboxToken && hostedSandboxSurface
          ? { surface: hostedSandboxSurface }
          : {}),
        ...(hostedOAuthTokens && Object.keys(hostedOAuthTokens).length > 0
          ? { oauthTokens: hostedOAuthTokens }
          : {}),
      };
    };

    return new DefaultChatTransport({
      api: chatApi,
      fetch: HOSTED_MODE ? authFetch : undefined,
      body: () => ({
        model: selectedModel,
        ...(HOSTED_MODE ? {} : { apiKey }),
        ...(isGpt5 ? {} : { temperature }),
        systemPrompt,
        ...(HOSTED_MODE
          ? buildHostedBody()
          : {
              selectedServers,
              chatSessionId,
              // Pass workspaceId for BYOK direct-chat history persistence
              ...(hostedWorkspaceId ? { workspaceId: hostedWorkspaceId } : {}),
            }),
        requireToolApproval: requireToolApprovalRef.current,
        ...(!HOSTED_MODE && customProviders.length > 0
          ? { customProviders }
          : {}),
        ...(resumedVersionRef.current !== null
          ? { expectedVersion: resumedVersionRef.current }
          : {}),
      }),
      headers: transportHeaders,
    });
  }, [
    selectedModel,
    getToken,
    getCustomProviderByName,
    customProviders,
    authHeaders,
    temperature,
    systemPrompt,
    selectedServers,
    directGuestMode,
    hostedWorkspaceId,
    chatSessionId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    hostedShareToken,
    hostedSandboxToken,
    hostedSandboxSurface,
    // requireToolApproval read from ref at request time
  ]);

  // useChat hook
  const {
    messages,
    sendMessage: baseSendMessage,
    stop,
    status,
    error,
    setMessages: baseSetMessages,
    addToolApprovalResponse,
  } = useChat({
    id: chatSessionId,
    transport: transport!,
    onData: handleTraceDataPart,
    sendAutomaticallyWhen: requireToolApproval
      ? lastAssistantMessageIsCompleteWithApprovalResponses
      : undefined,
  });

  const queueSessionHydration = useCallback(
    (hydration: PendingSessionHydration) => {
      clearPendingSessionHydration();

      // If the chatSessionId is already the target value, setChatSessionId
      // would be a no-op and the useLayoutEffect that processes the pending
      // hydration would never fire.  Apply the hydration directly instead.
      if (hydration.sessionId === chatSessionIdRef.current) {
        baseSetMessages(hydration.messages);
        syncResumedVersion(hydration.resumedVersion);
        syncRestoredToolRenderOverrides(hydration.toolRenderOverrides ?? {});
        setHydrationTick((t) => t + 1);
        return Promise.resolve();
      }

      return new Promise<void>((resolve) => {
        pendingSessionHydrationRef.current = {
          ...hydration,
          resolve,
        };
        setChatSessionId(hydration.sessionId);
      });
    },
    [clearPendingSessionHydration, baseSetMessages, syncResumedVersion],
  );

  const [traceTranscriptFromUi, setTraceTranscriptFromUi] = useState<
    ModelMessage[] | null
  >(null);

  useEffect(() => {
    const persistent = messages.filter(
      (message) => !isTransientMessage(message),
    );
    if (persistent.length === 0) {
      setTraceTranscriptFromUi(null);
      return;
    }
    let cancelled = false;
    void convertToModelMessages(
      persistent.map(({ id: _omitId, ...rest }) => rest) as Parameters<
        typeof convertToModelMessages
      >[0],
      { ignoreIncompleteToolCalls: true },
    ).then((modelMessages) => {
      if (!cancelled) {
        setTraceTranscriptFromUi(modelMessages);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [messages]);

  const [previewWallTick, setPreviewWallTick] = useState(0);

  useEffect(() => {
    const previewing =
      liveTraceState.activeTurnId && !liveTraceState.activeTurnHasSnapshot;
    const streaming = status === "streaming" || status === "submitted";
    if (!previewing || !streaming) {
      return;
    }
    const id = window.setInterval(
      () => setPreviewWallTick((previous) => previous + 1),
      400,
    );
    return () => clearInterval(id);
  }, [
    liveTraceState.activeTurnId,
    liveTraceState.activeTurnHasSnapshot,
    status,
  ]);

  const previewWallElapsedMs = useMemo(() => {
    if (!liveTraceState.activeTurnId || liveTraceState.activeTurnHasSnapshot) {
      return undefined;
    }
    const turn = liveTraceState.turns[liveTraceState.activeTurnId];
    const started = turn?.startedAtMs;
    if (typeof started !== "number" || !Number.isFinite(started)) {
      return undefined;
    }
    void previewWallTick;
    return Math.max(0, Date.now() - started);
  }, [
    liveTraceState.activeTurnId,
    liveTraceState.activeTurnHasSnapshot,
    liveTraceState.turns,
    previewWallTick,
  ]);

  const liveTraceEnvelope = useMemo(() => {
    if (!liveTraceEnvelopeBase) {
      return null;
    }
    return mergePreviewSpansIntoLiveEnvelope(
      liveTraceEnvelopeBase,
      liveTraceState,
      previewWallElapsedMs,
      traceTranscriptFromUi,
    );
  }, [
    liveTraceEnvelopeBase,
    liveTraceState,
    previewWallElapsedMs,
    traceTranscriptFromUi,
  ]);
  const hasLiveTimelineContent =
    livePreviewSpanCount > 0 || (liveTraceEnvelope?.spans?.length ?? 0) > 0;

  useEffect(() => {
    setLiveTraceState(createEmptyLiveTraceState());
  }, [chatSessionId]);

  useSharedChatWidgetCapture({
    enabled: HOSTED_MODE && (isAuthenticated || directGuestMode),
    chatSessionId,
    hostedShareToken,
    hostedSandboxToken,
    messages,
  });

  const setMessages = useCallback<
    React.Dispatch<React.SetStateAction<UIMessage[]>>
  >(
    (updater) => {
      baseSetMessages((previousMessages) => {
        const nextMessages =
          typeof updater === "function" ? updater(previousMessages) : updater;
        const shouldSkipForkDetection = skipNextForkDetectionRef.current;
        skipNextForkDetectionRef.current = false;

        if (
          !shouldSkipForkDetection &&
          shouldForkChatSession(previousMessages, nextMessages)
        ) {
          const nextSessionId = generateId();
          clearPendingSessionHydration();
          pendingSessionHydrationRef.current = {
            sessionId: nextSessionId,
            messages: nextMessages,
            resumedVersion: null,
          };
          queueMicrotask(() => {
            if (
              pendingSessionHydrationRef.current?.sessionId === nextSessionId
            ) {
              setChatSessionId(nextSessionId);
            }
          });
        }

        return nextMessages;
      });
    },
    [baseSetMessages],
  );

  useLayoutEffect(() => {
    const pendingHydration = pendingSessionHydrationRef.current;
    if (!pendingHydration || pendingHydration.sessionId !== chatSessionId) {
      return;
    }

    pendingSessionHydrationRef.current = null;

    baseSetMessages(pendingHydration.messages);
    syncResumedVersion(pendingHydration.resumedVersion);
    syncRestoredToolRenderOverrides(
      pendingHydration.toolRenderOverrides ?? {},
    );
    // Force a React state update so that useSyncExternalStore re-reads the
    // messages snapshot that was just written to the Chat store above.
    // Without this, the external-store change made by baseSetMessages may
    // not trigger a re-render when syncResumedVersion is a no-op (same
    // version value as before).
    setHydrationTick((t) => t + 1);
    pendingHydration.resolve?.();
  }, [baseSetMessages, chatSessionId, syncResumedVersion, syncRestoredToolRenderOverrides]);

  // Wrapped sendMessage that accepts FileUIPart[]
  const sendMessage = useCallback(
    (options: {
      text: string;
      files?: Array<{
        type: "file";
        mediaType: string;
        filename?: string;
        url: string;
      }>;
    }) => {
      const { text, files } = options;
      if (files && files.length > 0) {
        // AI SDK accepts FileUIPart[] with data URLs
        baseSendMessage({ text, files });
      } else {
        baseSendMessage({ text });
      }
    },
    [baseSendMessage],
  );

  // Reset chat
  const resetChat = useCallback(() => {
    skipNextForkDetectionRef.current = true;
    clearPendingSessionHydration();
    setChatSessionId(generateId());
    setMessages([]);
    syncResumedVersion(null);
    syncRestoredToolRenderOverrides({});
    onResetRef.current?.();
  }, [clearPendingSessionHydration, setMessages, syncResumedVersion, syncRestoredToolRenderOverrides]);

  const startChatWithMessages = useCallback(
    (messages: UIMessage[]) => {
      skipNextForkDetectionRef.current = true;
      void queueSessionHydration({
        sessionId: generateId(),
        messages,
        resumedVersion: null,
      });
      onResetRef.current?.();
    },
    [queueSessionHydration],
  );

  const loadChatSession = useCallback(
    async (session: {
      chatSessionId: string;
      messagesBlobUrl: string | null;
      resumeConfig?: {
        systemPrompt?: string;
        temperature?: number;
        requireToolApproval?: boolean;
        selectedServers?: string[];
        draftInput?: string;
      };
      version: number;
      widgetSnapshots?: Array<{
        toolCallId: string;
        toolName: string;
        serverId: string;
        uiType: "mcp-apps" | "openai-apps";
        resourceUri?: string;
        widgetCsp: Record<string, unknown> | null;
        widgetPermissions: Record<string, unknown> | null;
        widgetPermissive: boolean;
        prefersBorder: boolean;
        widgetHtmlUrl?: string | null;
      }>;
    }) => {
      let uiMessages: UIMessage[] = [];

      if (session.messagesBlobUrl) {
        const response = await fetch(session.messagesBlobUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch chat transcript (${response.status})`,
          );
        }
        const transcript = await response.json();
        uiMessages = transcriptToUIMessages(transcript);
      }

      // Build toolRenderOverrides from widget snapshots if available
      let overrides: Record<string, ToolRenderOverride> = {};
      if (session.widgetSnapshots && session.widgetSnapshots.length > 0) {
        const traceSnapshots = snapshotsToTraceWidgetSnapshots(
          session.widgetSnapshots,
        );
        overrides = buildToolRenderOverridesFromSnapshots(traceSnapshots);
      }

      if (session.resumeConfig?.systemPrompt !== undefined) {
        setSystemPrompt(session.resumeConfig.systemPrompt);
      }
      if (session.resumeConfig?.temperature !== undefined) {
        setTemperature(session.resumeConfig.temperature);
      }
      if (session.resumeConfig?.requireToolApproval !== undefined) {
        setRequireToolApproval(session.resumeConfig.requireToolApproval);
      }

      skipNextForkDetectionRef.current = true;
      await queueSessionHydration({
        sessionId: session.chatSessionId,
        messages: uiMessages,
        resumedVersion: session.version,
        toolRenderOverrides: overrides,
      });
      onResetRef.current?.();
    },
    [queueSessionHydration],
  );

  useEffect(() => {
    setSystemPrompt(initialSystemPrompt);
  }, [initialSystemPrompt]);

  useEffect(() => {
    setTemperature(initialTemperature);
  }, [initialTemperature]);

  useEffect(() => {
    setRequireToolApproval(initialRequireToolApproval);
  }, [initialRequireToolApproval]);

  // Auth headers setup - reset chat after auth changes to ensure transport has correct headers
  useEffect(() => {
    let active = true;
    setIsSessionBootstrapComplete(false);
    (async () => {
      let resolved = false;

      try {
        const token = await getAccessToken?.();
        if (!active) return;
        if (token) {
          setAuthHeaders({ Authorization: `Bearer ${token}` });
          resolved = true;
        }
      } catch {
        // getAccessToken threw (e.g. LoginRequiredError) — not authenticated
      }

      // In non-hosted mode, attach a guest bearer so local chat persistence and
      // history lookups use the same Convex identity as the active thread.
      // In hosted mode, only fall back to guest auth for explicit guest
      // surfaces. A regular hosted workspace should never silently downgrade.
      if (!resolved && active && !HOSTED_MODE) {
        const guestToken = await getGuestBearerToken();
        if (!active) return;
        if (guestToken) {
          setAuthHeaders({ Authorization: `Bearer ${guestToken}` });
          resolved = true;
        } else {
          setAuthHeaders(undefined);
        }
      } else if (
        !resolved &&
        active &&
        !isAuthenticated &&
        HOSTED_MODE &&
        (!hostedWorkspaceId || !!hostedShareToken || !!hostedSandboxToken)
      ) {
        const guestToken = await getGuestBearerToken();
        if (!active) return;
        if (guestToken) {
          setAuthHeaders({ Authorization: `Bearer ${guestToken}` });
          resolved = true;
        } else {
          setAuthHeaders(undefined);
        }
      } else if (!resolved && active) {
        setAuthHeaders(undefined);
      }

      // Reset chat to force new session with updated auth headers
      if (active) {
        skipNextForkDetectionRef.current = true;
        clearPendingSessionHydration();
        setChatSessionId(generateId());
        setMessages([]);
        syncResumedVersion(null);
        syncRestoredToolRenderOverrides({});
        onResetRef.current?.();
        setIsSessionBootstrapComplete(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [
    getAccessToken,
    hostedShareToken,
    hostedSandboxToken,
    hostedWorkspaceId,
    isAuthenticated,
    clearPendingSessionHydration,
    setMessages,
    syncResumedVersion,
    syncRestoredToolRenderOverrides,
  ]);

  // Ollama model detection
  useEffect(() => {
    if (HOSTED_MODE) {
      setIsOllamaRunning(false);
      setOllamaModels([]);
      return;
    }

    const checkOllama = async () => {
      const { isRunning, availableModels } =
        await detectOllamaModels(getOllamaBaseUrl());
      setIsOllamaRunning(isRunning);

      const toolCapable = isRunning
        ? await detectOllamaToolCapableModels(getOllamaBaseUrl())
        : [];
      const toolCapableSet = new Set(toolCapable);
      const ollamaDefs: ModelDefinition[] = availableModels.map(
        (modelName) => ({
          id: modelName,
          name: modelName,
          provider: "ollama" as const,
          disabled: !toolCapableSet.has(modelName),
          disabledReason: toolCapableSet.has(modelName)
            ? undefined
            : "Model does not support tool calling",
        }),
      );
      setOllamaModels(ollamaDefs);
    };
    checkOllama();
    const interval = setInterval(checkOllama, 30000);
    return () => clearInterval(interval);
  }, [getOllamaBaseUrl]);

  // Fetch tools metadata
  useEffect(() => {
    const fetchToolsMetadata = async () => {
      if (selectedServers.length === 0) {
        setToolsMetadata((previous) =>
          Object.keys(previous).length > 0 ? {} : previous,
        );
        setToolServerMap((previous) =>
          Object.keys(previous).length > 0 ? {} : previous,
        );
        setMcpToolsTokenCount((previous) =>
          previous !== null ? null : previous,
        );
        setMcpToolsTokenCountLoading((previous) =>
          previous ? false : previous,
        );
        return;
      }

      const shouldCountTokens = selectedModel?.id && selectedModel?.provider;
      const modelIdForTokens = shouldCountTokens
        ? isMCPJamProvidedModel(String(selectedModel.id))
          ? String(selectedModel.id)
          : `${selectedModel.provider}/${selectedModel.id}`
        : undefined;

      setMcpToolsTokenCountLoading(!!modelIdForTokens);

      try {
        const { metadata, toolServerMap, tokenCounts } = await getToolsMetadata(
          selectedServers,
          modelIdForTokens,
        );
        setToolsMetadata(metadata);
        setToolServerMap(toolServerMap);
        setMcpToolsTokenCount(
          tokenCounts && Object.keys(tokenCounts).length > 0
            ? tokenCounts
            : null,
        );
      } catch (error) {
        if (
          !(
            (hostedShareToken || hostedSandboxToken) &&
            isAuthDeniedError(error)
          )
        ) {
          console.warn(
            "[useChatSession] Failed to fetch tools metadata:",
            error,
          );
        }
        setToolsMetadata({});
        setToolServerMap({});
        setMcpToolsTokenCount(null);
      } finally {
        setMcpToolsTokenCountLoading(false);
      }
    };

    fetchToolsMetadata();
  }, [
    selectedServersSignature,
    selectedModel,
    hostedShareToken,
    hostedSandboxToken,
  ]);

  // System prompt token count
  useEffect(() => {
    const fetchSystemPromptTokenCount = async () => {
      if (!systemPrompt || !selectedModel?.id || !selectedModel?.provider) {
        setSystemPromptTokenCount(null);
        setSystemPromptTokenCountLoading(false);
        return;
      }

      setSystemPromptTokenCountLoading(true);
      try {
        const modelId = isMCPJamProvidedModel(String(selectedModel.id))
          ? String(selectedModel.id)
          : `${selectedModel.provider}/${selectedModel.id}`;
        const count = await countTextTokens(systemPrompt, modelId);
        setSystemPromptTokenCount(count > 0 ? count : null);
      } catch (error) {
        if (
          !(
            (hostedShareToken || hostedSandboxToken) &&
            isAuthDeniedError(error)
          )
        ) {
          console.warn(
            "[useChatSession] Failed to count system prompt tokens:",
            error,
          );
        }
        setSystemPromptTokenCount(null);
      } finally {
        setSystemPromptTokenCountLoading(false);
      }
    };

    fetchSystemPromptTokenCount();
  }, [systemPrompt, selectedModel, hostedShareToken, hostedSandboxToken]);

  // Reset chat when selected servers change
  const previousSelectedServersRef = useRef<string[]>(selectedServers);
  useEffect(() => {
    const previousNames = previousSelectedServersRef.current;
    const currentNames = selectedServers;
    const hasChanged =
      previousNames.length !== currentNames.length ||
      previousNames.some((name, index) => name !== currentNames[index]);

    if (hasChanged) {
      const isRestoringExistingSession =
        resumedVersionRef.current !== null ||
        pendingSessionHydrationRef.current !== null;
      if (!isRestoringExistingSession) {
        resetChat();
      }
    }

    previousSelectedServersRef.current = currentNames;
  }, [selectedServers, resetChat]);

  // Token usage calculation
  const tokenUsage = useMemo<TokenUsage>(() => {
    let lastInputTokens = 0;
    let totalOutputTokens = 0;

    for (const message of messages) {
      if (message.role === "assistant" && message.metadata) {
        const metadata = message.metadata as
          | {
              inputTokens?: number;
              outputTokens?: number;
            }
          | undefined;

        if (metadata) {
          lastInputTokens = metadata.inputTokens ?? 0;
          totalOutputTokens += metadata.outputTokens ?? 0;
        }
      }
    }

    return {
      inputTokens: lastInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: lastInputTokens + totalOutputTokens,
    };
  }, [messages]);

  // Computed state for UI
  // Compute guest access from React state instead of the global hostedApiContext.
  // Shared chats are guest-capable even though they are scoped to a workspace,
  // while direct guests have no workspace at all.
  // In hosted mode: always require auth (guest JWT or WorkOS — handled by authFetch).
  // In non-hosted mode: auth is only needed if a future MCPJam model opts out
  // of guest access. Current free-tier MCPJam models run on guest auth.
  const requiresAuthForChat = HOSTED_MODE
    ? true
    : isMcpJamModel && !isGuestAllowedModel(String(selectedModel?.id ?? ""));
  const isAuthReady =
    !requiresAuthForChat || guestMode || (isAuthenticated && !!authHeaders);
  // Guest users don't need WorkOS auth — authFetch handles guest bearer tokens
  const disableForAuthentication =
    !isAuthenticated && requiresAuthForChat && !guestMode;
  const authHeadersNotReady =
    requiresAuthForChat && isAuthenticated && !authHeaders;
  // Direct guests don't need a workspace; shared guests still do.
  const hostedContextNotReady =
    HOSTED_MODE &&
    !directGuestMode &&
    (!hostedWorkspaceId ||
      (selectedServers.length > 0 &&
        hostedSelectedServerIds.length !== selectedServers.length));
  const isStreaming = status === "streaming" || status === "submitted";
  const submitBlocked =
    disableForAuthentication ||
    isAuthLoading ||
    authHeadersNotReady ||
    hostedContextNotReady;
  const inputDisabled = status !== "ready" || submitBlocked;

  return {
    // Chat state
    messages,
    setMessages,
    sendMessage,
    stop,
    status,
    error,
    chatSessionId,

    // Model state
    selectedModel,
    setSelectedModel,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
    availableModels,
    isMcpJamModel,

    // Auth state
    isAuthenticated,
    isAuthLoading,
    authHeaders,
    isAuthReady,
    isSessionBootstrapComplete,

    // Config
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,

    // Tools metadata
    toolsMetadata,
    toolServerMap,

    // Token counts
    tokenUsage,
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,

    // Tool approval
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse,

    // Actions
    resetChat,
    startChatWithMessages,
    loadChatSession,
    syncResumedVersion,

    // Resumed thread version
    resumedVersion,

    // Restored widget render overrides
    restoredToolRenderOverrides,

    // Live trace state
    liveTraceEnvelope,
    hasTraceSnapshot,
    hasLiveTimelineContent,
    traceViewsSupported,

    // Computed state
    isStreaming,
    disableForAuthentication,
    submitBlocked,
    inputDisabled,
  };
}
