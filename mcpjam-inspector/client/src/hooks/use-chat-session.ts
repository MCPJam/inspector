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
  useSyncExternalStore,
} from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import {
  convertToModelMessages,
  type ChatTransport,
  DefaultChatTransport,
  generateId,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ModelMessage,
} from "ai";
import {
  useAppToolsRegistry,
  recordAppToolInvocation,
} from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { scrubAppToolResultForModel } from "@/components/chat-v2/thread/mcp-apps/app-tools-sanitizer";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ModelDefinition, type ModelProvider } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { usePersistedModel } from "@/hooks/use-persisted-model";
import {
  getDefaultModel,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import {
  GUEST_LOCKED_MODEL_REASON,
  OUT_OF_CREDITS_MODEL_REASON,
  composeAvailableModels,
} from "@/components/chat-v2/shared/available-models";
import { useOutOfCredits } from "@/hooks/useCreditBalance";
import {
  isBedrockModelId,
  isMCPJamGuestAllowedModel,
  isMCPJamProvidedModel,
} from "@/shared/types";
import { useDetectedOllamaModels } from "@/hooks/use-detected-ollama-models";
import { DEFAULT_SYSTEM_PROMPT } from "@/components/chat-v2/shared/chat-helpers";
import { getToolsMetadata, ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import { countTextTokens } from "@/lib/apis/mcp-tokenizer-api";
import {
  authFetch,
  getAuthHeaders as getSessionAuthHeaders,
} from "@/lib/session-token";
import {
  notifyMCPJamLimitError,
  notifyMCPJamLimitErrorFromResponse,
} from "@/lib/mcpjam-limit";
import { getGuestBearerToken } from "@/lib/guest-session";
import { HOSTED_MODE } from "@/lib/config";
import {
  preserveHydratedMessageIds,
  transcriptToUIMessages,
} from "@/lib/transcript-to-ui-messages";
import {
  getCachedBlobJson,
  invalidateChatHistoryPrefetch,
} from "@/components/chat-v2/history/chat-history-prefetch";
import type { ToolRenderOverride } from "@/components/chat-v2/thread/tool-render-overrides";
import {
  snapshotsToTraceWidgetSnapshots,
  buildToolRenderOverridesFromSnapshots,
} from "@/components/evals/trace-viewer-adapter";
import { useSharedChatWidgetCapture } from "@/hooks/useSharedChatWidgetCapture";
import {
  ingestHostedRpcLogs,
  useTrafficLogStore,
} from "@/stores/traffic-log-store";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { WidgetModelContextEntry } from "@/shared/chat-v2";
import {
  getTraceSpansDurationMs,
  mergeLiveChatTraceUsage,
  rebaseTraceSpans,
  type LiveChatTraceEnvelope,
  type LiveChatTraceEvent,
  type LiveChatTraceRequestPayloadEntry,
  type LiveChatTraceToolCall,
  type LiveChatTraceUsage,
} from "@/shared/live-chat-trace";
import {
  applyPreviewSpansUserMessageIndices,
  buildLiveChatPreviewSpans,
  pickTranscriptForLiveTracePreview,
} from "@/shared/live-chat-trace-preview";
import { isHostedRpcLogDataPart } from "@/shared/hosted-rpc-log";
import { ingestHostedRpcLogsFromResponse } from "@/lib/apis/web/rpc-logs";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import {
  buildResolvedServerBatchRequest,
  getApiContextRevision,
  subscribeApiContext,
} from "@/lib/apis/web/context";

// SEP-1865 App-Provided Tools: opaque alias shape minted by
// `useAppToolsRegistry`. Mirrors the regex in `app-tools-registry.ts`,
// `shared/http-tool-calls.ts`, and the server-side validators — kept
// local to avoid coupling the hook to the registry's `__internal` export.
const APP_TOOL_ALIAS_REGEX = /^app_[a-z0-9]{8}$/i;

function resolveSystemPrompt(value: string | null | undefined): string {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : DEFAULT_SYSTEM_PROMPT;
}

function getOrgProviderKeyForModel(model: ModelDefinition): string | null {
  if (model.provider === "custom") {
    return model.customProviderName
      ? `custom:${model.customProviderName}`
      : null;
  }
  return model.provider;
}

function isOrgManagedModel(
  orgConfig: OrgVisibleConfig | undefined,
  model: ModelDefinition
): boolean {
  if (isMCPJamProvidedModel(String(model.id))) return false;
  const providerKey = getOrgProviderKeyForModel(model);
  if (!providerKey) return false;
  const provider = orgConfig?.providers.find(
    (p) => p.providerKey === providerKey && p.enabled
  );
  if (!provider) return false;

  if (provider.providerKey === "ollama") {
    return Boolean(
      provider.baseUrl && provider.modelIds?.includes(String(model.id))
    );
  }

  if (provider.providerKey.startsWith("custom:")) {
    const prefix = `${provider.providerKey}:`;
    const modelId = String(model.id).startsWith(prefix)
      ? String(model.id).slice(prefix.length)
      : String(model.id);
    return Boolean(provider.baseUrl && provider.modelIds?.includes(modelId));
  }

  if (
    (provider.providerKey === "openrouter" ||
      provider.providerKey === "bedrock") &&
    provider.selectedModels &&
    provider.selectedModels.length > 0
  ) {
    return (
      provider.hasSecret && provider.selectedModels.includes(String(model.id))
    );
  }

  return provider.hasSecret;
}

export interface UseChatSessionOptions {
  /** Server names to connect to */
  selectedServers: string[];
  /** Visibility to apply when persisting a new direct chat */
  directVisibility?: "private" | "project";
  /** Sanitized organization provider config for org-backed projects */
  hostedOrgModelConfig?: OrgVisibleConfig;
  /** Hosted runtime context (project, server IDs, OAuth tokens, share/chatbox scope) */
  hostedContext?: HostedRuntimeContext;
  /** Minimal UI mode for shared chat (hides diagnostics surfaces only) */
  minimalMode?: boolean;
  /** Execution configuration (model, system prompt, temperature, tool approval) */
  executionConfig?: ExecutionConfig;
  /**
   * Phase 3: real host style for direct chat traces. Forwarded into
   * the request body so the backend persists the v2 hostConfig with
   * the user's actual host style (`claude` / `chatgpt`) rather than
   * defaulting to `'claude'`. Omitted for chatbox flows — the
   * backend resolves chatbox host style from the chatbox row.
   */
  hostStyle?: "claude" | "chatgpt";
  /**
   * Host-level opt-in for progressive MCP tool discovery
   * (`search_mcp_tools` / `load_mcp_tools` meta-tools). Sourced from the
   * caller's resolved host config DTO (per-chatbox, per-host playground
   * column, or project default — caller knows). `undefined` ⇒ backend
   * orchestrator uses its auto policy; `true`/`false` ⇒ explicit
   * host-level override that the orchestrator forwards into
   * `prepareChatV2.progressiveToolDiscovery.enabled`. Held in a ref so a
   * mid-session toggle flip is reflected on the next send.
   */
  progressiveToolDiscovery?: boolean;
  /**
   * Host-level SEP-1865 visibility policy. When false, tools marked
   * `visibility: ["app"]` are still advertised to the model, matching
   * clients that do not implement visibility filtering. Sourced from the
   * caller's resolved host config; held in a ref so client/profile flips
   * affect the next send without remounting.
   */
  respectToolVisibility?: boolean;
  /**
   * Catalog ids of host-managed built-in tools (e.g. ["web_search"]) the
   * model should see this turn. Sourced from the caller's resolved host
   * config; held in a ref so a mid-session toggle flip is reflected on the
   * next send. Server resolves via `resolveBuiltInTools`. Falls back to
   * `executionConfig.builtInToolIds` when this top-level option is omitted.
   */
  builtInToolIds?: string[];
  /** Callback when chat is reset */
  onReset?: (reason?: ChatSessionResetReason) => void;
}

export type ChatSessionResetReason =
  | "auth-bootstrap"
  | "hydrate"
  | "fork"
  | "servers-changed"
  | "reset";

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
    /** Stamped onto the outgoing UIMessage so transcript renderers can
     *  attribute it before persistence round-trips (shared sessions). */
    metadata?: Record<string, unknown>;
    /** Ephemeral SEP-1865 widget context for the next model turn. */
    widgetModelContext?: WidgetModelContextEntry[];
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
  startChatWithMessages: (
    messages: UIMessage[],
    options?: {
      resetReason?: ChatSessionResetReason;
      toolRenderOverrides?: Record<string, ToolRenderOverride>;
    }
  ) => Promise<void>;
  loadChatSession: (
    session: {
      chatSessionId: string;
      messagesBlobUrl: string | null;
      resumeConfig?: {
        systemPrompt?: string;
        temperature?: number;
        requireToolApproval?: boolean;
        respectToolVisibility?: boolean;
        selectedServers?: string[];
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
        toolOutputUrl?: string | null;
      }>;
      turnTraces?: Array<{
        turnId: string;
        promptIndex: number;
        startedAt: number;
        endedAt: number;
        finishReason?: string;
        usage?: LiveChatTraceUsage;
        spansBlobUrl?: string | null;
        modelId?: string;
      }>;
    },
    options?: {
      shouldRestoreResumeConfig?: () => boolean;
      shouldApply?: () => boolean;
    }
  ) => Promise<void>;
  syncResumedVersion: (version: number | null) => void;

  // Resumed thread version (for optimistic concurrency)
  resumedVersion: number | null;

  // Restored widget render overrides from loaded session
  restoredToolRenderOverrides: Record<string, ToolRenderOverride>;

  // Live trace state
  liveTraceEnvelope: LiveChatTraceEnvelope | null;
  requestPayloadHistory: LiveChatTraceRequestPayloadEntry[];
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

function inferModelProviderFromId(modelId: string): ModelProvider {
  // Org Bedrock models persist bare inference-profile ids (no "bedrock/"
  // prefix), so recognize the id shape before prefix matching.
  if (isBedrockModelId(modelId)) {
    return "bedrock";
  }

  const providerPrefix = modelId.split("/")[0];

  switch (providerPrefix) {
    case "anthropic":
    case "azure":
    case "bedrock":
    case "openai":
    case "ollama":
    case "deepseek":
    case "google":
    case "mistral":
    case "moonshotai":
    case "openrouter":
    case "z-ai":
    case "minimax":
    case "qwen":
    case "custom":
      return providerPrefix;
    case "x-ai":
      return "xai";
    case "meta-llama":
      return "meta";
    default:
      return "openrouter";
  }
}

function createLockedInitialModel(modelId: string): ModelDefinition {
  return {
    id: modelId,
    name: modelId,
    provider: inferModelProviderFromId(modelId),
    disabled: true,
    disabledReason: GUEST_LOCKED_MODEL_REASON,
  };
}

interface LiveTraceTurnState {
  turnId: string;
  promptIndex: number;
  spans: EvalTraceSpan[];
  usage?: LiveChatTraceUsage;
  actualToolCalls: LiveChatTraceToolCall[];
  /** From `turn_start.startedAtMs` — anchors wall-clock times in TraceTimeline. */
  startedAtMs?: number;
  /**
   * Wall-clock end time, only populated when the turn was rehydrated from a
   * persisted trace. Enables a duration fallback in `buildLiveTraceEnvelope`
   * when the spans blob fails to load or is genuinely empty.
   */
  endedAtMs?: number;
  /** Persisted finish reason (rehydration only). */
  finishReason?: string;
  /** Persisted model id (rehydration only). */
  modelId?: string;
}

interface LiveTraceAccumulatorState {
  turnOrder: string[];
  turns: Record<string, LiveTraceTurnState>;
  messages: ModelMessage[];
  events: LiveChatTraceEvent[];
  requestPayloadHistory: LiveChatTraceRequestPayloadEntry[];
  activeTurnId: string | null;
  activeTurnHasSnapshot: boolean;
  anySnapshotSeen: boolean;
}

interface PendingSessionHydration {
  sessionId: string;
  messages: UIMessage[];
  resumedVersion: number | null;
  toolRenderOverrides?: Record<
    string,
    import("@/components/chat-v2/thread/tool-render-overrides").ToolRenderOverride
  >;
  persistedSnapshotToolCallIds?: string[];
  turnTraces?: HydratedTurnTrace[];
  resolve?: () => void;
}

const MAX_LIVE_TRACE_EVENTS = 400;

function createEmptyLiveTraceState(): LiveTraceAccumulatorState {
  return {
    turnOrder: [],
    turns: {},
    messages: [],
    events: [],
    requestPayloadHistory: [],
    activeTurnId: null,
    activeTurnHasSnapshot: false,
    anySnapshotSeen: false,
  };
}

export interface HydratedTurnTrace {
  turnId: string;
  promptIndex: number;
  startedAt: number;
  endedAt: number;
  finishReason?: string;
  usage?: LiveChatTraceUsage;
  spans: EvalTraceSpan[];
  modelId?: string;
}

interface PersistedWidgetSnapshot {
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
  toolOutputUrl?: string | null;
  toolOutput?: unknown;
}

async function resolveHydratedTurnTraces(
  raw:
    | Array<{
        turnId: string;
        promptIndex: number;
        startedAt: number;
        endedAt: number;
        finishReason?: string;
        usage?: LiveChatTraceUsage;
        spansBlobUrl?: string | null;
        modelId?: string;
      }>
    | undefined
): Promise<HydratedTurnTrace[] | undefined> {
  // Preserve the `undefined` sentinel so `queueSessionHydration` can tell
  // "caller didn't provide traces — leave existing state alone" apart from
  // "caller gave an explicit empty list — zero persisted traces".
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    return [];
  }
  const results = await Promise.all(
    raw.map(async (trace) => {
      let spans: EvalTraceSpan[] = [];
      if (trace.spansBlobUrl) {
        try {
          const response = await fetch(trace.spansBlobUrl);
          if (response.ok) {
            const parsed = (await response.json()) as unknown;
            if (Array.isArray(parsed)) {
              spans = parsed as EvalTraceSpan[];
            }
          }
        } catch (err) {
          // Span blob fetch failures are non-fatal; the turn survives
          // without span timing data. Warn so a misconfiguration
          // (bad CORS, expired URL, missing blob) surfaces in the
          // console rather than silently blanking latency/token
          // numbers in the trace viewer.
          console.warn(
            `[useChatSession] Failed to fetch spans for turn ${trace.turnId}:`,
            err
          );
        }
      }
      return {
        turnId: trace.turnId,
        promptIndex: trace.promptIndex,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        finishReason: trace.finishReason,
        usage: trace.usage,
        spans,
        modelId: trace.modelId,
      };
    })
  );
  return results;
}

async function resolveHydratedWidgetSnapshots(
  raw: PersistedWidgetSnapshot[] | undefined
): Promise<PersistedWidgetSnapshot[] | undefined> {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.length === 0) {
    return [];
  }

  return Promise.all(
    raw.map(async (snapshot) => {
      if (!snapshot.toolOutputUrl) {
        return snapshot;
      }

      try {
        const response = await fetch(snapshot.toolOutputUrl);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        return {
          ...snapshot,
          toolOutput: (await response.json()) as unknown,
        };
      } catch (err) {
        console.warn(
          `[useChatSession] Failed to fetch tool output for snapshot ${snapshot.toolCallId}:`,
          err
        );
        return snapshot;
      }
    })
  );
}

