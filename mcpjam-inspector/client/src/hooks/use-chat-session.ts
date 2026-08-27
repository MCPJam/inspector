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
import { toast } from "sonner";
import {
  convertToModelMessages,
  type ChatTransport,
  DefaultChatTransport,
  generateId,
  getToolName,
  isToolUIPart,
  lastAssistantMessageIsCompleteWithApprovalResponses,
  lastAssistantMessageIsCompleteWithToolCalls,
  type ModelMessage,
} from "ai";
import { lastStepHasPendingApproval } from "@/lib/chat-auto-resume";
import {
  useAppToolsRegistry,
  recordAppToolInvocation,
} from "@/components/chat-v2/thread/mcp-apps/app-tools-registry";
import { scrubAppToolResultForModel } from "@/components/chat-v2/thread/mcp-apps/app-tools-sanitizer";
import {
  beginChatTurnScopeStepUpHold,
  driveChatScopeStepUp,
  endChatTurnScopeStepUpHold,
  resetScopeStepUp,
  resolveScopeStepUpServer,
} from "@/lib/scope-step-up";
import { getChatHistoryDetail } from "@/lib/apis/web/chat-history-api";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvex, useConvexAuth } from "convex/react";
import { ModelDefinition, type ModelProvider } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
import { useCustomProviders } from "@/hooks/use-custom-providers";
import { usePersistedModel } from "@/hooks/use-persisted-model";
import { saveLastOwnProviderModelId } from "@/lib/selected-model-storage";
import {
  getDefaultModel,
  isMCPJamProvidedModelMenuItem,
  type OrgVisibleConfig,
} from "@/components/chat-v2/shared/model-helpers";
import {
  GUEST_LOCKED_MODEL_REASON,
  OUT_OF_CREDITS_MODEL_REASON,
  composeAvailableModels,
} from "@/components/chat-v2/shared/available-models";
import { useOutOfCredits } from "@/hooks/useCreditBalance";
import { isMCPJamGuestAllowedModel } from "@/shared/types";
import { providerForModelId } from "@/shared/model-provider";
import { useDetectedOllamaModels } from "@/hooks/use-detected-ollama-models";
import { useHostedModelCatalog } from "@/hooks/use-hosted-model-catalog";
import { DEFAULT_SYSTEM_PROMPT } from "@/components/chat-v2/shared/chat-helpers";
import { getToolsMetadata, ToolServerMap } from "@/lib/apis/mcp-tools-api";
import type { SerializedModelRequestTool } from "@/shared/model-request-payload";
import { countTextTokens } from "@/lib/apis/mcp-tokenizer-api";
import {
  authFetch,
} from "@/lib/session-token";
import {
  classifyScenarioAccessResponse,
  patchBodyAccessVersion,
} from "@/lib/scenario-access-errors";
import {
  notifyMCPJamLimitError,
  notifyMCPJamLimitErrorFromResponse,
} from "@/lib/mcpjam-limit";
import {
  reportChatFailure,
  type ChatResponseMeta,
} from "@/lib/chat-error-reporting";
import { getGuestBearerToken } from "@/lib/guest-session";
import { HOSTED_MODE } from "@/lib/config";
import { LOCAL_CONSENT_HEADER } from "@/lib/local-computer-consent";
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
  ingestHostedHttpLogs,
  ingestHostedRpcLogs,
  useTrafficLogStore,
} from "@/stores/traffic-log-store";
import type { EvalTraceSpan } from "@/shared/eval-trace";
import type { ChatRewind, WidgetModelContextEntry } from "@/shared/chat-v2";
import {
  isScopeStepUpDataPart,
  isScopeStepUpFinishedDataPart,
} from "@/shared/scope-step-up";
import {
  claimCancelledChatScopeStepUp,
  claimPendingChatScopeStepUp,
  clearPendingChatScopeStepUp,
  readPendingChatScopeStepUp,
  savePendingChatScopeStepUp,
} from "@/lib/scope-step-up-pending";
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
import {
  isHostedHttpLogDataPart,
  isHostedRpcLogDataPart,
} from "@/shared/hosted-rpc-log";
import {
  HOSTED_ELICITATION_VERSION,
  isHostedElicitationDataPart,
  type HostedElicitationAction,
  type HostedElicitationRequestEvent,
  type HostedElicitationUrlRequiredEvent,
} from "@/shared/hosted-elicitation";
import {} from "@/state/oauth-orchestrator";
import {
  deferPageToolCallForApproval,
  snapshotPageToolsForTurn,
} from "@/lib/webmcp-inspector/chat-dispatch";
import { createUiAwareApprovalResponseHandler } from "@/lib/webmcp/ui-tool-approval";
import { respondToChatElicitation } from "@/lib/apis/elicitation-api";
import {
  HOSTED_MRTR_VERSION,
  isCompatibleMrtrVersion,
  isMrtrContinuationDataPart,
  type MrtrElicitationResponse,
  type MrtrInputRequiredEvent,
} from "@/shared/mrtr-continuation";
import { cancelHostedMrtrContinuation } from "@/lib/apis/web/mrtr-api";
import {
  buildMrtrChatResumeBody,
  findUnresolvedMrtrToolCallId,
} from "@/lib/mrtr-chat-resume";
import {
  useHostedMrtrStore,
  type HostedMrtrRound,
} from "@/stores/hosted-mrtr-store";
import {
  isHarnessSessionDataPart,
  isHarnessResetDataPart,
  type HarnessResetReason,
} from "@/shared/harness-session";
import {
  isPersistReceiptDataPart,
  type PersistReceiptData,
} from "@/shared/persist-receipt";
import {
  isSandboxNoticeDataPart,
  type SandboxNoticeReason,
} from "@/shared/sandbox-notice";
import {
  HOSTED_TASKS_VERSION,
  isTaskCreatedDataPart,
} from "@/shared/hosted-task-created";
import { getTrackedTaskScope, trackTask } from "@/lib/task-tracker";
import { useHarnessWorkdirStore } from "@/stores/harness-workdir-store";
import { ingestHostedRpcLogsFromResponse } from "@/lib/apis/web/rpc-logs";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type {
  McpToolResultImageRenderingPolicy,
  ModelVisibleMcpToolResults,
} from "@/lib/client-config-v2";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import type { HostedExecutionTarget } from "@/shared/execution-target";
import {
  buildResolvedServerBatchRequest,
  getApiContextRevision,
  subscribeApiContext,
} from "@/lib/apis/web/context";
import * as AppStateContext from "@/state/app-state-context";
import { findProjectByAnyId, type AppState } from "@/state/app-types";
import { isLocalOnlyMcpServerConfig } from "@/shared/local-only-mcp";
import { isClientFulfilledToolName } from "@/shared/client-fulfilled-tools";

// User-facing copy for a harness session reset, keyed by reason. Only hard
// resets are shown; `legacy-cold-resume` is a server-side log (resume is still
// attempted) and intentionally maps to no toast.
const HARNESS_RESET_MESSAGES: Record<HarnessResetReason, string | null> = {
  "sandbox-replaced":
    "Started a new session — the project computer was reset, so earlier context isn't available.",
  "resume-failed":
    "Started a new session — couldn't resume the previous one, so earlier context isn't available.",
  "legacy-cold-resume": null,
};

// User-facing copy for a scenario ephemeral-sandbox notice, keyed by reason.
//
// All are shown. A reset is the sharper one: the model may have written files
// in an earlier turn and will otherwise reason confidently about a filesystem
// that no longer exists, so silence is worse than an interruption.
const SANDBOX_NOTICE_MESSAGES: Record<SandboxNoticeReason, string> = {
  sandbox_reset:
    "This conversation's sandbox was reset after being idle — files and shell state from earlier turns are gone.",
  stale_image:
    "This conversation is still running on the computer image it started with; a newer build is available and will be used by your next conversation.",
  sandbox_unavailable:
    "This conversation's bash runs in a disposable cloud sandbox, but this inspector can't execute disposable sandboxes. The conversation continues without bash.",
};

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
  if (isMCPJamProvidedModelMenuItem(model)) return false;
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

function useMaybeSharedAppState(): AppState | null {
  const maybeContext = AppStateContext as typeof AppStateContext & {
    useOptionalSharedAppState?: () => AppState | null;
  };
  if (typeof maybeContext.useOptionalSharedAppState === "function") {
    return maybeContext.useOptionalSharedAppState();
  }
  try {
    return maybeContext.useSharedAppState();
  } catch {
    return null;
  }
}

export interface UseChatSessionOptions {
  /** Server names to connect to */
  selectedServers: string[];
  /** Visibility to apply when persisting a new direct chat */
  directVisibility?: "private" | "project";
  /** Sanitized organization provider config for org-backed projects */
  hostedOrgModelConfig?: OrgVisibleConfig;
  /** Hosted runtime context (project, server IDs, OAuth tokens, share/scenario scope) */
  hostedContext?: HostedRuntimeContext;
  /** Minimal UI mode for shared chat (hides diagnostics surfaces only) */
  minimalMode?: boolean;
  /**
   * Resolved Local⇄Cloud engine for this project's personal computer, provided
   * by the caller (Playground) so the CENTRAL hook stays free of the config
   * fetch `useComputerEngine` runs. When `engine === "local"` a direct
   * /api/mcp/chat-v2 turn forwards `computerEngine:"local"` plus the consent
   * capability header, so the server runs this host's bash on the local
   * machine. Absent ⇒ legacy cloud-family resolution (every other surface).
   */
  personalComputerEngine?: {
    engine: "local" | "cloud";
    consentToken: string | null;
  };
  /** Execution configuration (model, system prompt, temperature, tool approval) */
  executionConfig?: ExecutionConfig;
  /**
   * Phase 3: real host style for direct chat traces. Forwarded into
   * the request body so the backend persists the v2 hostConfig with
   * the user's actual host style rather than defaulting to `'claude'`.
   * Omitted for scenario flows — the
   * backend resolves scenario host style from the scenario row.
   */
  hostStyle?: string;
  /**
   * Host-level opt-in for progressive MCP tool discovery
   * (`search_mcp_tools` / `load_mcp_tools` meta-tools). Sourced from the
   * caller's resolved host config DTO (per-scenario, per-host playground
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
  /** Host-level MCP tool-result content/resource visibility policy. */
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
  /** Host-level UI rendering policy for MCP tool-returned images. */
  mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
  /**
   * Catalog ids of host-managed built-in tools (e.g. ["web_search"]) the
   * model should see this turn. Sourced from the caller's resolved host
   * config; held in a ref so a mid-session toggle flip is reflected on the
   * next send. Server resolves via `resolveBuiltInTools`. Falls back to
   * `executionConfig.builtInToolIds` when this top-level option is omitted.
   */
  builtInToolIds?: string[];
  /**
   * Offer this turn the WebMCP tools of the page the inspector currently has
   * open. Off unless the caller opts in: a chat that silently gained tools from
   * a browser session opened in another tab would be a surprise, and page tools
   * run code on a third-party site.
   */
  usePageTools?: boolean;
  /** Callback when chat is reset */
  onReset?: (reason?: ChatSessionResetReason) => void;
}

export type ChatSessionResetReason =
  | "auth-bootstrap"
  | "hydrate"
  | "fork"
  | "servers-changed"
  | "reset";

/**
 * Shown when `detachToLocalFork` could not confirm its fork went live. The
 * thread is still attached to a session the surface has decided it must not
 * write to, so the copy must NOT promise a new thread the way a successful
 * detach does. Shared so both chat surfaces say the same thing.
 */
export const DETACH_FORK_FAILED_MESSAGE =
  "Couldn't move this conversation to a new thread. Reload the page before sending again.";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SetSelectedModelOptions {
  /**
   * True only when this came from the model menu. Restores — a history
   * session, an eval hand-off — go through the same setter but must not
   * update the remembered own-provider model, or opening an old thread would
   * silently re-aim the next out-of-credits hand-off. See BACK2-628.
   */
  userInitiated?: boolean;
}