function buildLiveTraceStateFromTurnTraces(
  traces: HydratedTurnTrace[]
): LiveTraceAccumulatorState {
  if (traces.length === 0) {
    return createEmptyLiveTraceState();
  }

  const ordered = [...traces].sort(
    (left, right) => left.promptIndex - right.promptIndex
  );
  const turnOrder: string[] = [];
  const turns: Record<string, LiveTraceTurnState> = {};
  for (const trace of ordered) {
    turnOrder.push(trace.turnId);
    turns[trace.turnId] = {
      turnId: trace.turnId,
      promptIndex: trace.promptIndex,
      spans: trace.spans,
      usage: trace.usage,
      actualToolCalls: [],
      startedAtMs: trace.startedAt,
      endedAtMs: trace.endedAt,
      finishReason: trace.finishReason,
      modelId: trace.modelId,
    };
  }

  return {
    turnOrder,
    turns,
    messages: [],
    events: [],
    requestPayloadHistory: [],
    activeTurnId: null,
    activeTurnHasSnapshot: false,
    anySnapshotSeen: true,
  };
}

function isTraceEventDataPart(
  value: unknown
): value is { type: "data-trace-event"; data: LiveChatTraceEvent } {
  if (!value || typeof value !== "object") {
    return false;
  }

  const part = value as { type?: unknown; data?: unknown };
  return part.type === "data-trace-event" && !!part.data;
}