export interface UseChatSessionReturn {
  /**
   * Elicitation requests whose tool call is blocked on this user right now.
   * Turn-scoped: they arrive as transient stream parts and are dropped when the
   * stream ends, because the server has already resolved them to `cancel` by
   * then. FIFO — surfaces render `[0]`.
   */
  pendingElicitations: HostedElicitationRequestEvent[];
  /** Submit accept/decline/cancel. Resolves once the answer is durable. */
  respondToElicitation: (answer: {
    rendezvousId: string;
    action: HostedElicitationAction;
    content?: Record<string, unknown>;
  }) => Promise<void>;
  elicitationResponding: boolean;
  /** -32042 notices — display-only, anchored to the failed tool call. */
  urlElicitationRequired: HostedElicitationUrlRequiredEvent[];
  dismissUrlElicitationRequired: (toolCallId?: string) => void;

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
    /**
     * Resolves `true` once the message was actually dispatched, `false` on
     * every fail-closed preflight path (server-id resolution failed, or the
     * target/session changed while it was being prepared). Those paths surface
     * their own toast and RESOLVE rather than reject, so awaiting alone cannot
     * tell "sent" from "swallowed" — `rewindToMessage` needs the boolean to
     * avoid treating a branch whose turn never ran as a success. Fire-and-forget
     * callers can ignore it.
     */
  }) => Promise<boolean>;
  /**
   * Rewind to a past user message and re-run the turn from edited text.
   *
   * The thread BRANCHES rather than being overwritten: the original session
   * keeps its full transcript and the edited thread continues under a fresh
   * `chatSessionId`. Resolves to the previous session id so callers can offer a
   * way back, or `null` when the rewind was refused, which happens for any of
   * four reasons: a turn is in flight (`status` is `"submitted"` or
   * `"streaming"` — a failed turn is deliberately allowed, since rewinding is
   * how a user recovers from one); the message is no longer in the thread; or
   * the branch's session id is not the live one by the time hydration
   * resolves — a concurrent session change (`loadChatSession`/`resetChat`/
   * fork) superseded it first, and the live id could be either the original
   * (nothing else committed) or an unrelated third session (the interloper's
   * own change won), neither of which is safe to send into; or the send itself
   * failed closed after the branch was minted — `sendMessage`'s preflight
   * (hosted server-id resolution, or the target/session changing under it)
   * resolves `false` without dispatching, and an underlying throw is caught.
   * The branch exists in that last case but its turn never ran, so callers
   * must not report success.
   */
  rewindToMessage: (options: {
    messageId: string;
    text: string;
    files?: Array<{
      type: "file";
      mediaType: string;
      filename?: string;
      url: string;
    }>;
    metadata?: Record<string, unknown>;
    /**
     * Runs as the branch is minted, and only then — every refusal above that
     * point returns without calling it. Callers detach from the resumed thread
     * here so the teardown and the branch stay atomic: a refusal must not leave
     * the original session stripped of its optimistic-concurrency guard.
     */
    onBeforeBranch?: () => void;
  }) => Promise<{ previousChatSessionId: string } | null>;
  stop: () => void;
  status: "submitted" | "streaming" | "ready" | "error";
  error: Error | undefined;
  chatSessionId: string;

  // Model state
  selectedModel: ModelDefinition;
  setSelectedModel: (
    model: ModelDefinition,
    options?: SetSelectedModelOptions
  ) => void;
  /**
   * False while the persisted selection has not (yet) matched an entry in
   * `availableModels` — notably during the first renders after a load, when
   * an org-managed provider config is still in flight. `selectedModel` is a
   * derived fallback in that window; callers must not write it back to
   * storage. See BACK2-628.
   */
  isSelectedModelResolved: boolean;
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
  mcpToolsTokenCountErrors: Record<string, string> | null;
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
  /**
   * Mint a fresh `chatSessionId`, seed it with `messages`, and reset
   * `resumedVersion` to null. Resolves once the seeded messages have been
   * applied (the hydration `useLayoutEffect` has run) to the session id it
   * minted — NOT necessarily the id that's live by the time it resolves: a
   * concurrent session change (another `startChatWithMessages`/
   * `loadChatSession`/`resetChat`/fork) can supersede this one first, in
   * which case the live `chatSessionId` will differ from the resolved value.
   * Callers that need to confirm their own branch actually went live (e.g.
   * `rewindToMessage`) should compare the resolved id against the live one,
   * not just treat resolution as success.
   */
  startChatWithMessages: (
    messages: UIMessage[],
    options?: {
      resetReason?: ChatSessionResetReason;
      toolRenderOverrides?: Record<string, ToolRenderOverride>;
    }
  ) => Promise<string>;
  /**
   * Fork the given transcript onto a fresh `chatSessionId` and confirm the fork
   * is the session that actually went live, so post-detach sends cannot land
   * back on the thread the caller just detached from.
   *
   * Resolves to the minted id, or `null` when a concurrent session change
   * superseded the fork — in which case the caller is still pointed at a thread
   * it must not write to and must say so rather than claiming a new thread.
   * Never clears `resumedVersion` itself; see the implementation's contract.
   */
  detachToLocalFork: (
    messages: UIMessage[],
    options?: {
      toolRenderOverrides?: Record<string, ToolRenderOverride>;
    }
  ) => Promise<{ chatSessionId: string } | null>;
  loadChatSession: (
    session: {
      chatSessionId: string;
      messagesBlobUrl: string | null;
      resumeConfig?: {
        systemPrompt?: string;
        temperature?: number;
        requireToolApproval?: boolean;
        respectToolVisibility?: boolean;
        modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
        mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
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
  /**
   * Take the turn's `data-persist-receipt` — the server's own statement of what
   * happened to the chat-history save — or null when none arrived (a client
   * abort, or a server that predates the part). Consuming: each receipt
   * describes exactly one turn.
   */
  consumePersistReceipt: () => PersistReceiptData | null;
  /**
   * Take whether the turn that just ended was ABORTED (Stop, or any other abort
   * of the active response). The AI SDK reports an abort as `status: "ready"`
   * with no receipt, so without this a stopped turn looks exactly like a turn
   * whose save silently vanished. Consuming: each answer describes one turn.
   */
  consumeTurnAborted: () => boolean;

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

/**
 * Provider for a locked (guest / host-pinned) model id.
 *
 * Delegates to the shared classifier so this fallback agrees with the
 * synthetic-model builder, the public eval API, and the backend mirror.
 *
 * TWO INTENTIONAL BEHAVIOR CHANGES from the switch this replaced: a bare
 * unrecognized id now classifies as `ollama` rather than `openrouter` (bare
 * ids are the Ollama BYOK shape everywhere else in the app, and no catalog id
 * is bare), and `mistralai/...` resolves to `mistral` instead of falling
 * through. `ollama` is also the last-resort answer for a blank id here — the
 * locked model is display-only, and a null provider would have to be rendered
 * as something regardless.
 */
function inferModelProviderFromId(modelId: string): ModelProvider {
  return providerForModelId(modelId) ?? "ollama";
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
// Bounds `turnOrder`/`turns`/`requestPayloadHistory` for long-running agent
// sessions. Without this, a session left open for many hours accumulates one
// entry per turn — each carrying a full resolved model request (system
// prompt + entire message history) — growing roughly quadratically and
// eventually exhausting the renderer's V8 heap (see INSPECTOR-ELECTRON-VR).
const MAX_LIVE_TRACE_TURNS = 200;
// Backstop for `requestPayloadHistory` independent of the turn cap above: a
// single turn can carry many steps (agent tool-call loops), each appending
// its own full request payload keyed by turnId+stepIndex, so bounding by
// turn count alone doesn't bound this array for a pathologically long turn.
const MAX_LIVE_TRACE_REQUEST_PAYLOADS = 2 * MAX_LIVE_TRACE_TURNS;

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
  // Rehydrating a session with more persisted turns than the live cap would
  // otherwise recreate the same unbounded growth this cap prevents
  // (INSPECTOR-ELECTRON-VR) — keep only the most recent turns, and skip
  // fetching span blobs for the ones we're about to discard.
  const boundedRaw =
    raw.length > MAX_LIVE_TRACE_TURNS
      ? [...raw]
          .sort((left, right) => left.promptIndex - right.promptIndex)
          .slice(-MAX_LIVE_TRACE_TURNS)
      : raw;
  const results = await Promise.all(
    boundedRaw.map(async (trace) => {
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

function hasChatToolCall(
  chatMessages: UIMessage[],
  toolCallId: string
): boolean {
  return chatMessages.some((message) =>
    message.parts?.some((part) => {
      if (!part || typeof part !== "object") return false;
      return (part as { toolCallId?: unknown }).toolCallId === toolCallId;
    })
  );
}

/**
 * AI SDK's generic completed-tool predicate also matches MCP tools that the
 * server already executed inside the same response. Auto-sending those starts
 * a redundant turn; for a scope-step-up resume it also reuses the same opaque
 * continuation forever. Only browser-fulfilled app/UI tools need the client to
 * POST their newly supplied output back to the server.
 */
export function shouldAutoSendCompletedClientToolCalls(
  options: Parameters<typeof lastAssistantMessageIsCompleteWithToolCalls>[0],
  scopeStepUpResumeInFlight = false
): boolean {
  if (
    scopeStepUpResumeInFlight ||
    !lastAssistantMessageIsCompleteWithToolCalls(options)
  ) {
    return false;
  }
  const message = options.messages.at(-1);
  if (!message || message.role !== "assistant") return false;
  const lastStepStartIndex = message.parts.reduce(
    (lastIndex, part, index) =>
      part.type === "step-start" ? index : lastIndex,
    -1
  );
  return message.parts
    .slice(lastStepStartIndex + 1)
    .some(
      (part) =>
        isToolUIPart(part) && isClientFulfilledToolName(getToolName(part))
    );
}

// SEP-2350: a JSON-RPC message that carries a `result` (and no `error`) is a
// SUCCESSFUL response — the signal used to clear a server's bounded step-up
// counter once its grant is proven sufficient again.
export function isSuccessfulRpcResponse(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const m = message as Record<string, unknown>;
  return "result" in m && !("error" in m);
}

// SEP-2350: the JSON-RPC `id` correlating a request with its response. Only
// string/number ids can be matched across the two log frames; a notification
// (no id) or a malformed id yields `undefined` and never correlates.
export function rpcMessageId(message: unknown): string | number | undefined {
  if (!message || typeof message !== "object") return undefined;
  const id = (message as Record<string, unknown>).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

// SEP-2350: a JSON-RPC message's `method`, present only on requests. Used to
// pick out the outgoing `tools/call` whose later successful response is the
// ONLY signal that clears the bounded step-up counter — a `tools/list`,
// `initialize`, or ping success must NOT reset it, since none of those exercise
// the scope the step-up widened.
export function rpcRequestMethod(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const method = (message as Record<string, unknown>).method;
  return typeof method === "string" ? method : undefined;
}

export function rpcToolCallOperation(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const params = (message as Record<string, unknown>).params;
  if (!params || typeof params !== "object") return undefined;
  const name = (params as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * SEP-2350: reconcile one hosted RPC log frame against the per-server set of
 * outgoing `tools/call` request ids, and report whether this frame is the
 * SUCCESSFUL-`tools/call` signal that should clear the server's bounded step-up
 * counter. Mutates `pending` in place:
 *   - `send` + `tools/call` with an id → record the id under `serverId`.
 *   - `receive` answering a tracked id → EVICT the id (success OR error) so a
 *     failed `tools/call` — the `insufficient_scope` case — can't linger and
 *     later false-match a reused id; returns `true` ONLY when that settled
 *     response is a success (proving the widened grant is now sufficient).
 * Discovery/handshake successes (`initialize`, `tools/list`, ping) were never
 * tracked as `tools/call`, so their ids are never in `pending` and can never
 * return `true`. The caller resolves the server + performs the actual reset.
 */
export function reconcileChatToolCallStepUp(
  pending: Map<string, Map<string | number, string>>,
  log: { direction: string; serverId: string; message: unknown }
): string | undefined {
  if (log.direction === "send") {
    // Track only tool invocations; ids from other methods never gate a reset,
    // so recording them would only grow the map.
    if (rpcRequestMethod(log.message) === "tools/call") {
      const id = rpcMessageId(log.message);
      const operation = rpcToolCallOperation(log.message);
      if (id !== undefined && operation) {
        const operations =
          pending.get(log.serverId) ?? new Map<string | number, string>();
        operations.set(id, operation);
        pending.set(log.serverId, operations);
      }
    }
    return undefined;
  }
  if (log.direction === "receive") {
    const id = rpcMessageId(log.message);
    const operations = pending.get(log.serverId);
    const operation = id !== undefined ? operations?.get(id) : undefined;
    if (id !== undefined && operation) {
      operations!.delete(id);
      if (operations!.size === 0) {
        pending.delete(log.serverId);
      }
      return isSuccessfulRpcResponse(log.message) ? operation : undefined;
    }
  }
  return undefined;
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

// Drops the oldest turns once `turnOrder` exceeds MAX_LIVE_TRACE_TURNS,
// keeping `turns` and `requestPayloadHistory` in sync with what's evicted.
// Also applies a flat backstop cap to `requestPayloadHistory` in case a
// single turn (still within the turn cap) accumulates many step entries.
function trimLiveTraceTurns(
  state: LiveTraceAccumulatorState
): LiveTraceAccumulatorState {
  let turnOrder = state.turnOrder;
  let turns = state.turns;
  let requestPayloadHistory = state.requestPayloadHistory;

  if (turnOrder.length > MAX_LIVE_TRACE_TURNS) {
    const dropCount = turnOrder.length - MAX_LIVE_TRACE_TURNS;
    const droppedTurnIds = new Set(turnOrder.slice(0, dropCount));
    turnOrder = turnOrder.slice(dropCount);

    const nextTurns: Record<string, LiveTraceTurnState> = {};
    for (const turnId of turnOrder) {
      const turn = turns[turnId];
      if (turn) {
        nextTurns[turnId] = turn;
      }
    }
    turns = nextTurns;

    requestPayloadHistory = requestPayloadHistory.filter(
      (entry) => !droppedTurnIds.has(entry.turnId)
    );
  }

  if (requestPayloadHistory.length > MAX_LIVE_TRACE_REQUEST_PAYLOADS) {
    requestPayloadHistory = requestPayloadHistory.slice(
      -MAX_LIVE_TRACE_REQUEST_PAYLOADS
    );
  }

  if (
    turnOrder === state.turnOrder &&
    requestPayloadHistory === state.requestPayloadHistory
  ) {
    return state;
  }

  return {
    ...state,
    turnOrder,
    turns,
    requestPayloadHistory,
  };
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
      return trimLiveTraceTurns({
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
      });
    }
    case "request_payload": {
      const turnState = ensureTurnState(event.turnId, event.promptIndex);
      const turnExists = baseState.turnOrder.includes(event.turnId);
      return trimLiveTraceTurns({
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
      });
    }
    case "trace_snapshot": {
      const turnState = ensureTurnState(
        event.turnId,
        event.snapshot.promptIndex
      );
      const turnExists = baseState.turnOrder.includes(event.turnId);
      return trimLiveTraceTurns({
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
      });
    }
    case "turn_finish": {
      const turnState = ensureTurnState(event.turnId, event.promptIndex);
      const turnExists = baseState.turnOrder.includes(event.turnId);
      return trimLiveTraceTurns({
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
      });
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
  /**
   * ONE stable key for "what this session executes against", replacing the
   * previous pair of independently-compared `scenarioId` / `hostId` fields:
   *
   *   `host:<hostId>` | `environment:<environmentId>` |
   *   `scenario:<scenarioId>` | `adhoc:<projectId>`
   *
   * Namespacing matters — the id spaces are different Convex tables, and a bare
   * id comparison would call a host and an environment that happen to share an
   * id string the same session.
   *
   * What is deliberately NOT in the key:
   *   - the environment `revision`. Environments are LIVE config: editing one
   *     mid-conversation changes what the next turn resolves to, which is the
   *     feature. Only changing WHICH environment is selected forks.
   *   - `accessVersion` (see below).
   */
  targetKey?: string;
};

/** Build the {@link HostedSessionScope} target key. Exported for tests. */
export function hostedTargetKey(input: {
  projectId?: string | null;
  scenarioId?: string;
  hostId?: string;
  executionTarget?: HostedExecutionTarget;
}): string {
  if (input.executionTarget) {
    return input.executionTarget.kind === "environment"
      ? `environment:${input.executionTarget.environmentId}`
      : `host:${input.executionTarget.hostId}`;
  }
  if (input.scenarioId) return `scenario:${input.scenarioId}`;
  if (input.hostId) return `host:${input.hostId}`;
  return `adhoc:${input.projectId ?? ""}`;
}

// `accessVersion` is intentionally NOT part of the scope. The chat-reset
// path uses this comparison to decide when to blow away `chatSessionId` /
// `messages`, which is only appropriate when *identity* changes (different
// project, different scenario, different previewed host). A pure `accessVersion`
// bump — e.g. from the silent re-redeem triggered by `scenario_access_stale` —
// keeps the same scenario and the same conversation; tearing the chat down on
// those bumps would defeat the purpose of the recovery path.
//
// The execution TARGET is part of the scope: switching the previewed host — or,
// from Phase 2, the previewed environment — in the Playground (same project)
// resolves future turns against a different configuration, so the transcript
// must fork rather than append target B's turns onto target A's.
export function areHostedSessionScopesEqual(
  a: HostedSessionScope,
  b: HostedSessionScope
): boolean {
  return a.projectId === b.projectId && a.targetKey === b.targetKey;
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
    personalComputerEngine,
    onReset,
  } = options;
  // Caller-provided (Playground): send local only when it will actually run
  // there. Consent-gated `engine`, device-scoped token — both from the caller.
  const resolvedLocalEngine = personalComputerEngine?.engine === "local";
  const localConsentToken = personalComputerEngine?.consentToken ?? null;
  // Surfaces that omit `executionConfig` entirely (e.g. Playground) own their
  // chat-execution state imperatively and must not be re-synced from prop
  // defaults. Surfaces that pass `executionConfig` are in controlled mode and
  // get synced on every change — including when an upstream value transiently
  // becomes undefined during host bootstrap, in which case fields fall back to
  // hook defaults rather than retaining the prior host's value.
  const isExecutionConfigControlled = "executionConfig" in options;
  const hostedProjectId = hostedContext?.projectId;
  const hostedSelectedServerIds = hostedContext?.selectedServerIds ?? [];
  const hostedEnsureServerIds = hostedContext?.ensureServerIds;
  const hostedOAuthTokens = hostedContext?.oauthTokens;
  const hostedScenarioId = hostedContext?.scenarioId;
  const hostedHostId = hostedContext?.hostId;
  // CACHE KEYING ONLY — see `HostedRuntimeContext.presentationHostId`. Never
  // added to a request body or to `hostedTargetKey`: the execution target must
  // stay a single statement.
  const hostedPresentationHostId = hostedContext?.presentationHostId ?? null;
  // Project Environments (Phase 2). When present this REPLACES the legacy
  // `hostId` pointer on the wire — `normalizeExecutionTarget` rejects a body
  // carrying both rather than shadowing one with the other.
  const hostedExecutionTarget = hostedContext?.executionTarget;
  const hostedEnvironmentId =
    hostedExecutionTarget?.kind === "environment"
      ? hostedExecutionTarget.environmentId
      : undefined;
  // Only ever sent when the caller explicitly overrode. Absent and
  // `{ serverIds: [] }` mean different things all the way down to the backend
  // resolver, so this must never be defaulted to an empty envelope.
  const hostedEnvironmentOverrides = hostedContext?.environmentOverrides;
  const hostedTargetHostId =
    hostedExecutionTarget?.kind === "host"
      ? hostedExecutionTarget.hostId
      : undefined;
  // Derived from PRIMITIVES, not from the `executionTarget` object: callers
  // build that object inline, so a fresh identity every render would churn any
  // effect that depended on it.
  const hostedTargetKeyValue = hostedTargetKey({
    projectId: hostedProjectId,
    scenarioId: hostedScenarioId,
    hostId: hostedTargetHostId ?? hostedHostId,
    ...(hostedEnvironmentId
      ? {
          executionTarget: {
            kind: "environment" as const,
            environmentId: hostedEnvironmentId,
          },
        }
      : {}),
  });
  // Always-current mirror of the target key, read at both ends of the send-time
  // preflight await. The transport body is built from the LATEST props when the
  // request finally goes out, so a target the user changed mid-preflight would
  // silently receive a message composed for the previous one.
  const hostedTargetKeyRef = useRef(hostedTargetKeyValue);
  hostedTargetKeyRef.current = hostedTargetKeyValue;
  const hostedAccessVersion = hostedContext?.accessVersion;
  const hostedScenarioSurface = hostedContext?.scenarioSurface;
  // Published-scenario runtime sessions must use the org-aware web engine
  // on every platform — their servers resolve by Convex id, which the
  // local /api/mcp engine can't connect. See HostedRuntimeContext.
  const hostedRequiresWebChatApi = hostedContext?.requiresWebChatApi === true;
  const requestRefreshAccessVersion =
    hostedContext?.requestRefreshAccessVersion;
  const hostedRefreshAccessSession = hostedContext?.refreshAccessSession;
  const hostedOnAccessRevoked = hostedContext?.onAccessRevoked;
  const appState = useMaybeSharedAppState();
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
  // Elicitation answers go straight to Convex — the blocked replica isn't
  // addressable from here (see `elicitation-api.ts`).
  const convexClient = useConvex();
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
  // Whether the turn's Authorization is a real member (WorkOS) bearer vs a
  // guest bearer (which the auth effect attaches when signed out). Defense in
  // depth for the local engine: a stale consent token can outlive sign-out, so
  // never forward the local engine on a guest turn even if the token verifies.
  // The server independently rejects guest local turns — this just avoids
  // sending a header a guest can't use.
  const authIsMemberRef = useRef(false);
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
  /**
   * This turn's persist receipt, held until a post-stream consumer takes it.
   * Refs rather than state: nothing renders from these, and a re-render between
   * the receipt landing and the post-stream effect reading it would be pure
   * noise.
   */
  const persistReceiptRef = useRef<PersistReceiptData | null>(null);
  /** Session + turn the in-flight turn belongs to; set at `turn_start`. */
  const receiptTurnIdentityRef = useRef<{
    chatSessionId: string;
    turnId: string;
  } | null>(null);
  /**
   * Whether the turn that just ended was ABORTED rather than allowed to finish.
   *
   * The AI SDK has no distinct "aborted" status — on abort it sets
   * `status: "ready"` and returns (ai/dist/index.mjs, in `makeRequest`'s catch:
   * `if (isAbort || err.name === "AbortError") { this.setStatus({ status:
   * "ready" }); return null; }`). So a stopped turn is indistinguishable from a
   * completed one by status alone, and post-stream consumers that expect a
   * persist receipt would wait out their whole reconciliation window for a
   * receipt the server never sends: it persists only `runSucceeded && !aborted`.
   *
   * Sourced from the SDK's own `onFinish({ isAbort })` rather than from the Stop
   * button, so an abort from ANY source counts — Stop, an unmounting instance
   * aborting its controller, a navigation. Set on every turn end (true or
   * false), so a finished turn always overwrites a stopped predecessor.
   */
  const turnAbortedRef = useRef(false);
  const [, setHydrationTick] = useState(0);
  const [resumedVersion, setResumedVersion] = useState<number | null>(null);
  const [restoredToolRenderOverrides, setRestoredToolRenderOverrides] =
    useState<Record<string, ToolRenderOverride>>({});
  const [liveTraceState, setLiveTraceState] =
    useState<LiveTraceAccumulatorState>(() => createEmptyLiveTraceState());
  /**
   * Elicitations whose tool call is blocked on this user right now. Turn-scoped
   * by nature — the request arrives as a transient stream part and the blocked
   * call dies with the stream, so there is nothing to persist or rehydrate.
   */
  const [pendingElicitations, setPendingElicitations] = useState<
    HostedElicitationRequestEvent[]
  >([]);
  const [elicitationResponding, setElicitationResponding] = useState(false);
  /**
   * Hosted MRTR (§12.5) resume sender. Assigned after `useChat` (it re-drives a
   * chat turn) but referenced by the stream-part consumer, which is defined
   * before it — the same late-binding shape the transport refs use.
   */
  const mrtrResumeSenderRef = useRef<
    | ((
        round: HostedMrtrRound,
        responses: Record<string, MrtrElicitationResponse>
      ) => Promise<void>)
    | null
  >(null);
  /** -32042 notices: display-only, anchored to the tool call that failed. */
  const [urlElicitationRequired, setUrlElicitationRequired] = useState<
    HostedElicitationUrlRequiredEvent[]
  >([]);
  // SEP-2350: ids of outgoing `tools/call` requests per server (keyed by the
  // trusted `serverId`), so a later SUCCESSFUL response can be correlated to an
  // actual tool invocation before resetting that server's bounded step-up
  // counter. Discovery/handshake successes (`initialize`, `tools/list`, ping)
  // that fire on post-OAuth reconnect must NOT clear the budget — only a
  // `tools/call` success proves the widened grant is now sufficient.
  const chatToolCallRequestIdsRef = useRef<
    Map<string, Map<string | number, string>>
  >(new Map());
  const resumedVersionRef = useRef<number | null>(null);
  const rewindRef = useRef<{
    chatSessionId: string;
    lineage: ChatRewind;
  } | null>(null);
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
  const [mcpToolsTokenCountErrors, setMcpToolsTokenCountErrors] =
    useState<Record<string, string> | null>(null);
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
  // to its chat surface (per-host playground column, per-scenario session,
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
  const resumedModelVisibleMcpToolResultsRef = useRef<
    ModelVisibleMcpToolResults | undefined
  >(undefined);
  const resumedMcpToolResultImageRenderingRef = useRef<
    McpToolResultImageRenderingPolicy | undefined
  >(undefined);
  const modelVisibleMcpToolResultsRef = useRef<
    ModelVisibleMcpToolResults | undefined
  >(undefined);
  modelVisibleMcpToolResultsRef.current =
    resumedModelVisibleMcpToolResultsRef.current ??
    options.modelVisibleMcpToolResults ??
    options.executionConfig?.modelVisibleMcpToolResults;
  const mcpToolResultImageRenderingRef = useRef<
    McpToolResultImageRenderingPolicy | undefined
  >(undefined);
  mcpToolResultImageRenderingRef.current =
    resumedMcpToolResultImageRenderingRef.current ??
    options.mcpToolResultImageRendering ??
    options.executionConfig?.mcpToolResultImageRendering;
  // Host-managed built-in tools. Top-level option wins (mirrors the
  // progressiveToolDiscovery / respectToolVisibility pattern), then
  // executionConfig as a fallback for surfaces that thread everything
  // through executionConfig. `undefined` ⇒ no attached built-ins.
  const builtInToolIdsRef = useRef<string[] | undefined>(undefined);
  builtInToolIdsRef.current =
    options.builtInToolIds ?? options.executionConfig?.builtInToolIds;
  // Read through a ref for the same reason the ids above are: the transport's
  // body builder is created once and must see the CURRENT value at POST time,
  // not the one captured when the transport was memoized.
  const usePageToolsRef = useRef(false);
  usePageToolsRef.current = options.usePageTools === true;
  const isHostedGuest = HOSTED_MODE && !workOsUser && !isWorkOsLoading;
  const sharedGuestMode =
    isHostedGuest && !isAuthLoading && !!hostedProjectId && !!hostedScenarioId;
  const guestMode = sharedGuestMode;
  const skipNextForkDetectionRef = useRef(false);
  const hasResolvedAuthHeadersRef = useRef(false);
  const lastResolvedAuthHeadersRef = useRef<Record<string, string> | undefined>(
    undefined
  );
  const lastResolvedHostedScopeRef = useRef<HostedSessionScope>({
    projectId: undefined,
    targetKey: undefined,
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
  /**
   * Queue a suspended hosted MRTR round on the shared dialog rail (§12.5).
   *
   * Mixed-version rollout: an MRTR round is a multi-step protocol (suspend →
   * display → resume) where a partial understanding is worse than none, so a
   * version this bundle does not speak FAILS FAST — withdraw the continuation
   * and tell the user to refresh — instead of rendering a round it could never
   * complete and leaving the operation to hang until its TTL.
   */
  const handleMrtrInputRequired = useCallback(
    (event: MrtrInputRequiredEvent) => {
      const store = useHostedMrtrStore.getState();
      const withdraw = (reason: string) => {
        void cancelHostedMrtrContinuation({
          continuationId: event.continuationId,
          reason,
        }).catch(() => {
          // Best effort — the continuation expires on its own TTL.
        });
      };
      if (!isCompatibleMrtrVersion(event.version)) {
        withdraw("client hosted-MRTR version mismatch");
        toast.error(
          `This tab is running an outdated build (hosted-MRTR v${HOSTED_MRTR_VERSION}; ` +
            `this request needs v${event.version}). Refresh the page and try again.`
        );
        return;
      }
      const round: HostedMrtrRound = {
        key: `${event.continuationId}:${event.round}`,
        continuationId: event.continuationId,
        round: event.round,
        serverId: event.serverId,
        ...(event.serverName ? { serverName: event.serverName } : {}),
        method: event.method,
        ...(event.operationLabel
          ? { operationLabel: event.operationLabel }
          : {}),
        requests: event.inputRequests,
        expiresAt: event.expiresAt,
        timestamp: new Date().toISOString(),
      };
      // `enqueue` dedupes by round key, so a re-delivered part never stacks a
      // second dialog over one suspended operation.
      store.enqueue(round, {
        submit: async (responses) => {
          const send = mrtrResumeSenderRef.current;
          if (!send) {
            // Unreachable in a mounted hook; throwing keeps the dialog (and the
            // user's answers) rather than silently dropping a live round.
            throw new Error("Chat is not ready to resume this operation.");
          }
          await send(round, responses);
        },
        cancel: () => withdraw("dismissed by user"),
      });
    },
    []
  );

  const handleStreamDataPart = useCallback(
    (part: unknown) => {
      if (!isTraceEventDataPart(part)) {
        if (isScopeStepUpFinishedDataPart(part)) {
          const event = part.data;
          const pending = readPendingChatScopeStepUp();
          if (pending?.event.continuationId === event.continuationId) {
            if (
              event.outcome === "completed" ||
              event.outcome === "cancelled"
            ) {
              const server = resolveScopeStepUpServer(appState, {
                serverId: event.serverId,
                serverName: pending.event.serverName,
                projectId: hostedProjectId,
              });
              resetScopeStepUp(server, event.operation);
            }
            clearPendingChatScopeStepUp(event.continuationId);
          }
        } else if (isScopeStepUpDataPart(part)) {
          const event = part.data;
          const server = resolveScopeStepUpServer(appState, {
            serverId: event.serverId,
            serverName: event.serverName,
            projectId: hostedProjectId,
          });
          const sessionId = chatSessionIdRef.current;
          if (!server || !sessionId) {
            toast.error(
              "Authorization is required, but this conversation cannot be resumed automatically. Authorize, then retry the tool."
            );
            return;
          }
          savePendingChatScopeStepUp({
            event,
            serverName: server.name,
            chatSessionId: sessionId,
          });
          driveChatScopeStepUp(
            server,
            {
              requiredScope: event.requiredScope,
              resourceMetadataUrl: event.resourceMetadataUrl,
            },
            event.operation
          );
        } else if (isHostedElicitationDataPart(part)) {
          const event = part.data;
          if (event.kind === "request") {
            // Dedupe on rendezvousId: a re-delivered part must not stack a
            // second dialog for the same blocked tool call.
            setPendingElicitations((queue) =>
              queue.some((e) => e.rendezvousId === event.rendezvousId)
                ? queue
                : [...queue, event]
            );
          } else if (event.kind === "resolved") {
            // The server reached a terminal state on its own (TTL expiry, or
            // an answer that landed elsewhere) — close the dialog rather than
            // leave the user submitting into a dead rendezvous.
            setPendingElicitations((queue) =>
              queue.filter((e) => e.rendezvousId !== event.rendezvousId)
            );
          } else if (event.kind === "url_required") {
            setUrlElicitationRequired((current) => [...current, event]);
          } else if (event.kind === "insufficient_scope") {
            // SEP-2350: a tool call in the agent loop failed with a runtime
            // `403 insufficient_scope`. Drive the bounded, union-scope step-up
            // re-authorization (`reauthorize` redirects the browser to the
            // authorization server). Resolve the live server entry from the
            // same store ToolsTab uses; without it there is no stored issuer /
            // granted scopes to widen, so skip.
            //
            // Scenario / share-link turns are DELIBERATELY skipped here: their
            // servers are synthesized in ScenarioChatPage with a placeholder
            // URL and never inserted into the dashboard appState, so this
            // lookup returns undefined and the `if (server && ...)` guard below
            // makes the event a safe no-op. That is correct — a share-link
            // visitor (even an authenticated one) does not own the host's MCP
            // servers and cannot re-authorize the owner's OAuth; connect-time
            // scenario OAuth is handled separately by `useHostedOAuthGate`.
            const server = resolveScopeStepUpServer(appState, {
              serverId: event.serverId,
              serverName: event.serverName,
              projectId: hostedProjectId,
            });
            // The shared lifecycle applies the same actionable-challenge gate
            // (a `requiredScope` OR a `resourceMetadataUrl` is now actionable —
            // discovery consumes the PRM pointer, SEP-2350 follow-up to #3427)
            // and the same cross-surface in-flight dedup.
            //
            // The chat variant additionally DEFERS the redirect to the end of
            // the turn. The redirect is a full-page navigation, and the server
            // only persists the transcript once this stream drains — redirect
            // now and the user returns from the authorization server to a
            // transcript missing the tool call that sent them there.
            driveChatScopeStepUp(server, {
              requiredScope: event.requiredScope,
              resourceMetadataUrl: event.resourceMetadataUrl,
            });
          }
        } else if (isMrtrContinuationDataPart(part)) {
          // Hosted MRTR (§12.5): a tool call returned `input_required` and the
          // operation was SUSPENDED to a durable continuation — unlike a legacy
          // elicitation, nothing server-side is blocking on the answer and the
          // stream ends while the round is still pending. The queue therefore
          // deliberately OUTLIVES the turn (it is cleared on reset/abort, not
          // on stream end) and the answer re-drives a fresh chat turn.
          const event = part.data;
          const store = useHostedMrtrStore.getState();
          if (event.kind === "resolved") {
            store.resolveContinuation(event.continuationId);
            if (event.indeterminate) {
              // Exactly-once: a side-effecting call may or may not have run, so
              // never auto-retry — say so and let the user decide.
              toast.error(
                "That tool call was interrupted and may or may not have run. Check the server before retrying."
              );
            } else if (event.outcome === "expired") {
              toast.info(
                "That request timed out, so the operation was cancelled."
              );
            }
            return;
          }
          handleMrtrInputRequired(event);
        } else if (isHostedRpcLogDataPart(part)) {
          ingestHostedRpcLogs([part.data]);
          // SEP-2350: chat/agent-loop server tool calls resolve server-side, so
          // (unlike Tools/Resources/Prompts) this hook has no per-call success
          // return to clear the bounded step-up counter on. The per-server
          // success signal is a SUCCESSFUL response to an actual `tools/call` —
          // and ONLY that. A `tools/list`, `initialize`, ping, or logging
          // success (all of which fire on the post-OAuth reconnect that follows
          // a step-up redirect) does NOT exercise the widened scope, so clearing
          // the budget on one would let a server that keeps returning
          // `insufficient_scope` redirect every turn instead of reaching the
          // bounded cap. Responses carry no `method`, so correlate by JSON-RPC
          // id: record outgoing `tools/call` request ids per server, then reset
          // only when a matching successful response arrives. Same store lookup
          // the insufficient_scope branch uses (a share-link scenario resolves to
          // no server, a safe no-op there).
          const log = part.data;
          // Track outgoing `tools/call` ids and evict them on any settled
          // response; a `true` return means a tracked `tools/call` SUCCEEDED —
          // the only signal that clears this server's bounded step-up counter.
          const successfulOperation = reconcileChatToolCallStepUp(
            chatToolCallRequestIdsRef.current,
            log
          );
          if (successfulOperation) {
            const activeProject =
              appState?.projects?.[
                hostedProjectId ?? appState?.activeProjectId ?? ""
              ];
            const server =
              (log.serverName
                ? appState?.servers?.[log.serverName] ??
                  activeProject?.servers?.[log.serverName]
                : undefined) ??
              appState?.servers?.[log.serverId] ??
              activeProject?.servers?.[log.serverId];
            resetScopeStepUp(server, {
              method: "tools/call",
              operation: successfulOperation,
            });
          }
        } else if (isHostedHttpLogDataPart(part)) {
          // Headers only, and deliberately NOT run through the step-up
          // reconciliation above: that correlates JSON-RPC ids, and an
          // exchange carries no id (one HTTP round trip can wrap several
          // frames). The `data-rpc-log` part for the same call is what clears
          // the counter; this part exists purely to fill the Tracing view.
          ingestHostedHttpLogs([part.data]);
        } else if (isPersistReceiptDataPart(part)) {
          // What actually happened to this turn's chat-history save. Validated
          // before it is stored, because a receipt is only meaningful for the
          // conversation it describes: it arrives at the very end of a turn, by
          // which point a reset, fork, or thread switch may already have moved
          // this surface somewhere else. Applying a stale receipt would sync a
          // version baseline onto a thread it does not belong to.
          const receipt = part.data;
          const expectedTurn = receiptTurnIdentityRef.current;
          const sameSession =
            receipt.chatSessionId === chatSessionIdRef.current;
          // The turn check is against the identity captured at `turn_start`,
          // NOT `activeTurnId` — that is cleared by `turn_finish`, which always
          // arrives BEFORE the receipt.
          const sameTurn =
            !receipt.turnId ||
            !expectedTurn?.turnId ||
            receipt.turnId === expectedTurn.turnId;
          if (sameSession && sameTurn) {
            persistReceiptRef.current = receipt;
          }
        } else if (isHarnessSessionDataPart(part)) {
          // Cache the harness workdir so the Playground Shell can open a
          // terminal there. Keyed by project + host — and on an ENVIRONMENT
          // turn there is no `hostedHostId` (the target carries no host
          // pointer), so fall back to the presentation host: that is the id the
          // rail reads by, and without it the workdir lands under the project
          // key and the terminal opens at the box home instead.
          useHarnessWorkdirStore
            .getState()
            .setWorkdir(
              hostedProjectId ?? null,
              hostedHostId ?? hostedPresentationHostId ?? null,
              part.data.workdir
            );
        } else if (isSandboxNoticeDataPart(part)) {
          // One-time fact about the scenario's ephemeral sandbox. Exactly-once
          // delivery is the BACKEND's job (it marks the notice consumed in the
          // same transaction that hands it over), so this side just renders
          // whatever arrives — no client-side dedupe that a reconnect could
          // desync.
          toast.info(SANDBOX_NOTICE_MESSAGES[part.data.reason]);
        } else if (isHarnessResetDataPart(part)) {
          // The harness couldn't warm-resume the prior in-box session and
          // started a fresh one. Surface it so a lost conversation reads as an
          // explained reset, not the model silently "forgetting".
          const message = HARNESS_RESET_MESSAGES[part.data.reason];
          if (message) toast.info(message);
        } else if (isTaskCreatedDataPart(part)) {
          // Track it and stop. Deliberately NO navigation: a chat turn must
          // not yank the user out of the conversation to a task list.
          //
          // `trackTask` needs nothing added for at-least-once delivery — it
          // dedupes on the full task identity, so a duplicated part is a
          // no-op. The scope is passed EXPLICITLY, from the value captured at
          // submit: letting `trackTask` stamp the live active scope was the
          // bug — a part delivered after a mid-stream project switch filed
          // the task under the NEW project.
          //
          // Keyed by server NAME when the server sent one: the tracker and the
          // Tasks tab both read by name, while a hosted `serverId` is a Convex
          // document id, so tracking under the id files the task where the
          // Tasks tab never looks.
          trackTask({
            taskId: part.data.taskId,
            serverId: part.data.serverName ?? part.data.serverId,
            wire: part.data.wire,
            // Required by the tracker. The server's own timestamp when it sent
            // one; a local reading only as a last resort, since the tracker
            // renders it as the handle's age.
            createdAt: part.data.createdAt ?? new Date().toISOString(),
            ...(part.data.toolName ? { toolName: part.data.toolName } : {}),
            ...(part.data.status ? { status: part.data.status } : {}),
            ...(part.data.ttlMs !== undefined
              ? { ttlMs: part.data.ttlMs }
              : {}),
            ...(part.data.pollIntervalMs !== undefined
              ? { pollIntervalMs: part.data.pollIntervalMs }
              : {}),
            ...(turnTaskScopeRef.current !== undefined
              ? { scope: turnTaskScopeRef.current }
              : {}),
          });
        }
        return;
      }

      if (part.data.type === "turn_start") {
        // A dedicated identity for receipt matching, captured while the turn is
        // starting rather than read off trace state later: `activeTurnId` is
        // cleared by `turn_finish`, which lands before the receipt does. A new
        // turn also invalidates the previous turn's receipt.
        receiptTurnIdentityRef.current = {
          chatSessionId: chatSessionIdRef.current,
          turnId: part.data.turnId,
        };
        persistReceiptRef.current = null;
        // Same lifetime as the receipt: a new turn invalidates the previous
        // turn's abort just as it invalidates the previous turn's receipt.
        // `onFinish` already clears it at every turn end, so this only matters
        // when nothing consumed the flag (no history rail on this surface).
        turnAbortedRef.current = false;
      }

      setLiveTraceState((current) => applyLiveTraceEvent(current, part.data));
    },
    [
      hostedProjectId,
      hostedHostId,
      hostedPresentationHostId,
      appState,
      handleMrtrInputRequired,
    ]
  );

  /**
   * Take this turn's persist receipt, if one arrived and passed validation.
   *
   * Consuming rather than reading: the receipt describes exactly one turn, and
   * leaving it in place would let a later reconciliation pass mistake it for a
   * fresh answer about a different turn.
   *
   * Ordering is safe. The AI SDK processes stream chunks in order and only
   * flips `status` to `ready` once the reader completes, so a receipt on the
   * wire is always observed before any post-stream effect runs. A client abort
   * or disconnect means no receipt at all — callers fall back to reconciling
   * against the session subscription.
   */
  const consumePersistReceipt = useCallback((): PersistReceiptData | null => {
    const receipt = persistReceiptRef.current;
    persistReceiptRef.current = null;
    // Re-checked at CONSUME time, not just on arrival: the session can change
    // in the window between the receipt landing and a post-stream effect
    // reading it, and handing a receipt for the old thread to the new one would
    // sync its version baseline — or detach it — on the wrong conversation.
    if (receipt && receipt.chatSessionId !== chatSessionIdRef.current) {
      return null;
    }
    return receipt;
  }, []);

  /**
   * Take whether the turn that just ended was aborted.
   *
   * Consuming, like {@link consumePersistReceipt}: the answer describes exactly
   * one turn, and a leftover `true` would tell the next turn's post-stream
   * reconciliation to stand down when it should be watching.
   *
   * Deliberately NOT session-scoped the way the receipt is. The receipt carries
   * data (a version) that would be actively wrong if applied to another thread;
   * this is a bare "nothing was written", which is true of the aborted turn no
   * matter which thread the surface is on when it reads it.
   */
  const consumeTurnAborted = useCallback((): boolean => {
    const aborted = turnAbortedRef.current;
    turnAbortedRef.current = false;
    return aborted;
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
  // chat-specific (scenario embeds resolve a host-provided project context).
  const outOfCredits = useOutOfCredits();
  const { hostedCatalog } = useHostedModelCatalog();
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
        hostedCatalog,
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
      hostedCatalog,
    ]
  );

  // Model selection with persistence
  const {
    selectedModelId,
    setSelectedModelId,
    selectedModelIds,
    setSelectedModelIds: persistSelectedModelIds,
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

  // Whether the persisted lead selection actually resolved against
  // `availableModels`. It does NOT while an org-managed provider config is in
  // flight: that's a Convex query, so for the first render(s) after a load
  // `composeAvailableModels` takes the local-BYOK branch and the user's
  // org-key model simply isn't in the list yet. `selectedModel` is a derived
  // fallback during that window, and any caller that mirrors it back into
  // storage would overwrite the real choice — which is what made an
  // own-provider model look like it never survived a new chat. See
  // BACK2-628.
  const isSelectedModelResolved = useMemo(() => {
    if (initialModelId) return true;
    if (!selectedModelId) return true;
    return availableModels.some(
      (model) => String(model.id) === selectedModelId
    );
  }, [availableModels, initialModelId, selectedModelId]);

  const tokenCountSelectionKey = useMemo(() => {
    if (!selectedModel?.id || !selectedModel?.provider) return "";
    const modelId = isMCPJamProvidedModelMenuItem(selectedModel)
      ? String(selectedModel.id)
      : `${selectedModel.provider}/${selectedModel.id}`;
    return `${selectedServersSignature}\u0001${modelId}`;
  }, [selectedModel, selectedServersSignature]);
  const lastObservedTokenCountSelectionKeyRef = useRef<string | null>(null);

  const setSelectedModel = useCallback(
    (model: ModelDefinition, options?: SetSelectedModelOptions) => {
      if (initialModelId) {
        return;
      }
      // Remember own-provider picks separately from the lead selection so the
      // out-of-credits → "bring your own key" hand-off can restore the model
      // the user actually wants instead of re-deriving one from list order.
      // See `loadLastOwnProviderModelId` / BACK2-628.
      //
      // Only a pick from the menu counts. This setter is also how a history
      // session and an eval hand-off restore *their* model, and letting those
      // write would mean opening an old thread silently re-aims the next
      // hand-off at whatever that thread happened to run on. Off by default so
      // a new caller has to say it meant it.
      if (options?.userInitiated && !isMCPJamProvidedModelMenuItem(model)) {
        saveLastOwnProviderModelId(String(model.id));
      }
      setSelectedModelId(String(model.id));
    },
    [initialModelId, setSelectedModelId]
  );

  const setSelectedModelIds = useCallback(
    (modelIds: string[]) => {
      // A surface with a pinned model — a hosted scenario or share link,
      // where `executionConfig.modelId` names the model the scenario owner
      // chose — is not expressing *this* user's choice. `setSelectedModel`
      // already no-ops for that reason; this setter has to as well, because
      // it ends in `saveSelectedModelId` (`use-persisted-model.ts:150-159`)
      // and so writes the same global lead key. Without the guard, opening a
      // share link overwrote the model the user had selected in their own
      // chats — the load-time clobber of BACK2-628, by a second route that
      // `isSelectedModelResolved` cannot gate (it short-circuits to true
      // whenever `initialModelId` is set).
      if (initialModelId) {
        return;
      }
      persistSelectedModelIds(modelIds);
    },
    [initialModelId, persistSelectedModelIds]
  );

  const isMcpJamModel = useMemo(() => {
    return selectedModel ? isMCPJamProvidedModelMenuItem(selectedModel) : false;
  }, [selectedModel]);
  const selectedModelUsesOrgRuntime = useMemo(
    () => isOrgManagedModel(hostedOrgModelConfig, selectedModel),
    [hostedOrgModelConfig, selectedModel]
  );
  const hasLocalOnlySelectedServer = useMemo(() => {
    if (!appState || selectedServers.length === 0) return false;
    const activeProject = findProjectByAnyId(
      appState.projects,
      hostedProjectId ?? appState.activeProjectId
    );
    return selectedServers.some((serverName) => {
      const server =
        appState.servers?.[serverName] ?? activeProject?.servers?.[serverName];
      // Fail CLOSED when a selected server's config can't be resolved (state
      // not yet loaded, name mismatch): treat it as local-only. The local
      // engine reaches public servers fine, but routing a stdio server to the
      // cloud reproduces the exact "STDIO not supported" failure this flag
      // exists to prevent.
      if (!server?.config) return true;
      return isLocalOnlyMcpServerConfig(server.config);
    });
  }, [appState, hostedProjectId, selectedServers]);
  const localMcpRuntimeRequired =
    !HOSTED_MODE &&
    !hostedRequiresWebChatApi &&
    selectedModelUsesOrgRuntime &&
    hasLocalOnlySelectedServer;
  const isHostedTransport = HOSTED_MODE || hostedRequiresWebChatApi;
  const shouldUseOrgAwareChatApi =
    isHostedTransport ||
    (selectedModelUsesOrgRuntime && !localMcpRuntimeRequired);
  const traceViewsSupported = HOSTED_MODE
    ? isMcpJamModel || selectedModelUsesOrgRuntime
    : true;

  // Last thing `chatFetch` saw. This is the ONLY place the Response object
  // still exists — the AI SDK turns a non-ok response into
  // `new Error(await response.text())` and the status, content type, and
  // request id are gone by the time `handleChatError` runs.
  const lastChatResponseRef = useRef<ChatResponseMeta | null>(null);

  const chatFetch = useCallback(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      // Clear BEFORE awaiting, not just on the way out. If this turn's fetch
      // rejects outright — DNS failure, connection refused, offline — no
      // Response is ever produced and the ref would still hold the PREVIOUS
      // turn's values, so `handleChatError` would report a fresh network
      // failure under the last turn's status and, worse, under a request id
      // belonging to a different request.
      lastChatResponseRef.current = null;

      // Resolve the WorkOS / guest bearer at request time for every chat
      // route. authFetch attaches it only to allowlisted Convex-backed paths,
      // including both /api/web/chat-v2 and local /api/mcp/chat-v2.
      let response = await authFetch(input, init);

      // Scenario access recovery. A scenario turn re-resolves its authoritative
      // config server-side on every send, so an open tab can lose access
      // between one send and the next — a rebind, a mode round-trip, a
      // rotated guest identity. The refusal lands here PRE-STREAM (the route
      // fails closed during turn setup, before a single token reaches the
      // parser and while `useChat` is still awaiting this promise), which is
      // the one place a re-redeem + replay is invisible to the tester.
      //
      // DENIED is retried as well as STALE: /redeem re-mints the grant for an
      // `anyone_with_link` scenario, so most "denied" verdicts are recoverable
      // identity drift rather than a real refusal. Exactly ONE recovery per
      // send — the replay's own verdict is final.
      if (
        !response.ok &&
        isHostedTransport &&
        hostedScenarioId &&
        typeof init?.body === "string" &&
        hostedRefreshAccessSession
      ) {
        const accessError = await classifyScenarioAccessResponse(response);
        if (accessError) {
          const recovery = await hostedRefreshAccessSession();
          if (recovery.ok) {
            // Byte-identical replay except for the field that went stale.
            // `init.signal` rides along in the spread, so Stop still aborts.
            response = await authFetch(input, {
              ...init,
              body: patchBodyAccessVersion(init.body, recovery.accessVersion),
            });
            if (!response.ok) {
              const replayError = await classifyScenarioAccessResponse(
                response
              );
              if (replayError?.kind === "denied") {
                hostedOnAccessRevoked?.(replayError);
              }
            }
          } else if (recovery.reason === "denied") {
            hostedOnAccessRevoked?.(recovery.error);
          }
          // "transient" / "no_token" fall through deliberately: the original
          // error surfaces in the normal banner and the next send is a fresh
          // chatFetch that gets to recover again.
        }
      }

      // Stash on every outcome, including ok: a stream that fails partway
      // through still wants the request id that opened it.
      lastChatResponseRef.current = {
        ok: response.ok,
        status: response.status,
        contentType: response.headers.get("content-type") ?? undefined,
        requestId: response.headers.get("x-request-id") ?? undefined,
        // The route's own verdict on whose fault this was, when it had the
        // error object in hand. Read from a header because the body is
        // consumed by the AI SDK before the reporter ever runs.
        origin: response.headers.get("x-mcpjam-error-origin") ?? undefined,
      };

      if (!response.ok) {
        await notifyMCPJamLimitErrorFromResponse(response);
        if (isHostedTransport) {
          await ingestHostedRpcLogsFromResponse(response);
        }
      }
      return response;
    },
    [
      hostedRequiresWebChatApi,
      isHostedTransport,
      hostedScenarioId,
      hostedRefreshAccessSession,
      hostedOnAccessRevoked,
    ]
  );

  const handleChatError = useCallback((chatError: Error) => {
    // Every chat failure used to end here and go no further: this handler
    // passed the error only to `notifyMCPJamLimitError`, a rate-limit filter
    // that no-ops everything else. A hosted 502 produced zero client
    // telemetry — the failure a user reported was one we had no record of.
    reportChatFailure(chatError, lastChatResponseRef.current);

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
  // Convex server ids resolved by the hosted preflight (`hostedEnsureServerIds`)
  // in `sendMessage`, consumed once by the (synchronous) transport body so the
  // hosted send carries real ids for ad-hoc/App servers, not display names.
  // Carries the NAMES snapshot the ids were resolved from, so a selection
  // change during the async preflight can't pair stale ids with fresh names.
  const resolvedHostedServersRef = useRef<{
    serverIds: string[];
    serverNames: string[];
  } | null>(null);
  // The auth/org scope the CURRENT turn started under, captured once at
  // submit (in the transport body builder) and read by the task-created
  // data-part handler. A task created by a turn belongs to the scope the turn
  // was submitted under — never to whatever scope happens to be active when a
  // late part arrives after a project switch.
  const turnTaskScopeRef = useRef<string | undefined>(undefined);

  const transport = useMemo(() => {
    const shouldSendClientApiKey =
      !shouldUseOrgAwareChatApi && !selectedModelUsesOrgRuntime;
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

    // NEITHER credential is snapshotted here. authFetch calls the very same
    // `getAuthHeaders()` at request time, and `buildAuthFetchInit` merges
    // `init.headers` LAST — so a copy taken when this memo ran would override
    // the fresh one. That is not theoretical: the local dev server mints a new
    // session token on every restart, and this memo (which no longer depends
    // on `authHeaders`) can outlive several of them, so the stale copy won the
    // merge and the route answered 401 "Invalid session token". authFetch's
    // own 401 session-recovery could not rescue it either — its retry rebuilds
    // from the same `init`, re-applying the same stale header.
    const mergedHeaders = {} as Record<string, string>;
    // Consent capability for the local computer engine — a header, never the
    // body, so it can't land in a persisted transcript. Only on a direct
    // (non-scenario) turn whose resolved engine is local; the server re-checks
    // !HOSTED_MODE + non-guest + non-scenario + verifies the token.
    //
    // Scoped to the /api/mcp/chat-v2 path (`!shouldUseOrgAwareChatApi`): the
    // local engine only exists on the local server's mcp route (both this
    // transmission AND the server-side resolver live there). An org-runtime
    // model routes to /api/web/chat-v2, which has no local engine — so we send
    // nothing local there (no stray consent header on the web route) and that
    // turn's bash resolves cloud, as it must. Local engine + org model is a
    // deliberate non-combo in v1.
    const sendLocalEngine =
      !shouldUseOrgAwareChatApi &&
      resolvedLocalEngine &&
      !hostedScenarioId &&
      Boolean(localConsentToken) &&
      authIsMemberRef.current;
    if (sendLocalEngine && localConsentToken) {
      mergedHeaders[LOCAL_CONSENT_HEADER] = localConsentToken;
    }
    // Only the local-computer consent capability rides the transport, because
    // it is not a credential authFetch knows how to resolve.
    const transportHeaders =
      Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;

    const chatApi = shouldUseOrgAwareChatApi
      ? "/api/web/chat-v2"
      : "/api/mcp/chat-v2";

    // Hosted dashboard guests and signed-in users both require a project id.
    // Submit is blocked until hostedProjectId and selected server ids resolve.
    const buildHostedBody = () => {
      if (!hostedProjectId) {
        throw new Error("Hosted chat context is not ready: missing projectId.");
      }
      const isHostedDirectChat = !hostedScenarioId;
      // Prefer ids resolved by the `sendMessage` preflight (ad-hoc/App servers
      // persisted to real Convex ids); consume once. Fall back to the
      // pre-resolved selection for surfaces without a preflight (e.g. scenario).
      const preflight = resolvedHostedServersRef.current;
      resolvedHostedServersRef.current = null;
      const hostedServerBatch = buildResolvedServerBatchRequest({
        projectId: hostedProjectId,
        serverIds: preflight?.serverIds ?? hostedSelectedServerIds,
        serverNames: preflight?.serverNames ?? selectedServers,
        accessScope: "chat_v2",
        ...(isHostedDirectChat &&
        hostedOAuthTokens &&
        Object.keys(hostedOAuthTokens).length > 0
          ? { oauthTokens: hostedOAuthTokens }
          : {}),
        ...(hostedScenarioId ? { scenarioId: hostedScenarioId } : {}),
        ...(hostedScenarioId && Number.isFinite(hostedAccessVersion)
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
        // Handshake: tells the server this bundle can render an elicitation
        // prompt. Catalog hosts already declare the capability, so without
        // this a stale bundle would leave the turn blocked for a full TTL on
        // any server that elicits. The server only registers its callback —
        // and therefore only advertises `elicitation` — when it sees this.
        hostedElicitationVersion: HOSTED_ELICITATION_VERSION,
        // Handshake: tells the server this bundle can render a suspended MRTR
        // (`input_required`) round AND resume it (§12.5). The server only
        // registers the suspending collector — and therefore only takes the
        // durable continuation path — when it sees this, so a stale bundle is
        // never handed a `continuationId` it can do nothing with.
        hostedMrtrVersion: HOSTED_MRTR_VERSION,
        // Handshake: tells the server this bundle can track a task the turn
        // creates. Unlike the two above, a mismatch here is NOT fatal — the
        // server simply skips the bridge. The task already exists on the MCP
        // server, so refusing the turn would fail a call that succeeded.
        hostedTasksVersion: HOSTED_TASKS_VERSION,
        ...(isHostedDirectChat ? { directVisibility } : {}),
        // What this turn executes against. EXACTLY ONE of these two shapes ever
        // ships: `normalizeExecutionTarget` 400s on `hostId` + `executionTarget`
        // rather than picking a winner, because a body with both is a client bug
        // and silently honoring one is how a user ends up watching a turn run
        // against a configuration they didn't choose.
        //
        // Environment target: `environmentOverrides` rides along ONLY when the
        // caller explicitly overrode. `selectedServerIds` above still describes
        // the UI selection during migration, and the server deliberately ignores
        // it for an environment target — override intent is never inferred from
        // it.
        ...(hostedExecutionTarget
          ? {
              executionTarget: hostedExecutionTarget,
              ...(hostedEnvironmentId && hostedEnvironmentOverrides
                ? { environmentOverrides: hostedEnvironmentOverrides }
                : {}),
            }
          : // Host-bound direct preview: forward the saved host id so the server
          // re-resolves the host's authoritative runtime config (harness /
          // computer included). Only on the direct path — scenario sessions own
          // their host via scenarioId and the server ignores hostId when
          // scenarioId is set.
          isHostedDirectChat && hostedHostId
          ? { hostId: hostedHostId }
          : {}),
        ...(hostedScenarioId && hostedScenarioSurface
          ? { surface: hostedScenarioSurface }
          : {}),
      };
    };

    return new DefaultChatTransport({
      api: chatApi,
      fetch: chatFetch,
      body: () => {
        // Capture the task scope this turn is SUBMITTED under, next to
        // `buildHostedBody` (which hard-requires the project id): hosted
        // turns scope created tasks by the turn's project, non-hosted turns
        // by the tracker's active scope. Captured here — never read live in
        // the data-part handler, whose closure is recreated on a project
        // switch and would stamp the NEW project on a late part.
        turnTaskScopeRef.current = shouldUseOrgAwareChatApi
          ? hostedProjectId ?? undefined
          : getTrackedTaskScope();
        const widgetModelContext = pendingWidgetModelContextRef.current;
        pendingWidgetModelContextRef.current = undefined;
        const rewind =
          rewindRef.current?.chatSessionId === chatSessionIdRef.current
            ? rewindRef.current.lineage
            : undefined;
        return {
          model: selectedModel,
          ...(shouldSendClientApiKey ? { apiKey } : {}),
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
                // /mcp/chat-v2 route gates it off when scenarioId is present
                // (owner-preview persists as `sourceType: "scenario"`), but
                // omitting it client-side keeps the body honest about the
                // session kind.
                ...(hostedScenarioId ? {} : { directVisibility }),
                // Host-bound direct preview: forward the saved host id so the
                // server re-resolves harness/computer authoritatively. Direct
                // path only — omitted when a scenario owns the host.
                //
                // NO `executionTarget` here, by design: the local /api/mcp
                // engine cannot resolve an environment (it has no Convex read
                // for the bundle) and 400s on the target. Environment-mode
                // surfaces set `requiresWebChatApi`, which routes them to
                // /api/web/chat-v2 above, so this branch is unreachable in
                // environment mode — and if a caller ever gets it wrong, the
                // turn runs as a plain host turn rather than silently claiming
                // to be an environment run.
                ...(!hostedScenarioId && !hostedExecutionTarget && hostedHostId
                  ? { hostId: hostedHostId }
                  : {}),
                // "This machine": run this host's bash on the local computer
                // engine. The consent capability rides the header above; the
                // server ignores this without it (and off the /mcp direct
                // path). Absent ⇒ the legacy cloud-family resolution.
                ...(sendLocalEngine
                  ? { computerEngine: "local" as const }
                  : {}),
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
                ...(localMcpRuntimeRequired
                  ? { localMcpRuntimeRequired: true }
                  : {}),
                // Phase F: owner-preview / local scenario sessions persist as
                // `sourceType: "scenario"`. Without forwarding the resolved
                // scenario identity here, /mcp/chat-v2 derives sourceType
                // from absent fields and the chat is filed as a direct chat
                // instead of a scenario session.
                ...(hostedScenarioId ? { scenarioId: hostedScenarioId } : {}),
                ...(hostedScenarioId && Number.isFinite(hostedAccessVersion)
                  ? { accessVersion: hostedAccessVersion }
                  : {}),
                ...(hostedScenarioId && hostedScenarioSurface
                  ? { surface: hostedScenarioSurface }
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
          ...(modelVisibleMcpToolResultsRef.current !== undefined
            ? {
                modelVisibleMcpToolResults:
                  modelVisibleMcpToolResultsRef.current,
              }
            : {}),
          ...(mcpToolResultImageRenderingRef.current !== undefined
            ? {
                mcpToolResultImageRendering:
                  mcpToolResultImageRenderingRef.current,
              }
            : {}),
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
          ...(shouldSendClientApiKey && customProviders.length > 0
            ? { customProviders }
            : {}),
          ...(resumedVersionRef.current !== null
            ? { expectedVersion: resumedVersionRef.current }
            : {}),
          ...(rewind ? { rewind } : {}),
          // Host-managed built-in tools (e.g. ["web_search"]). Forwarded only
          // when non-empty so pre-feature traces stay byte-identical. The
          // scenario path overrides this with the persisted host config server-
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
          // WebMCP page tools, when the caller opted this turn into the tools
          // of an open inspector session. Drained fresh at POST time for the
          // same reason as `appTools`: the page may have registered or dropped
          // tools since the last turn. `setAdvertisedPageTools` records what
          // this turn advertised so an alias in the response resolves back to
          // the tool it stood for.
          ...(usePageToolsRef.current
            ? { pageTools: snapshotPageToolsForTurn() }
            : {}),
          // MCPJam UI tools are agent-surface-only; the only uiTools sender
          // is agent-chat-instances.ts (/api/web/mcpjam-agent).
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
    selectedModelUsesOrgRuntime,
    localMcpRuntimeRequired,
    hostedRequiresWebChatApi,
    shouldUseOrgAwareChatApi,
    temperature,
    systemPrompt,
    selectedServers,
    directVisibility,
    hostedProjectId,
    chatSessionId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    hostedScenarioId,
    hostedHostId,
    hostedExecutionTarget,
    hostedEnvironmentId,
    hostedEnvironmentOverrides,
    hostedAccessVersion,
    hostedScenarioSurface,
    getOllamaBaseUrl,
    getAzureBaseUrl,
    hostStyle,
    chatFetch,
    // Local computer engine: rebuild the transport when the resolved engine or
    // consent token changes, so the header/body reflect a grant or toggle on
    // the very next turn.
    resolvedLocalEngine,
    localConsentToken,
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

  // Held until the entire userless resume request settles. AI SDK evaluates
  // `sendAutomaticallyWhen` before `sendMessage` resolves, so this fence
  // prevents the generic tool-output rule from recursively submitting the
  // same one-shot continuation descriptor.
  const scopeStepUpResumeInFlightRef = useRef(false);

  // useChat hook
  const {
    messages,
    sendMessage: baseSendMessage,
    stop,
    status,
    error,
    setMessages: baseSetMessages,
    addToolApprovalResponse: sdkAddToolApprovalResponse,
    addToolOutput,
  } = useChat({
    id: chatSessionId,
    transport: proxyTransport,
    onData: handleStreamDataPart,
    onError: handleChatError,
    // Records whether the turn was aborted, for `consumeTurnAborted`. Runs in
    // the SDK's `finally` — after `setStatus({ status: "ready" })` but before
    // React renders that status — so a post-stream effect reading it on the
    // ready transition always sees THIS turn's answer. Same ordering guarantee
    // the persist receipt already relies on.
    onFinish: ({ isAbort }) => {
      turnAbortedRef.current = isAbort;
    },
    // SEP-1865 App-Provided Tools: AI SDK v6 IGNORES the return value of
    // `onToolCall`. Tool results must be supplied imperatively via
    // `addToolOutput(...)`. Server-tool calls bypass this handler (they
    // resolve via the server's `execute` function); client-fulfilled app and
    // page aliases land here.
    onToolCall: async ({ toolCall }) => {
      const toolName = (toolCall as { toolName: string }).toolName;

      // WebMCP page tools: the model asked for a tool a real web page
      // registered, and the browser session that owns that page lives in this
      // app. Claim it synchronously and wait for the approval pill to fulfill
      // it. AI SDK delivers tool-input-available before tool-approval-request,
      // so invoking here would bypass the user's decision.
      if (
        deferPageToolCallForApproval({
          toolName,
          toolCallId: (toolCall as { toolCallId: string }).toolCallId,
          input: (toolCall as { input: unknown }).input,
        })
      ) {
        return;
      }

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
          useTrafficLogStore.getState().addLog
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
    // Resume only browser-fulfilled app/UI calls. Server-executed MCP calls
    // already have their result in this response; posting them again would
    // create a redundant turn and can reuse a one-shot scope continuation.
    // Preserve main's BUG-4 guard: a pending approval must never be answered
    // by an automatic follow-up.
    sendAutomaticallyWhen: (options) => {
      if (lastStepHasPendingApproval(options)) return false;
      if (
        shouldAutoSendCompletedClientToolCalls(
          options,
          scopeStepUpResumeInFlightRef.current
        )
      ) {
        return true;
      }
      return lastAssistantMessageIsCompleteWithApprovalResponses(options);
    },
  });
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // UI/page tools are client-fulfilled. Their approval response must be
  // routed through the shared defer/fulfill handler; a raw AI SDK approval
  // response would leave a no-execute page tool without a result.
  const addToolApprovalResponse = useMemo(
    () =>
      createUiAwareApprovalResponseHandler({
        getMessages: () => messagesRef.current,
        addToolApprovalResponse: sdkAddToolApprovalResponse,
        addToolOutput,
      }),
    [sdkAddToolApprovalResponse, addToolOutput],
  );

  useEffect(() => {
    const sessionId = chatSessionIdRef.current;
    if (!sessionId) return;
    const pending = readPendingChatScopeStepUp();
    if (
      !pending ||
      (pending.phase !== "ready" && pending.phase !== "cancelled") ||
      pending.chatSessionId !== sessionId ||
      !hasChatToolCall(messagesRef.current, pending.event.toolCallId) ||
      status !== "ready"
    ) {
      return;
    }
    if (pending.phase === "ready") {
      const server = resolveScopeStepUpServer(appState, {
        serverId: pending.event.serverId,
        serverName: pending.event.serverName,
        projectId: hostedProjectId,
      });
      if (!server || server.connectionStatus !== "connected") {
        return;
      }
    }
    const claimed =
      pending.phase === "ready"
        ? claimPendingChatScopeStepUp(sessionId)
        : claimCancelledChatScopeStepUp(sessionId);
    if (!claimed) return;
    const wasCancelled = pending.phase === "cancelled";

    scopeStepUpResumeInFlightRef.current = true;
    void baseSendMessage(undefined, {
      body: {
        ...(wasCancelled
          ? {
              scopeStepUpCancel: {
                continuationId: claimed.event.continuationId,
                toolCallId: claimed.event.toolCallId,
              },
            }
          : {
              scopeStepUpResume: {
                continuationId: claimed.event.continuationId,
                toolCallId: claimed.event.toolCallId,
              },
            }),
      },
    })
      .then(() => {
        clearPendingChatScopeStepUp(claimed.event.continuationId);
      })
      .catch(() => {
        clearPendingChatScopeStepUp(claimed.event.continuationId);
        toast.error(
          wasCancelled
            ? "Authorization was cancelled, but the suspended tool call could not be updated."
            : "The authorized tool call could not be resumed safely. Check whether it ran before retrying manually."
        );
      })
      .finally(() => {
        scopeStepUpResumeInFlightRef.current = false;
      });
  }, [appState, baseSendMessage, hostedProjectId, messages, status]);

  /**
   * Resume a suspended hosted MRTR operation (§12.5) by re-driving a chat turn
   * that carries the `mrtrResume` descriptor. The server claims the durable
   * continuation, drives one retry leg, splices the real tool result into the
   * suspended tool-call, and resumes the agent loop — a further round arrives
   * as another `data-mrtr-input-required` part on that same turn.
   *
   * This is deliberately NOT the direct `/api/web/mrtr/resume` route: that one
   * drives the leg in isolation and has nowhere to put the result, so a chat
   * resumed through it would complete server-side while the transcript kept an
   * unresolved tool-call forever.
   */
  const submitMrtrResume = useCallback(
    async (
      round: HostedMrtrRound,
      responses: Record<string, MrtrElicitationResponse>
    ) => {
      const toolCallId = findUnresolvedMrtrToolCallId(
        messagesRef.current,
        round.operationLabel
      );
      if (!toolCallId) {
        // Nothing to splice the driven result into (history was reset/forked
        // under the dialog). Withdraw rather than send a resume the server
        // would consume against a tool-call that no longer exists.
        void cancelHostedMrtrContinuation({
          continuationId: round.continuationId,
          reason: "no unresolved tool call to resume",
        }).catch(() => {});
        toast.error(
          "This chat no longer has the tool call that needed input, so the operation was cancelled."
        );
        return;
      }
      // Fire the turn without awaiting the whole stream: the round is answered
      // the moment the request is dispatched, and holding the dialog's
      // `responding` flag for the turn's lifetime would freeze the NEXT round's
      // dialog behind a spinner. Stream failures surface through `onError`.
      void baseSendMessage(undefined, {
        body: buildMrtrChatResumeBody({
          toolCallId,
          serverId: round.serverId,
          continuationId: round.continuationId,
          round: round.round,
          responses,
        }),
      }).catch((error) => {
        console.warn("[hosted-mrtr] resume turn failed", error);
      });
    },
    [baseSendMessage]
  );
  mrtrResumeSenderRef.current = submitMrtrResume;

  // SEP-2350: hold chat-triggered scope step-ups for the duration of the turn.
  //
  // The redirect that re-authorization performs is a full-page navigation, and
  // the server writes the transcript only after this stream drains. Redirecting
  // the moment the `403 insufficient_scope` arrives therefore destroys the turn
  // that motivated it. Holding across the turn — and then briefly across
  // persistence — is what lets the user come back to a transcript that still
  // shows the failed tool call.
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const statusRef = useRef(status);
  statusRef.current = status;
  const hostedProjectIdRef = useRef(hostedProjectId);
  hostedProjectIdRef.current = hostedProjectId;

  // Bounded wait for the turn to land server-side. There is no "persisted"
  // event on the wire, so this polls the same detail row the post-stream
  // refresh does. It always resolves: persistence is worth a moment's delay,
  // never worth withholding authorization over.
  const turnStartVersionRef = useRef<number | null>(null);
  const waitForTurnPersisted = useCallback(async () => {
    const sessionId = chatSessionIdRef.current;
    if (!sessionId) return;
    // Captured at turn start: by the time this runs the post-stream refresh may
    // already have advanced the local cursor, and comparing against that would
    // never register the bump we are waiting for.
    const baselineVersion = turnStartVersionRef.current;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      // This is only a best-effort confirmation after the chat response has
      // already drained. A stalled history endpoint must not postpone OAuth
      // until the 15-second emergency hold fires.
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 750);
      try {
        const detail = await getChatHistoryDetail(
          {
            chatSessionId: sessionId,
            projectId: hostedProjectIdRef.current ?? undefined,
          },
          { signal: controller.signal }
        );
        const version = detail?.session?.version;
        // A brand-new chat is persisted the moment the row exists; a resumed
        // thread needs the version to move past what we sent against.
        if (
          baselineVersion === null ||
          (typeof version === "number" && version > baselineVersion)
        ) {
          return;
        }
      } catch {
        // Keep trying; the loop bound is the real deadline.
      } finally {
        window.clearTimeout(timeoutId);
      }
    }
  }, []);
  const waitForTurnPersistedRef = useRef(waitForTurnPersisted);
  waitForTurnPersistedRef.current = waitForTurnPersisted;

  // Depend on the derived boolean, not `status`: the submitted → streaming
  // transition is mid-turn, and re-running on it would release the hold (and
  // fire the redirect) while the stream is still open.
  const isTurnActive = status === "submitted" || status === "streaming";
  useEffect(() => {
    if (!isTurnActive) return;
    turnStartVersionRef.current = resumedVersionRef.current;
    // The handle identifies THIS lane: compare mode runs one of these hooks per
    // lane, and the hold has to know which turns are still live.
    const hold = beginChatTurnScopeStepUpHold(() => stopRef.current());
    return () => {
      // A turn that errored has nothing left to persist — don't make the user
      // wait out a poll that cannot succeed.
      endChatTurnScopeStepUpHold(
        hold,
        statusRef.current === "error"
          ? undefined
          : waitForTurnPersistedRef.current
      );
    };
  }, [isTurnActive]);

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
    // Scenario runtime sessions persist server-side on every platform, so
    // their widget capture follows the session kind, not the build.
    enabled: (HOSTED_MODE || hostedRequiresWebChatApi) && isAuthenticated,
    readyToPersist: status === "ready",
    chatSessionId,
    hostedScenarioId,
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
      // SEP-2350 turn boundary: a new user turn spins up a fresh per-turn MCP
      // client (`web-chat-turn.ts` disconnects the prior one), and each new
      // client RESTARTS its numeric JSON-RPC ids from scratch. Any `tools/call`
      // id still pending from a prior turn — e.g. one whose only reply was an
      // `insufficient_scope` error with no per-id error response logged — is now
      // stale, and a later turn's SUCCESSFUL `initialize`/`tools/list` could
      // reuse that id and wrongly reset the bounded step-up budget. Drop them
      // here so correlation only ever matches ids minted within the same turn.
      // (Only genuinely NEW user turns flow through this wrapper; in-turn
      // continuations — tool-approval responses, tool outputs — reuse the same
      // client and go through `addToolApprovalResponse`/`addToolOutput`.)
      chatToolCallRequestIdsRef.current.clear();
      const extra = metadata ? ({ metadata } as { metadata: unknown }) : {};
      pendingWidgetModelContextRef.current =
        widgetModelContext && widgetModelContext.length > 0
          ? widgetModelContext
          : undefined;
      // Resolves `true` once `baseSendMessage` has actually been invoked, and
      // `false` on every fail-closed path below. The preflight bails by
      // RETURNING (after surfacing its own toast), not by rejecting, so a caller
      // that merely awaits this promise cannot tell "sent" from "swallowed" —
      // `rewindToMessage` needs that distinction to avoid announcing a branch
      // whose turn never ran. Callers that fire-and-forget are unaffected.
      return (async (): Promise<boolean> => {
        // Hosted preflight: resolve selected runtime server NAMES → persisted
        // Convex ids (persisting ad-hoc/App servers) BEFORE the synchronous
        // transport body builds, so the hosted send never carries a display
        // name. Only on the web-engine path, and only when the surface provided
        // a resolver (Playground). On failure, fail the send CLOSED with a
        // visible toast (callers fire-and-forget, so don't reject).
        const usesWebEngine = shouldUseOrgAwareChatApi;
        // Snapshot the selection ONCE: the resolved ids must ride with the
        // names they were resolved from, even if the user edits the selection
        // while the preflight is in flight.
        const serverNamesSnapshot = selectedServers;
        // Snapshot the session this message was composed against. `useChat` is
        // wired to `proxyTransport`, which delegates at REQUEST time to
        // `latestTransportRef.current` — reassigned every render — so the POST
        // body carries whatever `chatSessionId` is live when it fires, not the
        // one this send was bound to. That indirection is what makes
        // `rewindToMessage`'s branch work; it also means a session change
        // during the preflight below would post this turn under an unrelated
        // session and ingest it into that transcript.
        const sessionAtSend = chatSessionIdRef.current;
        // NEVER for an environment target. The environment's servers already
        // carry authoritative Convex ids and are re-resolved server-side; some
        // of them are plugin-contributed and deliberately absent from
        // `servers:getProjectServers`, so resolving them BY NAME would either
        // fail outright or persist a shadow copy that bypasses plugin lifecycle
        // semantics. Environment servers travel by id or not at all.
        if (
          usesWebEngine &&
          !hostedEnvironmentId &&
          hostedEnsureServerIds &&
          serverNamesSnapshot.length > 0
        ) {
          const targetAtSend = hostedTargetKeyRef.current;
          try {
            const resolved = await hostedEnsureServerIds(serverNamesSnapshot);
            // The user changed what this Playground runs against (host → an
            // environment, or a different host) while the preflight was in
            // flight. The transport that would now carry this message belongs
            // to the NEW target, so sending would run a message composed for
            // one bundle against another. Fail closed and let the user resend.
            if (hostedTargetKeyRef.current !== targetAtSend) {
              pendingWidgetModelContextRef.current = undefined;
              resolvedHostedServersRef.current = null;
              toast.error(
                "The chat target changed while this message was being prepared. Send it again to run it against the current selection."
              );
              return false;
            }
            // Same class of guard, on the session rather than the target: the
            // thread moved (new chat, a history thread, or a rewind branch)
            // while this message was being prepared, so the POST would land in
            // a transcript this message was never composed for. Fail closed.
            if (chatSessionIdRef.current !== sessionAtSend) {
              pendingWidgetModelContextRef.current = undefined;
              resolvedHostedServersRef.current = null;
              toast.error(
                "The chat changed while this message was being prepared. Send it again to run it in the current thread."
              );
              return false;
            }
            resolvedHostedServersRef.current = {
              serverIds: resolved.map((r) => r.serverId),
              serverNames: serverNamesSnapshot,
            };
          } catch (error) {
            pendingWidgetModelContextRef.current = undefined;
            resolvedHostedServersRef.current = null;
            toast.error(
              error instanceof Error
                ? error.message
                : "Couldn't prepare the selected servers for this run."
            );
            return false; // fail closed — do not send with unresolved servers
          }
        }
        try {
          if (files && files.length > 0) {
            // AI SDK accepts FileUIPart[] with data URLs
            baseSendMessage({ text, files, ...extra });
          } else {
            baseSendMessage({ text, ...extra });
          }
        } catch (error) {
          pendingWidgetModelContextRef.current = undefined;
          resolvedHostedServersRef.current = null;
          throw error;
        }
        return true;
      })();
    },
    [
      baseSendMessage,
      hostedEnsureServerIds,
      hostedEnvironmentId,
      selectedServers,
      shouldUseOrgAwareChatApi,
    ]
  );

  // `sendMessage` is NOT a stable function, and callers that cross an `await`
  // must not hold onto it. `useChat` recreates its internal `Chat` whenever its
  // `id` changes, and the `sendMessage` it returns is a per-instance arrow
  // property bound to THAT instance's private message state. `baseSendMessage`
  // is therefore a new identity after every session change, which propagates
  // into this wrapper (it lists `baseSendMessage` in its deps).
  //
  // `rewindToMessage` awaits a session change and then sends. A closure-captured
  // `sendMessage` would send on the PRE-branch instance: the POST body would
  // carry the branch's `chatSessionId` (the transport proxy reads a ref) while
  // `messages` came from the original, untruncated store — and the response
  // would stream into a `Chat` nothing is rendering. Read it through this ref
  // instead, like `messagesRef`/`statusRef`/`chatSessionIdRef`.
  //
  // Assigned during render (not in an effect) so it is already fresh by the
  // time any layout effect — including the one that resolves session
  // hydration — runs.
  const sendMessageRef = useRef(sendMessage);
  sendMessageRef.current = sendMessage;

  // Reset chat
  const resetChat = useCallback(() => {
    skipNextForkDetectionRef.current = true;
    clearPendingSessionHydration();
    resumedModelVisibleMcpToolResultsRef.current = undefined;
    resumedMcpToolResultImageRenderingRef.current = undefined;
    rewindRef.current = null;
    setChatSessionId(generateId());
    setMessages([]);
    setPersistedSnapshotToolCallIds([]);
    setPendingElicitations([]);
    setUrlElicitationRequired([]);
    // A durable MRTR continuation survives its turn, so it is NOT cleared on
    // stream end like an elicitation — but a reset abandons the transcript its
    // result would splice into, so the rail is dropped here.
    useHostedMrtrStore.getState().clear();
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
      resumedModelVisibleMcpToolResultsRef.current = undefined;
      resumedMcpToolResultImageRenderingRef.current = undefined;
      rewindRef.current = null;
      // Resolve to the minted session id (not just a void hydration signal) so
      // callers can chain work that must run AFTER the seeded messages are
      // applied (e.g. the eval handoff sending a widget's `ui/message`
      // follow-up so the model replies to the seeded conversation) AND, per
      // `rewindToMessage`, so a caller can confirm ITS OWN id — not some
      // superseding session change — is the one that actually went live.
      // Existing callers that ignore the return value are unaffected.
      const nextSessionId = generateId();
      const hydrationPromise = queueSessionHydration({
        sessionId: nextSessionId,
        messages,
        resumedVersion: null,
        toolRenderOverrides: options?.toolRenderOverrides,
        persistedSnapshotToolCallIds: [],
      });
      onResetRef.current?.(options?.resetReason ?? "fork");
      return hydrationPromise.then(() => nextSessionId);
    },
    [queueSessionHydration]
  );

  /**
   * Rewind to a past user message and re-run the turn from edited text.
   *
   * BRANCHES instead of overwriting. Every turn ships the COMPLETE history to a
   * row keyed by `chatSessionId` (`server/utils/web-chat-turn.ts:845-849`,
   * `server/utils/chat-ingestion.ts:403`), so rewinding in place would replace
   * the original transcript with the truncated one — the messages would be gone
   * from the backend, not just from this tab.
   *
   * `startChatWithMessages` does the work: it mints a fresh `chatSessionId`
   * seeded with the prefix and resets `resumedVersion` to null, which drops
   * `expectedVersion` from the branch's first ingest and makes a 409 on that
   * write impossible.
   *
   * Deliberately does NOT pass `messageId` to the AI SDK. That mutates the Chat
   * store directly, so the wrapped `setMessages` never runs and no branch is
   * ever created.
   *
   * The `await` is load-bearing: the transport `body()` reads `chatSessionId`
   * from render scope, so sending before hydration lands would write this
   * turn to the ORIGINAL row.
   *
   * That await resolving is NOT proof the new id ever committed, though: a
   * superseded hydration (`clearPendingSessionHydration`, triggered by a
   * `loadChatSession`/`resetChat`/fork-detecting `setMessages` that lands
   * first) resolves the same promise — but the live id it leaves behind can
   * be either the ORIGINAL id (nothing else committed either) or some THIRD
   * id (the interloper's own session change won the race). Neither is safe
   * to send into: the first re-creates the original data-loss bug, the second
   * silently contaminates a session that has nothing to do with this branch.
   * `startChatWithMessages` now resolves to the id IT minted, so the
   * post-await check below can require an EXACT match against the live id —
   * not just "it changed from what it was" — and refuse either failure mode.
   *
   * Return value:
   * - `{ previousChatSessionId }` — the branch is live AND the edited turn was
   *   actually dispatched on it. Callers may report success and offer a way
   *   back to `previousChatSessionId`.
   * - `null` — nothing to report. Either no branch was created (refused
   *   mid-stream, target message gone, or a concurrent session switch won the
   *   race) or a branch was created but the send could NOT be dispatched — the
   *   `sendMessage` preflight failed closed, having already surfaced its own
   *   error toast. Callers must stay silent and must not touch bookkeeping.
   */
  const rewindToMessage = useCallback(
    async (options: {
      messageId: string;
      text: string;
      files?: Array<{
        type: "file";
        mediaType: string;
        filename?: string;
        url: string;
      }>;
      metadata?: Record<string, unknown>;
      /**
       * Runs immediately before the branch is minted, and ONLY then — every
       * refusal above this point returns without calling it.
       *
       * Callers detach from the resumed thread here (baseline, pending
       * selection, `resumedVersion`, the conversation URL). That has to happen
       * before the branch's turn starts, or the post-stream conflict check
       * captures a baseline naming the ORIGINAL thread. But doing it in the
       * caller *before* `rewindToMessage` meant a refusal left the session id
       * unchanged with its optimistic-concurrency guard already torn down: the
       * next ordinary send then rewrote the original's row carrying no
       * `expectedVersion`, silently clobbering turns another tab or device had
       * added. Deferring to this hook keeps the teardown and the branch
       * atomic — refuse early and the thread is untouched.
       */
      onBeforeBranch?: () => void;
    }): Promise<{ previousChatSessionId: string } | null> => {
      // Refuse only mid-flight. A failed turn ("error") is deliberately
      // allowed through — rewinding is the natural way to recover from one,
      // and the prefix excludes the broken tail by construction.
      if (
        statusRef.current === "submitted" ||
        statusRef.current === "streaming"
      ) {
        return null;
      }

      const targetIndex = messagesRef.current.findIndex(
        (message) => message.id === options.messageId
      );
      if (targetIndex < 0) {
        return null;
      }

      const previousChatSessionId = chatSessionIdRef.current;
      const prefix = messagesRef.current.slice(0, targetIndex);

      // Past every refusal that leaves the thread untouched — safe to detach.
      options.onBeforeBranch?.();

      const branchSessionId = await startChatWithMessages(prefix, {
        resetReason: "fork",
      });

      // An awaited resolve is not proof of commit: clearPendingSessionHydration
      // resolves a SUPERSEDED hydration too. If anything switched sessions in
      // that window, the live id is either still the original or some third
      // session an interloper installed — sending into either corrupts a row
      // that has nothing to do with this branch. Refuse instead.
      if (chatSessionIdRef.current !== branchSessionId) {
        return null;
      }

      rewindRef.current = {
        chatSessionId: branchSessionId,
        lineage: {
          parentChatSessionId: previousChatSessionId,
          rewoundFromMessageId: options.messageId,
          reason: "message_edit",
        },
      };

      // Read through the ref, NOT the closure: the `sendMessage` captured
      // before the await belongs to the pre-branch `Chat` instance and would
      // send the original untruncated history. See `sendMessageRef`.
      // Awaited, not fire-and-forget. `sendMessage` runs its own async preflight
      // (hosted server-id resolution) that can fail CLOSED — it surfaces its own
      // toast and returns without ever calling `baseSendMessage` — and by then
      // the branch has already been minted. Returning success before that
      // settles gave the user "New branch created" plus a server-resolution
      // error, sitting on a truncated prefix whose turn never ran and with the
      // original detached: exactly the orphan branch the pre-mint readiness
      // checks exist to prevent.
      //
      // Note the fail-closed paths RESOLVE rather than reject, so awaiting alone
      // proves nothing — hence the boolean. The try/catch covers the remaining
      // case where the underlying send throws, which would otherwise escape as
      // an unhandled rejection.
      let dispatched = false;
      try {
        dispatched = await sendMessageRef.current({
          text: options.text,
          files: options.files,
          metadata: options.metadata,
        });
      } catch {
        return null;
      }
      if (!dispatched) {
        return null;
      }

      return { previousChatSessionId };
    },
    [startChatWithMessages]
  );

  /**
   * Detach from a resumed history thread by forking the current transcript onto
   * a freshly minted `chatSessionId`, and CONFIRM the fork actually went live.
   *
   * Surfaces detach when a thread they resumed can no longer be safely written
   * to (it was deleted, or another writer moved it on). The whole point is that
   * subsequent sends must land on a NEW row — but the callers used to
   * fire-and-forget `startChatWithMessages` and never check, which is the same
   * superseded-hydration trap `rewindToMessage` documents at length: awaiting
   * that promise proves the hydration settled, not that OUR id is the one that
   * committed. `clearPendingSessionHydration` resolves a superseded hydration
   * identically, leaving the live id as either the ORIGINAL (nothing else
   * committed) or a THIRD id (an interloping session change won the race).
   *
   * In production the first case is what actually happened: post-detach turns
   * kept writing to the OLD `chatSessionId`, which is how they reached the
   * ingest replay heuristic on the old row and got dropped. So the exact-match
   * check here is the load-bearing part — "the id changed" is not good enough.
   *
   * Deliberately does NOT retry a superseded fork. Re-minting looks like cheap
   * insurance, but `queueSessionHydration` clears whatever hydration is pending
   * — so a second attempt cancels the very session change that superseded the
   * first. In practice that is a `loadChatSession` still resolving its
   * transcript blob: the user clicked a thread, and the retry would yank them
   * back out of it. Failing closed is both safer and honest, and the caller's
   * next send is still protected — `resumedVersion` is untouched below, so a
   * send on the old row carries its `expectedVersion` and conflicts rather than
   * clobbering.
   *
   * `resumedVersion` is deliberately NOT cleared by this function. On success
   * the fork's own hydration nulls it (that is what makes the branch's first
   * ingest carry no `expectedVersion`); on failure the superseding session's
   * value must stay untouched, because the live thread is now someone else's
   * and tearing down ITS optimistic-concurrency guard would let the next send
   * clobber whatever another tab wrote — precisely the hazard
   * `rewindToMessage`'s `onBeforeBranch` contract exists to prevent.
   *
   * Returns the minted id on success, or `null` when the fork could not be
   * confirmed. `null` means the caller is still pointed at a thread it must not
   * write to, so callers must report failure rather than the reassuring
   * "continuing in a new thread" copy.
   */
  const detachToLocalFork = useCallback(
    async (
      messages: UIMessage[],
      options?: {
        toolRenderOverrides?: Record<string, ToolRenderOverride>;
      }
    ): Promise<{ chatSessionId: string } | null> => {
      const forkSessionId = await startChatWithMessages(messages, {
        resetReason: "fork",
        toolRenderOverrides: options?.toolRenderOverrides,
      });
      // Exact match, not "it changed": the live id after a superseded hydration
      // can be the ORIGINAL (nothing else committed) or a THIRD id (an
      // interloper's session won). Only our own id proves the fork went live.
      return chatSessionIdRef.current === forkSessionId
        ? { chatSessionId: forkSessionId }
        : null;
    },
    [startChatWithMessages]
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
          modelVisibleMcpToolResults?: ModelVisibleMcpToolResults;
          mcpToolResultImageRendering?: McpToolResultImageRenderingPolicy;
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
        resumedModelVisibleMcpToolResultsRef.current =
          session.resumeConfig?.modelVisibleMcpToolResults;
        resumedMcpToolResultImageRenderingRef.current =
          session.resumeConfig?.mcpToolResultImageRendering;
      }

      if (options?.shouldApply && !options.shouldApply()) {
        return;
      }

      skipNextForkDetectionRef.current = true;
      rewindRef.current = null;
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
          authIsMemberRef.current = true;
          setAuthHeaders(resolvedAuthHeaders);
          resolved = true;
        }
      } catch {
        // getAccessToken threw (e.g. LoginRequiredError) — not authenticated
      }
      // Anything past the WorkOS-token path is a guest (or unauthenticated).
      if (!resolved) authIsMemberRef.current = false;

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
        const currentHostedScope: HostedSessionScope = {
          projectId: hostedProjectId,
          targetKey: hostedTargetKeyValue,
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
    // `scenario_access_stale` recovery path) would flip the flag false →
    // true on each refresh, briefly unmounting downstream consumers gated
    // on it (ChatTabV2). Auth-header resolution doesn't depend on the
    // version, and the scope-equality check inside the effect no longer
    // reads it either, so the effect body is exhaustive-deps-clean
    // without it.
    //
    // `hostedEnvironmentId` IS a dependency: the effect is the only path that
    // acts on a scope change, so without it selecting a different environment
    // would resolve the next turn against the new bundle while appending to the
    // previous one's transcript. (`hostedHostId` is a long-standing omission
    // here — adding it is a behavior change for host switching and is out of
    // scope for Phase 2; the target key covers it the moment it lands.)
  }, [
    getAccessToken,
    hostedScenarioId,
    hostedEnvironmentId,
    hostedTargetKeyValue,
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
        lastObservedTokenCountSelectionKeyRef.current = null;
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
        setMcpToolsTokenCountErrors((previous) =>
          previous !== null ? null : previous
        );
        setMcpToolsTokenCountLoading((previous) =>
          previous ? false : previous
        );
        return;
      }

      const shouldCountTokens =
        tokenCountSelectionKey !== "" && messages.length === 0;
      const selectionChanged =
        lastObservedTokenCountSelectionKeyRef.current !== null &&
        lastObservedTokenCountSelectionKeyRef.current !==
          tokenCountSelectionKey;
      lastObservedTokenCountSelectionKeyRef.current = tokenCountSelectionKey;
      const modelIdForTokens = shouldCountTokens
        ? isMCPJamProvidedModelMenuItem(selectedModel)
          ? String(selectedModel.id)
          : `${selectedModel.provider}/${selectedModel.id}`
        : undefined;

      if (selectionChanged && !shouldCountTokens) {
        setMcpToolsTokenCount(null);
        setMcpToolsTokenCountErrors(null);
      }
      setMcpToolsTokenCountLoading(shouldCountTokens);

      try {
        const {
          metadata,
          toolServerMap,
          serializedTools,
          tokenCounts,
          tokenCountErrors,
        } = await getToolsMetadata(selectedServers, modelIdForTokens);
        setToolsMetadata(metadata);
        setToolServerMap(toolServerMap);
        setSerializedTools(serializedTools);
        if (shouldCountTokens) {
          setMcpToolsTokenCount(
            tokenCounts && Object.keys(tokenCounts).length > 0
              ? tokenCounts
              : null
          );
          setMcpToolsTokenCountErrors(
            tokenCountErrors && Object.keys(tokenCountErrors).length > 0
              ? tokenCountErrors
              : null
          );
        }
      } catch (error) {
        if (!(hostedScenarioId && isAuthDeniedError(error))) {
          console.warn(
            "[useChatSession] Failed to fetch tools metadata:",
            error
          );
        }
        setToolsMetadata({});
        setToolServerMap({});
        setSerializedTools({});
        if (shouldCountTokens) {
          setMcpToolsTokenCount(null);
          setMcpToolsTokenCountErrors(null);
        }
      } finally {
        setMcpToolsTokenCountLoading(false);
      }
    };

    fetchToolsMetadata();
  }, [
    selectedServersSignature,
    selectedModel,
    tokenCountSelectionKey,
    hostedScenarioId,
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
        const modelId = isMCPJamProvidedModelMenuItem(selectedModel)
          ? String(selectedModel.id)
          : `${selectedModel.provider}/${selectedModel.id}`;
        const count = await countTextTokens(systemPrompt, modelId);
        setSystemPromptTokenCount(count > 0 ? count : null);
      } catch (error) {
        if (!(hostedScenarioId && isAuthDeniedError(error))) {
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
  }, [systemPrompt, selectedModel, hostedScenarioId]);

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
  // Compute share/scenario guest access from React state instead of the global
  // apiContext.
  // In hosted mode: always require auth (guest JWT or WorkOS — handled by authFetch).
  // In non-hosted mode: auth is needed for org-managed BYOK and sign-in-only MCPJam models.
  const requiresAuthForChat = HOSTED_MODE
    ? true
    : selectedModelUsesOrgRuntime ||
      (isMcpJamModel &&
        // Prefer the live catalog's guestAllowed flag (always true now that
        // guests are un-gated); fall back to the static snapshot for
        // offline/cold-start classification.
        !(
          selectedModel?.guestAllowed ??
          isMCPJamGuestAllowedModel(String(selectedModel?.id ?? ""))
        ));
  const isAuthReady =
    !requiresAuthForChat || guestMode || (isAuthenticated && !!authHeaders);
  // Guest users don't need WorkOS auth — authFetch handles guest bearer tokens
  const disableForAuthentication =
    !isAuthenticated && requiresAuthForChat && !guestMode;
  const authHeadersNotReady =
    requiresAuthForChat && isAuthenticated && !authHeaders;
  const orgOrHostedContextRequired =
    HOSTED_MODE || hostedRequiresWebChatApi || selectedModelUsesOrgRuntime;
  const selectedServerIdsRequired =
    HOSTED_MODE ||
    hostedRequiresWebChatApi ||
    (selectedModelUsesOrgRuntime && !localMcpRuntimeRequired);
  // When the surface provides a send-time resolver (`ensureServerIds`), the
  // preflight resolves ad-hoc/App server names → Convex ids at send, so a
  // pre-resolved id per selected server is NOT required up front — requiring
  // it would keep submit blocked forever for servers the preflight exists to
  // persist (they only get ids once a send runs).
  // An ENVIRONMENT target is server-connected: the backend resolves and
  // connects the server set itself from one atomic read, so there is no browser
  // connection state to wait on and no name→id preflight to run. Gating submit
  // on `hostedSelectedServerIds` here would block environments whose servers are
  // plugin-contributed — those are intentionally hidden from
  // `servers:getProjectServers`, so they can never appear in the browser's
  // name-keyed catalog and the gate would never open.
  const hostedContextNotReady =
    orgOrHostedContextRequired &&
    (!hostedProjectId ||
      (!hostedEnvironmentId &&
        selectedServerIdsRequired &&
        selectedServers.length > 0 &&
        !hostedEnsureServerIds &&
        hostedSelectedServerIds.length !== selectedServers.length));
  const isStreaming = status === "streaming" || status === "submitted";

  // The blocked tool call cannot outlive the stream: when it ends (finished,
  // stopped, or errored) the server has already resolved every outstanding
  // elicitation to `cancel`, so any dialog still open is answering into a dead
  // rendezvous. Drop them instead of letting the user submit into the void.
  useEffect(() => {
    if (isStreaming) return;
    setPendingElicitations((queue) => (queue.length > 0 ? [] : queue));
  }, [isStreaming]);

  const respondToElicitation = useCallback(
    async (answer: {
      rendezvousId: string;
      action: HostedElicitationAction;
      content?: Record<string, unknown>;
    }) => {
      setElicitationResponding(true);
      try {
        const result = await respondToChatElicitation(convexClient, answer);
        // Close on a losing race too (already expired / answered elsewhere):
        // the row is terminal either way, so keeping the dialog open would
        // only invite a second doomed submit.
        setPendingElicitations((queue) =>
          queue.filter((e) => e.rendezvousId !== answer.rendezvousId)
        );
        if (!result.ok) {
          toast.info(
            result.reason === "expired"
              ? "That request timed out, so it was cancelled."
              : "That request was already resolved."
          );
        }
      } catch (error) {
        console.warn("[elicitation] respond failed", error);
        toast.error("Couldn't send your response. The request will time out.");
      } finally {
        setElicitationResponding(false);
      }
    },
    [convexClient]
  );

  const dismissUrlElicitationRequired = useCallback((toolCallId?: string) => {
    setUrlElicitationRequired((current) =>
      current.filter((e) => e.toolCallId !== toolCallId)
    );
  }, []);

  /**
   * Abort: the user withdrew the turn, so any suspended MRTR round still on
   * the rail is withdrawn with it. (Stream END is deliberately NOT a trigger —
   * a suspended operation's stream always ends while its round is pending.)
   */
  const stopChat = useCallback(() => {
    const store = useHostedMrtrStore.getState();
    for (const round of store.rounds) void store.cancel(round.key);
    stop();
  }, [stop]);

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
    rewindToMessage,
    sendMessage,
    stop: stopChat,
    status,
    error,
    chatSessionId,

    // Model state
    selectedModel,
    setSelectedModel,
    isSelectedModelResolved,
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
    mcpToolsTokenCountErrors,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,

    // Tool approval
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse,

    // Actions
    resetChat,
    startChatWithMessages,
    detachToLocalFork,
    loadChatSession,
    syncResumedVersion,
    consumePersistReceipt,
    consumeTurnAborted,

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

    // Elicitation (hosted): a server is blocking a tool call on this user.
    pendingElicitations,
    respondToElicitation,
    elicitationResponding,
    urlElicitationRequired,
    dismissUrlElicitationRequired,

    // Computed state
    isStreaming,
    disableForAuthentication,
    submitBlocked,
    inputDisabled,
  };
}