function dedupeTraceToolCalls(
  toolCalls: LiveChatTraceToolCall[] | null | undefined
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

function upsertRequestPayloadEntry(
  entries: LiveChatTraceRequestPayloadEntry[],
  nextEntry: LiveChatTraceRequestPayloadEntry
): LiveChatTraceRequestPayloadEntry[] {
  const existingIndex = entries.findIndex(
    (entry) =>
      entry.turnId === nextEntry.turnId &&
      entry.stepIndex === nextEntry.stepIndex
  );

  if (existingIndex < 0) {
    return [...entries, nextEntry];
  }

  return entries.map((entry, index) =>
    index === existingIndex ? nextEntry : entry
  );
}

function applyLiveTraceEvent(
  state: LiveTraceAccumulatorState,
  event: LiveChatTraceEvent
): LiveTraceAccumulatorState {
  // Heartbeat events carry no state. Drop them before any allocation so a
  // long idle stream doesn't bloat the visible event list or trigger
  // re-renders that depend on `state.events.length`.
  if (event.type === "heartbeat") {
    return state;
  }
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
    promptIndex: number
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
    case "request_payload": {
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
            promptIndex: event.promptIndex,
          },
        },
        requestPayloadHistory: upsertRequestPayloadEntry(
          baseState.requestPayloadHistory,
          {
            turnId: event.turnId,
            promptIndex: event.promptIndex,
            stepIndex: event.stepIndex,
            payload: event.payload,
          }
        ),
      };
    }
    case "trace_snapshot": {
      const turnState = ensureTurnState(
        event.turnId,
        event.snapshot.promptIndex
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
              event.snapshot.actualToolCalls
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
  state: LiveTraceAccumulatorState
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

    const spansDurationMs = getTraceSpansDurationMs(turn.spans);
    // Fallback to wall-clock (endedAt - startedAt) when spans are empty —
    // happens if we rehydrated a persisted turn whose spans blob failed to
    // load or was never written, so the turn still gets a non-zero row in
    // the timeline instead of collapsing to a zero-duration sliver.
    const wallClockDurationMs =
      typeof turn.startedAtMs === "number" &&
      typeof turn.endedAtMs === "number" &&
      turn.endedAtMs > turn.startedAtMs
        ? turn.endedAtMs - turn.startedAtMs
        : 0;
    const durationMs =
      spansDurationMs > 0 ? spansDurationMs : wallClockDurationMs;
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
    requestPayloads:
      state.requestPayloadHistory.length > 0
        ? state.requestPayloadHistory
        : undefined,
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
  transcriptFromUi: ModelMessage[] | null
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
    transcript
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
  nextMessages: UIMessage[]
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
    (messageId, index) => messageId === previousPersistentIds[index]
  );
}

function areAuthHeadersEqual(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return !a && !b;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

type HostedSessionScope = {
  projectId?: string | null;
  chatboxId?: string;
};

// `accessVersion` is intentionally NOT part of the scope. The chat-reset
// path uses this comparison to decide when to blow away `chatSessionId` /
// `messages`, which is only appropriate when *identity* changes (different
// project, different chatbox). A pure `accessVersion` bump — e.g. from the
// silent re-redeem triggered by `chatbox_access_stale` — keeps the same
// chatbox and the same conversation; tearing the chat down on those bumps
// would defeat the purpose of the recovery path.
function areHostedSessionScopesEqual(
  a: HostedSessionScope,
  b: HostedSessionScope
): boolean {
  return a.projectId === b.projectId && a.chatboxId === b.chatboxId;
}

function isAuthDeniedError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const withStatus = error as { status?: unknown; message?: unknown };
  if (withStatus.status === 401 || withStatus.status === 403) return true;
  if (typeof withStatus.message !== "string") return false;
  return /\b(401|403)\b|unauthorized|forbidden/i.test(withStatus.message);
}

export function useChatSession(
  options: UseChatSessionOptions
): UseChatSessionReturn {
  const {
    selectedServers,
    directVisibility = "private",
    hostedOrgModelConfig,
    hostedContext,
    minimalMode: _minimalMode = false,
    executionConfig,
    hostStyle,
    onReset,
  } = options;
  // Surfaces that omit `executionConfig` entirely (e.g. Playground) own their
  // chat-execution state imperatively and must not be re-synced from prop
  // defaults. Surfaces that pass `executionConfig` are in controlled mode and
  // get synced on every change — including when an upstream value transiently
  // becomes undefined during host bootstrap, in which case fields fall back to
  // hook defaults rather than retaining the prior host's value.
  const isExecutionConfigControlled = "executionConfig" in options;
  const hostedProjectId = hostedContext?.projectId;
  const hostedSelectedServerIds = hostedContext?.selectedServerIds ?? [];
  const hostedOAuthTokens = hostedContext?.oauthTokens;
  const hostedChatboxId = hostedContext?.chatboxId;
  const hostedAccessVersion = hostedContext?.accessVersion;
  const hostedChatboxSurface = hostedContext?.chatboxSurface;
  // Published-chatbox runtime sessions must use the org-aware web engine
  // on every platform — their servers resolve by Convex id, which the
  // local /api/mcp engine can't connect. See HostedRuntimeContext.
  const hostedRequiresWebChatApi = hostedContext?.requiresWebChatApi === true;
  const requestRefreshAccessVersion =
    hostedContext?.requestRefreshAccessVersion;
  const initialModelId = executionConfig?.modelId;
  const initialSystemPrompt = resolveSystemPrompt(
    executionConfig?.systemPrompt
  );
  const initialTemperature = executionConfig?.temperature ?? 0.7;
  const initialRequireToolApproval =
    executionConfig?.requireToolApproval ?? false;
  const initialRespectToolVisibility =
    executionConfig?.respectToolVisibility ?? true;
  const {
    getAccessToken,
    user: workOsUser,
    isLoading: isWorkOsLoading,
  } = useAuth();

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
  const { isOllamaRunning, ollamaModels } =
    useDetectedOllamaModels(getOllamaBaseUrl);

  // Local state
  const [authHeaders, setAuthHeaders] = useState<
    Record<string, string> | undefined
  >(undefined);
  const [isSessionBootstrapComplete, setIsSessionBootstrapComplete] =
    useState(false);
  const [systemPrompt, setSystemPromptState] = useState(initialSystemPrompt);
  const setSystemPrompt = useCallback((prompt: string) => {
    setSystemPromptState(resolveSystemPrompt(prompt));
  }, []);
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
  const [serializedTools, setSerializedTools] = useState<
    Record<string, SerializedModelRequestTool>
  >({});
  const [persistedSnapshotToolCallIds, setPersistedSnapshotToolCallIds] =
    useState<string[]>([]);
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
    initialRequireToolApproval
  );
  const requireToolApprovalRef = useRef(requireToolApproval);
  requireToolApprovalRef.current = requireToolApproval;

  // Host-level progressive tool discovery toggle. The value comes from the
  // caller — each useChatSession site knows which host config row applies
  // to its chat surface (per-host playground column, per-chatbox session,
  // project default for direct chat, etc.) — and the hook just threads it
  // into the request body. Held in a ref so a mid-session flip is
  // reflected on the very next send without remounting.
  const progressiveToolDiscoveryRef = useRef<boolean | undefined>(undefined);
  // Prefer the top-level option when set (used by paths that don't go
  // through ExecutionConfig — e.g. the playground per-host column), but
  // fall back to executionConfig so direct chat / multi-model surfaces
  // can forward the host's HostConfigV2.progressiveToolDiscovery field
  // through their existing config plumbing without adding a parallel
  // option at every call site.
  progressiveToolDiscoveryRef.current =
    options.progressiveToolDiscovery ??
    options.executionConfig?.progressiveToolDiscovery;
  const [respectToolVisibility, setRespectToolVisibility] = useState(
    initialRespectToolVisibility
  );
  const respectToolVisibilityRef = useRef<boolean>(respectToolVisibility);
  respectToolVisibilityRef.current =
    options.respectToolVisibility ??
    options.executionConfig?.respectToolVisibility ??
    respectToolVisibility;
  // Host-managed built-in tools. Top-level option wins (mirrors the
  // progressiveToolDiscovery / respectToolVisibility pattern), then
  // executionConfig as a fallback for surfaces that thread everything
  // through executionConfig. `undefined` ⇒ no attached built-ins.
  const builtInToolIdsRef = useRef<string[] | undefined>(undefined);
  builtInToolIdsRef.current =
    options.builtInToolIds ?? options.executionConfig?.builtInToolIds;
  const isHostedGuest = HOSTED_MODE && !workOsUser && !isWorkOsLoading;
  const sharedGuestMode =
    isHostedGuest && !isAuthLoading && !!hostedProjectId && !!hostedChatboxId;
  const guestMode = sharedGuestMode;
  const skipNextForkDetectionRef = useRef(false);
  const hasResolvedAuthHeadersRef = useRef(false);
  const lastResolvedAuthHeadersRef = useRef<Record<string, string> | undefined>(
    undefined
  );
  const lastResolvedHostedScopeRef = useRef<HostedSessionScope>({
    projectId: undefined,
    chatboxId: undefined,
  });
  const pendingSessionHydrationRef = useRef<PendingSessionHydration | null>(
    null
  );
  const pendingLiveTraceStateRef = useRef<LiveTraceAccumulatorState | null>(
    null
  );
  const selectedServersSignature = useMemo(
    () => selectedServers.join("\u0000"),
    [selectedServers]
  );
  const apiContextRevision = useSyncExternalStore(
    subscribeApiContext,
    getApiContextRevision,
    getApiContextRevision
  );
  const liveTraceEnvelopeBase = useMemo(
    () => buildLiveTraceEnvelope(liveTraceState),
    [liveTraceState]
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
  const handleStreamDataPart = useCallback((part: unknown) => {
    if (!isTraceEventDataPart(part)) {
      if (isHostedRpcLogDataPart(part)) {
        ingestHostedRpcLogs([part.data]);
      }
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
    []
  );
  const clearPendingSessionHydration = useCallback(() => {
    // Drop any queued trace state so a subsequent resetChat / fork does not
    // re-apply stale hydrated spans to the fresh session when the reset
    // effect reads pendingLiveTraceStateRef.
    pendingLiveTraceStateRef.current = null;
    const pendingHydration = pendingSessionHydrationRef.current;
    if (!pendingHydration) {
      return;
    }

    pendingSessionHydrationRef.current = null;
    pendingHydration.resolve?.();
  }, []);

  // Build available models — the same composition every picker surface
  // uses (see `composeAvailableModels`); only the org-config source is
  // chat-specific (chatbox embeds resolve a host-provided project context).
  const outOfCredits = useOutOfCredits();
  const availableModels = useMemo(
    () =>
      composeAvailableModels({
        orgConfig: hostedOrgModelConfig,
        isAuthenticated,
        isOllamaRunning,
        ollamaModels,
        hasToken,
        getOpenRouterSelectedModels,
        getAzureBaseUrl,
        customProviders,
        outOfCredits,
      }),
    [
      hasToken,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
      getAzureBaseUrl,
      isAuthenticated,
      customProviders,
      hostedOrgModelConfig,
      outOfCredits,
    ]
  );

  // Model selection with persistence
  const {
    selectedModelId,
    setSelectedModelId,
    selectedModelIds,
    setSelectedModelIds,
    multiModelEnabled,
    setMultiModelEnabled,
  } = usePersistedModel();
  const selectableModels = useMemo(
    () => availableModels.filter((model) => !model.disabled),
    [availableModels]
  );
  const selectedModel = useMemo<ModelDefinition>(() => {
    const fallback = getDefaultModel(
      selectableModels.length > 0 ? selectableModels : availableModels
    );
    const resolveAvailableModel = (modelId?: string | null) => {
      if (!modelId) {
        return null;
      }

      return (
        availableModels.find((model) => String(model.id) === modelId) ?? null
      );
    };
    const resolveSelectableModel = (modelId?: string | null) => {
      if (!modelId) {
        return null;
      }

      return (
        availableModels.find(
          (model) =>
            String(model.id) === modelId &&
            // Keep an out-of-credits model selected so the existing send →
            // limit-error → out-of-credits modal still fires. The gray-out
            // must not silently switch the user off it. Other locks (guest,
            // ollama-no-tools) stay unselectable.
            (!model.disabled ||
              model.disabledReason === OUT_OF_CREDITS_MODEL_REASON)
        ) ?? null
      );
    };

    if (initialModelId) {
      return (
        resolveAvailableModel(initialModelId) ??
        createLockedInitialModel(initialModelId)
      );
    }
    if (!selectedModelId) return fallback;
    return resolveSelectableModel(selectedModelId) ?? fallback;
  }, [availableModels, initialModelId, selectableModels, selectedModelId]);

  const setSelectedModel = useCallback(
    (model: ModelDefinition) => {
      if (initialModelId) {
        return;
      }
      setSelectedModelId(String(model.id));
    },
    [initialModelId, setSelectedModelId]
  );

  const isMcpJamModel = useMemo(() => {
    return selectedModel?.id
      ? isMCPJamProvidedModel(String(selectedModel.id))
      : false;
  }, [selectedModel]);
  const selectedModelUsesOrgRuntime = useMemo(
    () => isOrgManagedModel(hostedOrgModelConfig, selectedModel),
    [hostedOrgModelConfig, selectedModel]
  );
  const traceViewsSupported = HOSTED_MODE
    ? isMcpJamModel || selectedModelUsesOrgRuntime
    : true;

  const chatFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // authFetch owns auth resolution (WorkOS bearer / guest bearer via
      // the chatbox-installed apiContext) wherever the web engine is in
      // play — hosted builds, and chatbox runtime sessions on any platform.
      const useAuthedFetch = HOSTED_MODE || hostedRequiresWebChatApi;
      const response = useAuthedFetch
        ? await authFetch(input, init)
        : await fetch(input, init);
      if (!response.ok) {
        await notifyMCPJamLimitErrorFromResponse(response);
        if (useAuthedFetch) {
          await ingestHostedRpcLogsFromResponse(response);
        }
      }
      return response;
    },
    [hostedRequiresWebChatApi]
  );

  const handleChatError = useCallback((chatError: Error) => {
    // Try to recover a structured limitKind from a JSON-shaped error message
    // so the concurrency carve-out is honored on the SSE error path. Best
    // effort: untouched if the message isn't JSON.
    let limitKind: "total" | "concurrency" | undefined;
    const jsonStart = chatError.message.indexOf("{");
    if (jsonStart >= 0) {
      try {
        const parsed = JSON.parse(chatError.message.slice(jsonStart));
        if (parsed && typeof parsed === "object") {
          const value = (parsed as { limitKind?: unknown }).limitKind;
          if (value === "total" || value === "concurrency") {
            limitKind = value;
          }
        }
      } catch {
        // not JSON; ignore
      }
    }
    notifyMCPJamLimitError({ message: chatError.message, limitKind });
  }, []);

  // Create transport
  const pendingWidgetModelContextRef = useRef<
    WidgetModelContextEntry[] | undefined
  >(undefined);

  const transport = useMemo(() => {
    const shouldUseOrgAwareChatApi =
      HOSTED_MODE || selectedModelUsesOrgRuntime || hostedRequiresWebChatApi;
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

    // Merge session auth headers with workos auth headers
    const sessionHeaders = getSessionAuthHeaders();
    const mergedHeaders = { ...sessionHeaders, ...authHeaders } as Record<
      string,
      string
    >;
    // When authFetch carries the request (hosted builds, chatbox runtime
    // sessions), it owns the Authorization header — don't double-attach.
    const transportHeaders =
      HOSTED_MODE || hostedRequiresWebChatApi
        ? undefined
        : Object.keys(mergedHeaders).length > 0
        ? mergedHeaders
        : undefined;

    const chatApi = shouldUseOrgAwareChatApi
      ? "/api/web/chat-v2"
      : "/api/mcp/chat-v2";

    // Hosted dashboard guests and signed-in users both require a project id.
    // Submit is blocked until hostedProjectId and selected server ids resolve.
    const buildHostedBody = () => {
      if (!hostedProjectId) {
        throw new Error("Hosted chat context is not ready: missing projectId.");
      }
      const isHostedDirectChat = !hostedChatboxId;
      const hostedServerBatch = buildResolvedServerBatchRequest({
        projectId: hostedProjectId,
        serverIds: hostedSelectedServerIds,
        serverNames: selectedServers,
        accessScope: "chat_v2",
        ...(isHostedDirectChat &&
        hostedOAuthTokens &&
        Object.keys(hostedOAuthTokens).length > 0
          ? { oauthTokens: hostedOAuthTokens }
          : {}),
        ...(hostedChatboxId ? { chatboxId: hostedChatboxId } : {}),
        ...(hostedChatboxId && Number.isFinite(hostedAccessVersion)
          ? { accessVersion: hostedAccessVersion }
          : {}),
      });
      const {
        serverIds: resolvedServerIds,
        serverNames: resolvedServerNames,
        ...hostedServerBatchPins
      } = hostedServerBatch;
      return {
        ...hostedServerBatchPins,
        selectedServerIds: resolvedServerIds,
        selectedServerNames: resolvedServerNames,
        chatSessionId,
        ...(isHostedDirectChat ? { directVisibility } : {}),
        ...(hostedChatboxId && hostedChatboxSurface
          ? { surface: hostedChatboxSurface }
          : {}),
      };
    };

    return new DefaultChatTransport({
      api: chatApi,
      fetch: chatFetch,
      body: () => {
        const widgetModelContext = pendingWidgetModelContextRef.current;
        pendingWidgetModelContextRef.current = undefined;
        return {
          model: selectedModel,
          ...(shouldUseOrgAwareChatApi ? {} : { apiKey }),
          // Always send the user's slider value. The server's `prepareChatV2`
          // already drops temperature for GPT-5 before the LLM call (its API
          // rejects the field), so what lands here is purely the user's
          // intended config — and ingestion's hostConfig dedupes on it. If we
          // stripped for GPT-5, every GPT-5 direct chat would dedupe to the
          // helper's 0.7 fallback regardless of the slider.
          temperature,
          systemPrompt,
          ...(shouldUseOrgAwareChatApi
            ? buildHostedBody()
            : {
                selectedServers,
                chatSessionId,
                // `directVisibility` only applies to direct chat. The
                // /mcp/chat-v2 route gates it off when chatboxId is present
                // (owner-preview persists as `sourceType: "chatbox"`), but
                // omitting it client-side keeps the body honest about the
                // session kind.
                ...(hostedChatboxId ? {} : { directVisibility }),
                // Pass projectId for BYOK direct-chat history persistence
                ...(hostedProjectId ? { projectId: hostedProjectId } : {}),
                // Convex server Ids parallel to `selectedServers`. Only sent
                // when every name resolved to an Id — a partial mapping would
                // hash to a different hostConfig than intended. Without this,
                // the MCP route can't safely emit `hostConfig` because local
                // server *names* aren't valid Convex Ids and the backend
                // validator would reject the whole ingest call.
                ...(hostedSelectedServerIds.length === selectedServers.length
                  ? { selectedServerIds: hostedSelectedServerIds }
                  : {}),
                // Phase F: owner-preview / local chatbox sessions persist as
                // `sourceType: "chatbox"`. Without forwarding the resolved
                // chatbox identity here, /mcp/chat-v2 derives sourceType
                // from absent fields and the chat is filed as a direct chat
                // instead of a chatbox session.
                ...(hostedChatboxId ? { chatboxId: hostedChatboxId } : {}),
                ...(hostedChatboxId && Number.isFinite(hostedAccessVersion)
                  ? { accessVersion: hostedAccessVersion }
                  : {}),
                ...(hostedChatboxId && hostedChatboxSurface
                  ? { surface: hostedChatboxSurface }
                  : {}),
                ...(selectedModel.provider === "ollama"
                  ? { ollamaBaseUrl: getOllamaBaseUrl() }
                  : {}),
                ...(selectedModel.provider === "azure"
                  ? { azureBaseUrl: getAzureBaseUrl() }
                  : {}),
              }),
          requireToolApproval: requireToolApprovalRef.current,
          respectToolVisibility: respectToolVisibilityRef.current,
          // Only send when the user explicitly set the host-level toggle.
          // Omitting the field tells the backend orchestrator to use its
          // auto policy (currently: off for hosted unless the env override
          // is set). Backend hashes undefined / true / false distinctly so
          // round-trips preserve the user's choice.
          ...(progressiveToolDiscoveryRef.current !== undefined
            ? { progressiveToolDiscovery: progressiveToolDiscoveryRef.current }
            : {}),
          // Phase 3: forward the chat tab's resolved host style so
          // direct chat traces persist with a real `claude`/`chatgpt`
          // hostStyle (no more legacy `'direct'`). Omitted body falls
          // back to the backend default of `'claude'`.
          ...(hostStyle ? { hostStyle } : {}),
          ...(!shouldUseOrgAwareChatApi && customProviders.length > 0
            ? { customProviders }
            : {}),
          ...(resumedVersionRef.current !== null
            ? { expectedVersion: resumedVersionRef.current }
            : {}),
          // Host-managed built-in tools (e.g. ["web_search"]). Forwarded only
          // when non-empty so pre-feature traces stay byte-identical. The
          // chatbox path overrides this with the persisted host config server-
          // side; playground trusts this value (same as systemPrompt etc.).
          ...(builtInToolIdsRef.current && builtInToolIdsRef.current.length > 0
            ? { builtInToolIds: builtInToolIdsRef.current }
            : {}),
          // SEP-1865 App-Provided Tools snapshot. Drained fresh at POST time
          // (no memoization) so any iframe that mounted between the previous
          // turn and this send contributes its tools. The registry caps size;
          // the server defends the boundary again in `validateAppToolEntries`.
          appTools: useAppToolsRegistry
            .getState()
            .snapshotForChatBody(chatSessionIdRef.current),
          ...(widgetModelContext && widgetModelContext.length > 0
            ? { widgetModelContext }
            : {}),
        };
      },
      headers: transportHeaders,
    });
  }, [
    selectedModel,
    getToken,
    getCustomProviderByName,
    customProviders,
    authHeaders,
    selectedModelUsesOrgRuntime,
    hostedRequiresWebChatApi,
    temperature,
    systemPrompt,
    selectedServers,
    directVisibility,
    hostedProjectId,
    chatSessionId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    hostedChatboxId,
    hostedAccessVersion,
    hostedChatboxSurface,
    getOllamaBaseUrl,
    getAzureBaseUrl,
    hostStyle,
    chatFetch,
    // requireToolApproval read from ref at request time
  ]);
  // `@ai-sdk/react` only recreates its internal Chat when the chat id changes.
  // Keep one stable transport object so server-selection changes affect the
  // next request without forcing a new thread.
  const latestTransportRef = useRef<ChatTransport<UIMessage>>(transport);
  latestTransportRef.current = transport;
  const proxyTransport = useMemo<ChatTransport<UIMessage>>(
    () => ({
      sendMessages: (options) =>
        latestTransportRef.current.sendMessages(options),
      reconnectToStream: (options) =>
        latestTransportRef.current.reconnectToStream(options),
    }),
    []
  );

  // useChat hook
  const {
    messages,
    sendMessage: baseSendMessage,
    stop,
    status,
    error,
    setMessages: baseSetMessages,
    addToolApprovalResponse,
    addToolOutput,
  } = useChat({
    id: chatSessionId,
    transport: proxyTransport,
    onData: handleStreamDataPart,
    onError: handleChatError,
    // SEP-1865 App-Provided Tools: AI SDK v6 IGNORES the return value of
    // `onToolCall`. Tool results must be supplied imperatively via
    // `addToolOutput(...)`. Server-tool calls bypass this handler (they
    // resolve via the server's `execute` function); only client-fulfilled
    // app aliases land here.
    onToolCall: async ({ toolCall }) => {
      const toolName = (toolCall as { toolName: string }).toolName;
      const entry = useAppToolsRegistry
        .getState()
        .resolve(toolName, chatSessionIdRef.current);
      if (!entry) {
        // Two cases:
        //   - server tool name: not an app alias, let the server's
        //     execute path handle it (return without touching state).
        //   - app alias with no live bridge: snapshot shipped this
        //     alias, then the iframe was torn down before the model's
        //     tool-call landed. Per SEP-1865 "Calling a tool from a
        //     closed app MUST return an error" — we must resolve the
        //     call here or the server loop pauses forever waiting for a
        //     client-fulfilled result that never comes.
        if (!APP_TOOL_ALIAS_REGEX.test(toolName)) return;
        addToolOutput({
          tool: toolName,
          toolCallId: (toolCall as { toolCallId: string }).toolCallId,
          output: {
            content: [
              {
                type: "text",
                text: "App is no longer available — the widget was closed before the tool call landed.",
              },
            ],
            isError: true,
          },
        } as Parameters<typeof addToolOutput>[0]);
        return;
      }
      const tc = toolCall as {
        toolName: string;
        toolCallId: string;
        input: unknown;
      };
      // Scroll the target iframe into view BEFORE dispatching so the user
      // can see the visual mutation the app makes in response. Skip when
      // the tab is backgrounded (scrollIntoView is wasted) or when the
      // iframe is already comfortably in viewport (avoid jitter on every
      // tool call in an already-focused chat). Best-effort: any failure
      // here must not block dispatch.
      //
      // Two non-obvious bits:
      // - `block: "start"` (not "nearest"). For iframes taller than the
      //   viewport, "nearest" treats a sliver of the bottom edge as "near
      //   enough" and refuses to scroll. "start" anchors the iframe top
      //   to the viewport top so the just-mutated content actually
      //   becomes prominent.
      // - `requestAnimationFrame` defers the scroll one paint so it
      //   runs AFTER the chat thread's auto-scroll-to-latest effect
      //   commits on the new tool-call row. Without the rAF, chat's
      //   auto-scroll fires last and silently overrides ours.
      try {
        if (!document.hidden) {
          const iframe = entry.instance.getIframeElement?.();
          if (iframe) {
            const rect = iframe.getBoundingClientRect();
            const viewportHeight =
              window.innerHeight || document.documentElement.clientHeight;
            const fullyInView =
              rect.top >= 0 && rect.bottom <= viewportHeight && rect.height > 0;
            if (!fullyInView) {
              requestAnimationFrame(() => {
                iframe.scrollIntoView({
                  behavior: "smooth",
                  block: "start",
                });
              });
            }
          }
        }
      } catch {
        // Non-fatal; proceed to dispatch.
      }
      // SEP-1865 in-flight teardown cancellation: register an
      // AbortController against this bridge's pending set BEFORE awaiting
      // `bridge.callTool`. If the iframe is torn down mid-await,
      // `unregisterInstance` aborts the controller and the race rejects,
      // letting the catch branch resolve the tool call with `isError`.
      // Without this, a server stream paused on this tool call would hang
      // forever waiting for a client-fulfilled result.
      const controller = new AbortController();
      const registry = useAppToolsRegistry.getState();
      registry.registerPendingCall(entry.instance.bridgeId, controller);
      try {
        const call = entry.bridge.callTool({
          name: entry.rawName,
          arguments:
            tc.input && typeof tc.input === "object"
              ? (tc.input as Record<string, unknown>)
              : {},
        });
        const raw = await new Promise<
          Awaited<ReturnType<typeof entry.bridge.callTool>>
        >((resolve, reject) => {
          const onAbort = () =>
            reject(new Error("App iframe was torn down mid-dispatch"));
          if (controller.signal.aborted) {
            onAbort();
            return;
          }
          controller.signal.addEventListener("abort", onAbort, { once: true });
          call.then(resolve, reject);
        });
        const sanitized = scrubAppToolResultForModel(raw);
        recordAppToolInvocation(
          {
            alias: tc.toolName,
            rawName: entry.rawName,
            appName: entry.instance.appName,
            serverId: entry.instance.serverId,
            parentToolCallId: entry.instance.parentToolCallId,
            bridgeId: entry.instance.bridgeId,
            input: tc.input,
            raw,
          },
          useTrafficLogStore.getState().addLog,
        );
        addToolOutput({
          tool: tc.toolName,
          toolCallId: tc.toolCallId,
          output: sanitized,
        } as Parameters<typeof addToolOutput>[0]);
      } catch (err) {
        addToolOutput({
          tool: tc.toolName,
          toolCallId: tc.toolCallId,
          output: {
            content: [
              {
                type: "text",
                text: `App tool failed: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              },
            ],
            isError: true,
          },
        } as Parameters<typeof addToolOutput>[0]);
      } finally {
        registry.unregisterPendingCall(entry.instance.bridgeId, controller);
      }
    },
    // Combine the approval predicate (existing) with the no-execute
    // tool-call predicate (new). App-aliased tool calls are completed by
    // our `onToolCall` above; that triggers an auto-send which carries
    // the new tool results back to the server so the agent loop resumes.
    // Both AI SDK helpers take the options object: `({ messages }) => …`.
    sendAutomaticallyWhen: (options) => {
      if (lastAssistantMessageIsCompleteWithToolCalls(options)) return true;
      if (
        requireToolApproval &&
        lastAssistantMessageIsCompleteWithApprovalResponses(options)
      ) {
        return true;
      }
      return false;
    },
  });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const queueSessionHydration = useCallback(
    (hydration: PendingSessionHydration) => {
      clearPendingSessionHydration();

      // `undefined` means the caller doesn't have authoritative trace data
      // yet (e.g. the Convex query is still loading, or the paired backend
      // function is not deployed). In that case we preserve whatever live
      // trace state already exists rather than wiping it. An empty array
      // means "definitively zero persisted traces" and does empty the state.
      const hydratedTraceState =
        hydration.turnTraces !== undefined
          ? hydration.turnTraces.length > 0
            ? buildLiveTraceStateFromTurnTraces(hydration.turnTraces)
            : createEmptyLiveTraceState()
          : null;

      // If the chatSessionId is already the target value, setChatSessionId
      // would be a no-op and the useLayoutEffect that processes the pending
      // hydration would never fire.  Apply the hydration directly instead.
      if (hydration.sessionId === chatSessionIdRef.current) {
        // Same-session history hydration may return equivalent messages with
        // persisted IDs. Preserve matching live IDs so React updates widgets
        // in place instead of remounting iframes keyed by the parent message.
        baseSetMessages(
          preserveHydratedMessageIds(messagesRef.current, hydration.messages)
        );
        syncResumedVersion(hydration.resumedVersion);
        syncRestoredToolRenderOverrides(hydration.toolRenderOverrides ?? {});
        setPersistedSnapshotToolCallIds(
          hydration.persistedSnapshotToolCallIds ?? []
        );
        if (hydratedTraceState !== null) {
          setLiveTraceState(hydratedTraceState);
        }
        setHydrationTick((t) => t + 1);
        return Promise.resolve();
      }

      pendingLiveTraceStateRef.current = hydratedTraceState;

      return new Promise<void>((resolve) => {
        pendingSessionHydrationRef.current = {
          ...hydration,
          resolve,
        };
        setChatSessionId(hydration.sessionId);
      });
    },
    [clearPendingSessionHydration, baseSetMessages, syncResumedVersion]
  );

  const [traceTranscriptFromUi, setTraceTranscriptFromUi] = useState<
    ModelMessage[] | null
  >(null);

  useEffect(() => {
    const persistent = messages.filter(
      (message) => !isTransientMessage(message)
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
      { ignoreIncompleteToolCalls: true }
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
      400
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
    const merged = mergePreviewSpansIntoLiveEnvelope(
      liveTraceEnvelopeBase,
      liveTraceState,
      previewWallElapsedMs,
      traceTranscriptFromUi
    );
    // Rehydrated sessions arrive with `state.messages = []` (see
    // buildLiveTraceStateFromTurnTraces), so the envelope's messages stay
    // empty and the trace timeline can't resolve tool input/output. Fill
    // them in from the converted UI transcript whenever it has more
    // entries — same picker the preview path uses for live sessions.
    const transcript = pickTranscriptForLiveTracePreview({
      snapshotMessages: merged.messages,
      transcriptFromUi: traceTranscriptFromUi,
    });
    return transcript === merged.messages
      ? merged
      : { ...merged, messages: transcript };
  }, [
    liveTraceEnvelopeBase,
    liveTraceState,
    previewWallElapsedMs,
    traceTranscriptFromUi,
  ]);
  const hasLiveTimelineContent =
    livePreviewSpanCount > 0 || (liveTraceEnvelope?.spans?.length ?? 0) > 0;

  /**
   * Live SSE produces a `request_payload` event per turn; rehydrated stored
   * sessions never replay it, so the Raw view would have nothing to render.
   * When there's no live history but we have a converted transcript, synthesize
   * a single entry from current `systemPrompt` + currently-resolved tool
   * schemas + the rehydrated thread. This intentionally reflects what would
   * be sent if the user typed next — tool schemas may differ from when the
   * session originally ran, since they're fetched from currently-connected
   * servers.
   */
  const requestPayloadHistory = useMemo<
    LiveChatTraceRequestPayloadEntry[]
  >(() => {
    const live = liveTraceState.requestPayloadHistory;
    if (live.length > 0) {
      return live;
    }
    if (!traceTranscriptFromUi || traceTranscriptFromUi.length === 0) {
      return live;
    }
    return [
      {
        turnId: "rehydrated",
        promptIndex: 0,
        stepIndex: 0,
        payload: {
          system: systemPrompt ?? "",
          tools: serializedTools,
          messages: traceTranscriptFromUi,
        },
      },
    ];
  }, [
    liveTraceState.requestPayloadHistory,
    traceTranscriptFromUi,
    systemPrompt,
    serializedTools,
  ]);

  // useLayoutEffect (not useEffect) so the trace state is swapped out
  // before the browser paints the new chatSessionId render, preventing a
  // flash of the previous session's live-trace envelope on session switch
  // or fork.
  useLayoutEffect(() => {
    const hydratedState = pendingLiveTraceStateRef.current;
    pendingLiveTraceStateRef.current = null;
    setLiveTraceState(hydratedState ?? createEmptyLiveTraceState());
  }, [chatSessionId]);

  useSharedChatWidgetCapture({
    // Chatbox runtime sessions persist server-side on every platform, so
    // their widget capture follows the session kind, not the build.
    enabled: (HOSTED_MODE || hostedRequiresWebChatApi) && isAuthenticated,
    readyToPersist: status === "ready",
    chatSessionId,
    hostedChatboxId,
    hostedAccessVersion,
    persistedSnapshotToolCallIds,
    messages,
    onStaleHostedAccess: requestRefreshAccessVersion,
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
            persistedSnapshotToolCallIds: [],
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
    [baseSetMessages]
  );

  useLayoutEffect(() => {
    const pendingHydration = pendingSessionHydrationRef.current;
    if (!pendingHydration || pendingHydration.sessionId !== chatSessionId) {
      return;
    }

    pendingSessionHydrationRef.current = null;

    baseSetMessages(pendingHydration.messages);
    syncResumedVersion(pendingHydration.resumedVersion);
    syncRestoredToolRenderOverrides(pendingHydration.toolRenderOverrides ?? {});
    setPersistedSnapshotToolCallIds(
      pendingHydration.persistedSnapshotToolCallIds ?? []
    );
    // Force a React state update so that useSyncExternalStore re-reads the
    // messages snapshot that was just written to the Chat store above.
    // Without this, the external-store change made by baseSetMessages may
    // not trigger a re-render when syncResumedVersion is a no-op (same
    // version value as before).
    setHydrationTick((t) => t + 1);
    pendingHydration.resolve?.();
  }, [
    baseSetMessages,
    chatSessionId,
    syncResumedVersion,
    syncRestoredToolRenderOverrides,
  ]);

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
      metadata?: Record<string, unknown>;
      widgetModelContext?: WidgetModelContextEntry[];
    }) => {
      const { text, files, metadata, widgetModelContext } = options;
      const extra = metadata ? ({ metadata } as { metadata: unknown }) : {};
      pendingWidgetModelContextRef.current =
        widgetModelContext && widgetModelContext.length > 0
          ? widgetModelContext
          : undefined;
      try {
        if (files && files.length > 0) {
          // AI SDK accepts FileUIPart[] with data URLs
          baseSendMessage({ text, files, ...extra });
        } else {
          baseSendMessage({ text, ...extra });
        }
      } catch (error) {
        pendingWidgetModelContextRef.current = undefined;
        throw error;
      }
    },
    [baseSendMessage]
  );

  // Reset chat
  const resetChat = useCallback(() => {
    skipNextForkDetectionRef.current = true;
    clearPendingSessionHydration();
    setChatSessionId(generateId());
    setMessages([]);
    setPersistedSnapshotToolCallIds([]);
    syncResumedVersion(null);
    syncRestoredToolRenderOverrides({});
    onResetRef.current?.("reset");
  }, [
    clearPendingSessionHydration,
    setMessages,
    syncResumedVersion,
    syncRestoredToolRenderOverrides,
  ]);

  const startChatWithMessages = useCallback(
    (
      messages: UIMessage[],
      options?: {
        resetReason?: ChatSessionResetReason;
        toolRenderOverrides?: Record<string, ToolRenderOverride>;
      }
    ) => {
      skipNextForkDetectionRef.current = true;
      // Return the hydration promise so callers can chain work that must run
      // AFTER the seeded messages are applied (e.g. the eval handoff sending a
      // widget's `ui/message` follow-up so the model replies to the seeded
      // conversation). Existing callers ignore the return value.
      const hydrationPromise = queueSessionHydration({
        sessionId: generateId(),
        messages,
        resumedVersion: null,
        toolRenderOverrides: options?.toolRenderOverrides,
        persistedSnapshotToolCallIds: [],
      });
      onResetRef.current?.(options?.resetReason ?? "fork");
      return hydrationPromise;
    },
    [queueSessionHydration]
  );

  const loadChatSession = useCallback(
    async (
      session: {
        chatSessionId: string;
        messagesBlobUrl: string | null;
        resumeConfig?: {
          systemPrompt?: string;
          temperature?: number;
          requireToolApproval?: boolean;
          respectToolVisibility?: boolean;
          selectedServers?: string[];
        };
        version: number;
        widgetSnapshots?: PersistedWidgetSnapshot[];
        turnTraces?: Array<{
          turnId: string;
          promptIndex: number;
          startedAt: number;
          endedAt: number;
          finishReason?: string;
          usage?: LiveChatTraceUsage;
          spansBlobUrl?: string | null;
          modelId?: string;
        }>;
      },
      options?: {
        shouldRestoreResumeConfig?: () => boolean;
        shouldApply?: () => boolean;
      }
    ) => {
      let uiMessages: UIMessage[] = [];

      if (session.messagesBlobUrl) {
        // Goes through the dedup cache so a hover-prefetched blob is reused
        // by the click path. Throws on non-OK responses internally.
        const transcript = (await getCachedBlobJson(
          session.messagesBlobUrl
        )) as unknown[];
        uiMessages = transcriptToUIMessages(transcript);
      }

      // Build toolRenderOverrides from widget snapshots if available
      let overrides: Record<string, ToolRenderOverride> = {};
      const hydratedWidgetSnapshots = await resolveHydratedWidgetSnapshots(
        session.widgetSnapshots
      );
      const persistedSnapshotToolCallIds =
        hydratedWidgetSnapshots?.map((snapshot) => snapshot.toolCallId) ?? [];
      if (hydratedWidgetSnapshots && hydratedWidgetSnapshots.length > 0) {
        const traceSnapshots = snapshotsToTraceWidgetSnapshots(
          hydratedWidgetSnapshots
        );
        // In-flow session revisit: prefer the live MCP Apps fetch over the
        // cached snapshot HTML so the widget re-renders against the active
        // host's current CSP / bridge state. The cached path is kept for
        // OpenAI Apps and degenerate mcp-apps snapshots that can't live-fetch.
        overrides = buildToolRenderOverridesFromSnapshots(traceSnapshots, {
          preferLiveWhenPossible: true,
        });
      }

      const hydratedTurnTraces = await resolveHydratedTurnTraces(
        session.turnTraces
      );

      if (options?.shouldApply && !options.shouldApply()) {
        return;
      }

      if (options?.shouldRestoreResumeConfig?.() ?? true) {
        if (session.resumeConfig?.systemPrompt !== undefined) {
          setSystemPrompt(session.resumeConfig.systemPrompt);
        }
        if (session.resumeConfig?.temperature !== undefined) {
          setTemperature(session.resumeConfig.temperature);
        }
        if (session.resumeConfig?.requireToolApproval !== undefined) {
          setRequireToolApproval(session.resumeConfig.requireToolApproval);
        }
        if (session.resumeConfig?.respectToolVisibility !== undefined) {
          setRespectToolVisibility(session.resumeConfig.respectToolVisibility);
        }
      }

      if (options?.shouldApply && !options.shouldApply()) {
        return;
      }

      skipNextForkDetectionRef.current = true;
      await queueSessionHydration({
        sessionId: session.chatSessionId,
        messages: uiMessages,
        resumedVersion: session.version,
        toolRenderOverrides: overrides,
        persistedSnapshotToolCallIds,
        turnTraces: hydratedTurnTraces,
      });
      onResetRef.current?.("hydrate");
    },
    [queueSessionHydration, setSystemPrompt]
  );

  // When controlled, mirror `executionConfig` fields into local state; when
  // a field is undefined, reset to the hook default rather than retaining
  // the prior host's value (e.g. ChatTabV2 callers pass `executionConfig`
  // computed from `activeHost`, which is transiently undefined during
  // project/host bootstrap). When uncontrolled (Playground), skip — the
  // caller drives these via imperative setters and would otherwise race
  // the sync.
  const executionSystemPrompt = executionConfig?.systemPrompt;
  const executionTemperature = executionConfig?.temperature;
  const executionRequireToolApproval = executionConfig?.requireToolApproval;
  const executionRespectToolVisibility = executionConfig?.respectToolVisibility;
  useEffect(() => {
    if (!isExecutionConfigControlled) return;
    setSystemPrompt(executionSystemPrompt ?? DEFAULT_SYSTEM_PROMPT);
  }, [isExecutionConfigControlled, executionSystemPrompt, setSystemPrompt]);

  useEffect(() => {
    if (!isExecutionConfigControlled) return;
    setTemperature(executionTemperature ?? 0.7);
  }, [isExecutionConfigControlled, executionTemperature]);

  useEffect(() => {
    if (!isExecutionConfigControlled) return;
    setRequireToolApproval(executionRequireToolApproval ?? false);
  }, [isExecutionConfigControlled, executionRequireToolApproval]);

  useEffect(() => {
    if (!isExecutionConfigControlled) return;
    // Default to the spec-default `true` when the host config doesn't set
    // the field (legacy rows). Matches `emptyHostConfigInputV2`.
    setRespectToolVisibility(executionRespectToolVisibility ?? true);
  }, [isExecutionConfigControlled, executionRespectToolVisibility]);

  // Auth headers setup - reset chat after auth changes to ensure transport has correct headers
  useEffect(() => {
    let active = true;
    setIsSessionBootstrapComplete(false);
    (async () => {
      let resolved = false;
      let resolvedAuthHeaders: Record<string, string> | undefined;

      try {
        const token = await getAccessToken?.();
        if (!active) return;
        if (token) {
          resolvedAuthHeaders = { Authorization: `Bearer ${token}` };
          setAuthHeaders(resolvedAuthHeaders);
          resolved = true;
        }
      } catch {
        // getAccessToken threw (e.g. LoginRequiredError) — not authenticated
      }

      // In non-hosted mode, attach a guest bearer so local chat persistence and
      // history lookups use the same Convex identity as the active thread.
      // In hosted mode, only fall back to guest auth for explicit guest
      // surfaces. A regular hosted project should never silently downgrade.
      if (!resolved && active && !HOSTED_MODE) {
        const guestToken = await getGuestBearerToken();
        if (!active) return;
        if (guestToken) {
          resolvedAuthHeaders = { Authorization: `Bearer ${guestToken}` };
          setAuthHeaders(resolvedAuthHeaders);
          resolved = true;
        } else {
          resolvedAuthHeaders = undefined;
          setAuthHeaders(undefined);
        }
      } else if (!resolved && active && HOSTED_MODE && isHostedGuest) {
        const guestToken = await getGuestBearerToken();
        if (!active) return;
        if (guestToken) {
          resolvedAuthHeaders = { Authorization: `Bearer ${guestToken}` };
          setAuthHeaders(resolvedAuthHeaders);
          resolved = true;
        } else {
          resolvedAuthHeaders = undefined;
          setAuthHeaders(undefined);
        }
      } else if (!resolved && active) {
        resolvedAuthHeaders = undefined;
        setAuthHeaders(undefined);
      }

      // Only reset chat state when the resolved auth headers actually changed.
      // The first bootstrap pass always transitions undefined → resolved, but
      // there is no prior session to invalidate (chatSessionId is freshly
      // generated, messages are empty, no hydration has run). Resetting here
      // would race with state injected during the async resolution — for
      // example CLI `tools call --ui` commands that arrive while the guest
      // bearer fetch is still in flight, whose injected messages would be
      // wiped by setMessages([]).
      if (active) {
        const previousAuthHeaders = lastResolvedAuthHeadersRef.current;
        const previousHostedScope = lastResolvedHostedScopeRef.current;
        const currentHostedScope = {
          projectId: hostedProjectId,
          chatboxId: hostedChatboxId,
        };
        const hasResolvedBefore = hasResolvedAuthHeadersRef.current;
        const authHeadersChanged =
          hasResolvedBefore &&
          !areAuthHeadersEqual(previousAuthHeaders, resolvedAuthHeaders);
        const hostedScopeChanged =
          hasResolvedBefore &&
          !areHostedSessionScopesEqual(previousHostedScope, currentHostedScope);

        if (authHeadersChanged || hostedScopeChanged) {
          invalidateChatHistoryPrefetch();
          skipNextForkDetectionRef.current = true;
          clearPendingSessionHydration();
          setChatSessionId(generateId());
          setMessages([]);
          setPersistedSnapshotToolCallIds([]);
          syncResumedVersion(null);
          syncRestoredToolRenderOverrides({});
          onResetRef.current?.("auth-bootstrap");
        }

        hasResolvedAuthHeadersRef.current = true;
        lastResolvedAuthHeadersRef.current = resolvedAuthHeaders;
        lastResolvedHostedScopeRef.current = currentHostedScope;
        setIsSessionBootstrapComplete(true);
      }
    })();
    return () => {
      active = false;
    };
    // `hostedAccessVersion` is intentionally excluded. The effect resets
    // `isSessionBootstrapComplete` to `false` synchronously on every run;
    // including a value that bumps on every silent re-redeem (the
    // `chatbox_access_stale` recovery path) would flip the flag false →
    // true on each refresh, briefly unmounting downstream consumers gated
    // on it (ChatTabV2). Auth-header resolution doesn't depend on the
    // version, and the scope-equality check inside the effect no longer
    // reads it either, so the effect body is exhaustive-deps-clean
    // without it.
  }, [
    getAccessToken,
    hostedChatboxId,
    hostedProjectId,
    isAuthenticated,
    isHostedGuest,
    workOsUser,
    clearPendingSessionHydration,
    setMessages,
    syncResumedVersion,
    syncRestoredToolRenderOverrides,
  ]);

  // Fetch tools metadata
  useEffect(() => {
    const fetchToolsMetadata = async () => {
      if (selectedServers.length === 0) {
        setToolsMetadata((previous) =>
          Object.keys(previous).length > 0 ? {} : previous
        );
        setToolServerMap((previous) =>
          Object.keys(previous).length > 0 ? {} : previous
        );
        setSerializedTools((previous) =>
          Object.keys(previous).length > 0 ? {} : previous
        );
        setMcpToolsTokenCount((previous) =>
          previous !== null ? null : previous
        );
        setMcpToolsTokenCountLoading((previous) =>
          previous ? false : previous
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
        const { metadata, toolServerMap, serializedTools, tokenCounts } =
          await getToolsMetadata(selectedServers, modelIdForTokens);
        setToolsMetadata(metadata);
        setToolServerMap(toolServerMap);
        setSerializedTools(serializedTools);
        setMcpToolsTokenCount(
          tokenCounts && Object.keys(tokenCounts).length > 0
            ? tokenCounts
            : null
        );
      } catch (error) {
        if (!(hostedChatboxId && isAuthDeniedError(error))) {
          console.warn(
            "[useChatSession] Failed to fetch tools metadata:",
            error
          );
        }
        setToolsMetadata({});
        setToolServerMap({});
        setSerializedTools({});
        setMcpToolsTokenCount(null);
      } finally {
        setMcpToolsTokenCountLoading(false);
      }
    };

    fetchToolsMetadata();
  }, [
    selectedServersSignature,
    selectedModel,
    hostedChatboxId,
    apiContextRevision,
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
        if (!(hostedChatboxId && isAuthDeniedError(error))) {
          console.warn(
            "[useChatSession] Failed to count system prompt tokens:",
            error
          );
        }
        setSystemPromptTokenCount(null);
      } finally {
        setSystemPromptTokenCountLoading(false);
      }
    };

    fetchSystemPromptTokenCount();
  }, [systemPrompt, selectedModel, hostedChatboxId]);

  const previousSelectedServersRef = useRef<string[]>(selectedServers);
  useEffect(() => {
    const previousNames = previousSelectedServersRef.current;
    const currentNames = selectedServers;
    const hasChanged =
      previousNames.length !== currentNames.length ||
      previousNames.some((name, index) => name !== currentNames[index]);

    if (hasChanged) {
      onResetRef.current?.("servers-changed");
    }

    previousSelectedServersRef.current = currentNames;
  }, [selectedServers]);

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
  // Compute share/chatbox guest access from React state instead of the global
  // apiContext.
  // In hosted mode: always require auth (guest JWT or WorkOS — handled by authFetch).
  // In non-hosted mode: auth is needed for org-managed BYOK and sign-in-only MCPJam models.
  const requiresAuthForChat = HOSTED_MODE
    ? true
    : selectedModelUsesOrgRuntime ||
      (isMcpJamModel &&
        !isMCPJamGuestAllowedModel(String(selectedModel?.id ?? "")));
  const isAuthReady =
    !requiresAuthForChat || guestMode || (isAuthenticated && !!authHeaders);
  // Guest users don't need WorkOS auth — authFetch handles guest bearer tokens
  const disableForAuthentication =
    !isAuthenticated && requiresAuthForChat && !guestMode;
  const authHeadersNotReady =
    requiresAuthForChat && isAuthenticated && !authHeaders;
  const hostedContextNotReady =
    (HOSTED_MODE || selectedModelUsesOrgRuntime || hostedRequiresWebChatApi) &&
    (!hostedProjectId ||
      (selectedServers.length > 0 &&
        hostedSelectedServerIds.length !== selectedServers.length));
  const isStreaming = status === "streaming" || status === "submitted";
  const submitBlocked =
    disableForAuthentication ||
    isAuthLoading ||
    authHeadersNotReady ||
    hostedContextNotReady;
  const inputDisabled = submitBlocked;

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
    requestPayloadHistory,
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
