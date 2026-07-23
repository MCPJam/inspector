/**
 * useMcpjamAgentSession
 *
 * Tiny hook for the MCPJam Agent surfaces (Home page hero, side panel).
 * Wraps `useChat` against `/api/web/mcpjam-agent` with hosted auth,
 * transcript hydration on mount, and WebMCP UI tool fulfillment (the agent
 * panel is the primary surface for driving the inspector UI) — and nothing
 * else.
 *
 * Per the plan, this is deliberately NOT a second `useChatSession`. If
 * Ollama / custom providers / app tools / chatbox / widget / trace
 * branches surface later, parameterize `useChatSession` and route the
 * agent through it instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { generateId } from "ai";
import {
  getOrCreateAgentChat,
  markAgentTurnStarted,
  claimAgentTurnCompletion,
} from "@/lib/mcpjam-agent/agent-chat-instances";
import { fulfillOrphanedDeferredUiToolCalls } from "@/lib/webmcp/ui-tool-approval";
import { buildUiContextPart } from "@/lib/webmcp/ui-context-snapshot";
import { useUiToolsRegistry } from "@/lib/webmcp/ui-tools-registry";
import {
  loadAgentRequireToolApproval,
  saveAgentRequireToolApproval,
  subscribeAgentRequireToolApproval,
} from "@/lib/agent-tool-approval-storage";
import { track } from "@/lib/analytics";
import { useHostedOrgModelConfig } from "@/hooks/use-hosted-org-model-config";
import { usePersistedModel } from "@/hooks/use-persisted-model";
import {
  buildAvailableModelsFromOrgConfig,
  getDefaultModel,
} from "@/components/chat-v2/shared/model-helpers";
import type { ModelDefinition } from "@/shared/types";
import {
  preserveHydratedMessageIds,
  transcriptToUIMessages,
} from "@/lib/transcript-to-ui-messages";
import { getChatHistoryDetail } from "@/lib/apis/web/chat-history-api";

/**
 * Count the `ui_*` client-fulfilled tool calls on the turn's assistant
 * message. Ownership mirrors the executor's dispatch gate (registry
 * membership / shipped names) — never the `ui_` prefix alone. Names and
 * counts only; args/outputs never leave the message.
 */
/**
 * The assistant message THIS turn produced, or undefined. On an error before
 * the SDK appended the turn's own assistant message, `last` is the previous
 * turn's answer (same id as the pre-submit boundary) — return undefined so its
 * tools/usage aren't misattributed to the failed turn.
 */
export function turnAssistantMessage(
  last: UIMessage | undefined,
  boundaryMessageId: string | null,
): UIMessage | undefined {
  return last && last.id !== boundaryMessageId ? last : undefined;
}

/**
 * A turn is only truly finished when its tool calls have resolved. During a
 * UI-tool turn the SDK reaches an intermediate `ready` with the tool part
 * still awaiting a result (input-streaming/input-available) or the user's
 * approval (approval-requested); the real completion is the LATER `ready`
 * after the tool-resume chain. Terminal tool states are output-available /
 * output-error. Any tool part not in a terminal output state means the turn
 * is mid-flight.
 */
export function lastAssistantHasUnresolvedToolParts(
  last: UIMessage | undefined,
): boolean {
  if (!last || last.role !== "assistant" || !Array.isArray(last.parts)) {
    return false;
  }
  return last.parts.some((part) => {
    const type = (part as { type?: unknown }).type;
    if (typeof type !== "string" || !type.startsWith("tool-")) return false;
    const state = (part as { state?: unknown }).state;
    // Resolved = any terminal `output-*` state: output-available (incl. a
    // synthesized denial result), output-error, output-denied. Anything else
    // (input-streaming/input-available/approval-requested) is mid-flight, so
    // a denied turn — which ends in a terminal output part — still completes.
    return !(typeof state === "string" && state.startsWith("output-"));
  });
}

function summarizeUiToolCalls(last: UIMessage | undefined): {
  ui_tool_call_count: number;
  distinct_tool_count: number;
} {
  if (!last || last.role !== "assistant" || !Array.isArray(last.parts)) {
    return { ui_tool_call_count: 0, distinct_tool_count: 0 };
  }
  const registry = useUiToolsRegistry.getState();
  const names: string[] = [];
  for (const part of last.parts) {
    const type = (part as { type?: unknown }).type;
    if (typeof type !== "string" || !type.startsWith("tool-")) continue;
    const name = type.slice("tool-".length);
    if (registry.resolve(name) !== null || registry.wasShipped(name)) {
      names.push(name);
    }
  }
  return {
    ui_tool_call_count: names.length,
    distinct_tool_count: new Set(names).size,
  };
}

/**
 * Token usage IF the session already carries it on the assistant message's
 * metadata. The agent route doesn't stream usage metadata today, so these
 * are usually null — deliberately no new server plumbing here.
 */
function usageTokens(last: UIMessage | undefined): {
  input_tokens: number | null;
  output_tokens: number | null;
} {
  const usage =
    last && last.role === "assistant"
      ? (
          last as {
            metadata?: { usage?: { inputTokens?: unknown; outputTokens?: unknown } };
          }
        ).metadata?.usage
      : undefined;
  return {
    input_tokens:
      typeof usage?.inputTokens === "number" ? usage.inputTokens : null,
    output_tokens:
      typeof usage?.outputTokens === "number" ? usage.outputTokens : null,
  };
}

export interface UseMcpjamAgentSessionArgs {
  /**
   * Required: the agent surface owns its own session lifecycle. The Home
   * page reads this from `?session=<id>`; the future bubble will manage
   * its own. When omitted, the first `submit()` mints a fresh id via
   * `generateId()`.
   */
  chatSessionId?: string;
  /** Project the agent session is scoped to (for persistence). */
  projectId: string | null | undefined;
  /** Org id — used to fetch the org model config for BYOK availability. */
  organizationId?: string | null;
  /** Optional override to override the persisted default model. */
  modelOverride?: ModelDefinition;
  /**
   * Telemetry surface — passed into PostHog lifecycle events so we can split
   * engagement/error/latency by home vs. side-panel vs. future bubble.
   */
  surface?: string;
}

export interface UseMcpjamAgentSessionResult {
  /** Current session id (mints lazily on first submit when not provided). */
  chatSessionId: string;
  /** Wired `useChat` state — pass `messages` to the transcript view. */
  messages: UIMessage[];
  status: ReturnType<typeof useChat>["status"];
  error: ReturnType<typeof useChat>["error"];
  /** Send the next user message. */
  submit: (text: string) => void;
  /** Stop in-flight generation. */
  stop: ReturnType<typeof useChat>["stop"];
  /** Resolved active model — exposed for headers / debugging. */
  model: ModelDefinition | undefined;
  /** True while the persisted transcript is being seeded on mount. */
  hydrating: boolean;
  /** "Tool Approval" preference (persisted, agent-global, default off). */
  requireToolApproval: boolean;
  setRequireToolApproval: (value: boolean) => void;
  /** UI-tool-aware approval responses — pass as `onToolApprovalResponse`. */
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}

export function useMcpjamAgentSession(
  args: UseMcpjamAgentSessionArgs
): UseMcpjamAgentSessionResult {
  const { projectId, organizationId, chatSessionId: providedSessionId } = args;
  const surface = args.surface ?? "unknown";

  const [chatSessionId, setChatSessionId] = useState<string>(
    () => providedSessionId ?? generateId()
  );

  // If the consumer hands us a new id (e.g. URL param change), sync.
  useEffect(() => {
    if (providedSessionId && providedSessionId !== chatSessionId) {
      setChatSessionId(providedSessionId);
    }
  }, [providedSessionId, chatSessionId]);

  // Model resolution: use the user's persisted default, otherwise the org
  // BYOK availability list's spec default. The agent has no model picker
  // in v1 — the bubble + home both ride the user's last-used model.
  const orgConfig = useHostedOrgModelConfig({
    projectId,
    organizationId,
  });
  const availableModels = useMemo(
    () => buildAvailableModelsFromOrgConfig(orgConfig),
    [orgConfig]
  );
  const { selectedModelId } = usePersistedModel();
  const resolvedModel = useMemo<ModelDefinition | undefined>(() => {
    if (args.modelOverride) return args.modelOverride;
    if (availableModels.length === 0) return undefined;
    if (selectedModelId) {
      const found = availableModels.find((m) => m.id === selectedModelId);
      if (found) return found;
    }
    return getDefaultModel(availableModels);
  }, [args.modelOverride, availableModels, selectedModelId]);

  // "Tool Approval" preference — persisted, shared across agent surfaces
  // (hero + panel) via the storage-change subscription. Default off.
  const [requireToolApproval, setRequireToolApprovalState] = useState(
    loadAgentRequireToolApproval
  );
  useEffect(
    () =>
      subscribeAgentRequireToolApproval(() => {
        setRequireToolApprovalState(loadAgentRequireToolApproval());
      }),
    []
  );
  const setRequireToolApproval = useCallback((value: boolean) => {
    setRequireToolApprovalState(value);
    saveAgentRequireToolApproval(value);
  }, []);

  // The Chat instance lives OUTSIDE React (see agent-chat-instances.ts) so
  // an in-flight stream survives this hook unmounting — e.g. a `ui_navigate`
  // tool call leaving the Home takeover mid-turn. The hook attaches via
  // `useChat({ chat })` and keeps the instance's mutable config current.
  // `instanceWasPristine`: whether this hook found the instance pristine at
  // resolution time. Distinguishes "we own the fresh instance and may seed
  // it (even merging around a racing user send)" from "we adopted a live
  // instance from another surface (panel adoption during a navigation
  // handoff) and must never re-seed stale history". Computed inside the
  // memo — NOT a mount-scoped ref — so a `chatSessionId` change without a
  // remount re-evaluates it for the new session's instance.
  const { chat, config, handleToolApprovalResponse, instanceWasPristine } =
    useMemo(() => {
      const entry = getOrCreateAgentChat(chatSessionId);
      return {
        chat: entry.chat,
        config: entry.config,
        handleToolApprovalResponse: entry.handleToolApprovalResponse,
        instanceWasPristine:
          !entry.config.seeded &&
          entry.chat.messages.length === 0 &&
          entry.chat.status === "ready",
      };
    }, [chatSessionId]);
  useEffect(() => {
    config.projectId = projectId ?? null;
    config.model = resolvedModel;
    config.requireToolApproval = requireToolApproval;
  });
  useEffect(() => {
    config.attachedSurfaces.add(surface);
    return () => {
      config.attachedSurfaces.delete(surface);
    };
  }, [config, surface]);

  // Transcript hydration: when we mount with a known session id, fetch the
  // persisted transcript and seed `useChat`. Without this, reload would
  // land on an empty thread despite the session being on disk.
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [hydrating, setHydrating] = useState<boolean>(Boolean(providedSessionId));

  useEffect(() => {
    if (!providedSessionId) {
      setInitialMessages([]);
      setHydrating(false);
      return;
    }
    let cancelled = false;
    setHydrating(true);
    (async () => {
      try {
        const detail = await getChatHistoryDetail({
          chatSessionId: providedSessionId,
          ...(projectId ? { projectId } : {}),
        });
        if (cancelled) return;
        const blobUrl = detail?.session?.messagesBlobUrl;
        if (!blobUrl) {
          setInitialMessages([]);
          setHydrating(false);
          return;
        }
        const transcriptRes = await fetch(blobUrl);
        if (!transcriptRes.ok) {
          setInitialMessages([]);
          setHydrating(false);
          return;
        }
        const transcript = (await transcriptRes.json()) as unknown[];
        const hydrated = transcriptToUIMessages(transcript);
        if (cancelled) return;
        // preserveHydratedMessageIds keeps stable ids if anything's
        // already in the array (no-op on first mount).
        setInitialMessages((current) =>
          preserveHydratedMessageIds(current, hydrated)
        );
        setHydrating(false);
      } catch {
        if (cancelled) return;
        // Best-effort: if hydration fails, fall through to an empty
        // thread rather than blocking the surface entirely.
        setInitialMessages([]);
        setHydrating(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [providedSessionId, projectId]);

  // Transport, `onToolCall` (WebMCP UI tool fulfillment), and
  // `sendAutomaticallyWhen` are wired at instance creation in
  // `agent-chat-instances.ts` — they read the mutable `config` synced above.
  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    chat,
  });

  // Lifecycle telemetry — track each user message round-trip so we can read
  // engagement (message_sent), latency (response_finished.duration_ms), tool
  // usage (response_finished.tool_call_count), and reliability
  // (response_error). Uses status edge transitions instead of a non-existent
  // useChat `onFinish` callback in this @ai-sdk/react version.
  const turnStartedAtRef = useRef<number | null>(null);
  const turnIndexRef = useRef<number>(0);
  // Completion is detected from the SHARED entry + terminal state, NOT a
  // hook-local status edge. Three reasons this matters for the agent chat:
  //   1. A UI-tool turn passes through an intermediate `ready` while the tool
  //      part is still input-available/approval-requested (AI SDK #7430:
  //      streaming→ready→submitted→streaming→ready). Emitting there would
  //      report a truncated duration and, via the one-shot claim, SUPPRESS
  //      the real final completion. So we only treat `ready` as terminal when
  //      the last assistant message has no unresolved tool parts.
  //   2. On a hand-off, the adopting surface may mount AFTER the shared Chat
  //      already reached `ready` — no status edge occurs. A state-driven
  //      effect still runs on mount and can claim the pending completion once.
  //   3. Dedup + timing + attribution live on the shared entry, so exactly
  //      one surface emits per turn with the submit-time duration/model.
  useEffect(() => {
    const last = messages[messages.length - 1];
    const isTerminal =
      status === "error" ||
      (status === "ready" && !lastAssistantHasUnresolvedToolParts(last));
    if (!isTerminal) return;
    const claim = claimAgentTurnCompletion(chatSessionId);
    if (!claim) return;
    turnStartedAtRef.current = null;
    const startedAt = claim.startedAt;
    const durationMs = startedAt != null ? Date.now() - startedAt : null;
    // Only attribute tool counts / usage to an assistant message THIS turn
    // produced. On an error before the SDK appended the turn's assistant
    // message, `last` is the previous turn's answer — attributing its tools
    // to the failed turn would corrupt the experiment. A new message has an
    // id different from the pre-submit boundary.
    const turnAssistant = turnAssistantMessage(last, claim.boundaryMessageId);
    // Observation-only: a throwing analytics client must never break the
    // session's effect.
    try {
      if (status === "error") {
        track("mcpjam_agent_response_error", {
          location: "mcpjam_agent",
          surface,
          session_id: chatSessionId,
          message_index: claim.messageIndex,
          duration_ms: durationMs,
          error_message: error?.message ?? null,
        });
        track("agent_turn_completed", {
          location: "mcpjam_agent",
          surface,
          session_id: chatSessionId,
          model: claim.model,
          provider: claim.provider,
          ...summarizeUiToolCalls(turnAssistant),
          had_error: true,
          ...usageTokens(turnAssistant),
          duration_ms: durationMs,
        });
      } else {
        let toolCallCount = 0;
        if (
          turnAssistant &&
          turnAssistant.role === "assistant" &&
          Array.isArray(turnAssistant.parts)
        ) {
          toolCallCount = turnAssistant.parts.filter((p) =>
            typeof (p as { type?: unknown }).type === "string" &&
            (p as { type: string }).type.startsWith("tool-")
          ).length;
        }
        track("mcpjam_agent_response_finished", {
          location: "mcpjam_agent",
          surface,
          session_id: chatSessionId,
          message_index: claim.messageIndex,
          duration_ms: durationMs,
          tool_call_count: toolCallCount,
          message_count: messages.length,
        });
        track("agent_turn_completed", {
          location: "mcpjam_agent",
          surface,
          session_id: chatSessionId,
          model: claim.model,
          provider: claim.provider,
          ...summarizeUiToolCalls(turnAssistant),
          had_error: false,
          ...usageTokens(turnAssistant),
          duration_ms: durationMs,
        });
      }
    } catch {
      // swallow — telemetry is observation-only
    }
  }, [chatSessionId, error, messages, status, surface]);

  // Orphaned-defer fallback: a UI tool call deferred for approval whose
  // approval request never arrived (client/server flag disagreement for one
  // turn) executes once the stream settles so the turn can't hang.
  const messagesForDeferRef = useRef(messages);
  messagesForDeferRef.current = messages;
  const prevStatusForDeferRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusForDeferRef.current;
    prevStatusForDeferRef.current = status;
    if (prev === status || status !== "ready") return;
    fulfillOrphanedDeferredUiToolCalls({
      messages: messagesForDeferRef.current,
      addToolOutput: (output) => {
        chat.addToolOutput(output);
      },
    });
  }, [chat, status]);

  // Seed the instance with hydrated history once it arrives. The guard is
  // per-INSTANCE (`config.seeded`), not per-hook: a second surface adopting
  // a live instance (panel adoption during a navigation handoff) must never
  // re-seed stale history over an in-flight turn — only the hook that found
  // the instance pristine may seed. If the user sent a message BEFORE
  // hydration finished (racing a resumed session), everything live is new by
  // construction, so prepend the hydrated history instead of dropping it —
  // waiting for `status === "ready"` (a dep, so the effect re-runs when the
  // racing turn settles) keeps setMessages off a mid-stream instance.
  useEffect(() => {
    if (hydrating) return;
    if (initialMessages.length === 0) return;
    if (config.seeded) return;
    if (!instanceWasPristine) return;
    if (status !== "ready") return;
    config.seeded = true;
    if (chat.messages.length === 0) {
      setMessages(initialMessages);
    } else {
      setMessages([...initialMessages, ...chat.messages]);
    }
  }, [
    chat,
    config,
    hydrating,
    initialMessages,
    instanceWasPristine,
    setMessages,
    status,
  ]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // A fresh session minted by this submit has no persisted transcript —
      // mark it seeded so late hydration can never overwrite the live turn.
      if (!providedSessionId) {
        config.seeded = true;
      }
      turnIndexRef.current += 1;
      turnStartedAtRef.current = Date.now();
      // Turn timing/attribution lives on the shared Chat entry so a hand-off
      // to another surface mid-turn still reports the right duration and
      // emits the completion exactly once.
      const priorMessages = messagesForDeferRef.current;
      const boundaryMessageId =
        priorMessages.length > 0
          ? (priorMessages[priorMessages.length - 1]?.id ?? null)
          : null;
      markAgentTurnStarted(chatSessionId, {
        model: config.model?.id ?? null,
        provider: config.model?.provider ?? null,
        messageIndex: turnIndexRef.current,
        boundaryMessageId,
      });
      track("mcpjam_agent_message_sent", {
        location: "mcpjam_agent",
        surface,
        session_id: chatSessionId,
        message_index: turnIndexRef.current,
        prompt_length: trimmed.length,
        model_id: config.model?.id ?? null,
        provider: config.model?.provider ?? null,
      });
      // Orientation rides ON the message, not in the system prompt: the
      // prompt is the cacheable prefix, and a value that changes per turn
      // would invalidate the whole conversation's cache every request.
      // Appending is free. Built here, at send time, so it reflects wherever
      // the user has navigated themselves since the last turn.
      void sendMessage({
        parts: [buildUiContextPart(), { type: "text", text: trimmed }],
      });
    },
    [chatSessionId, config, providedSessionId, sendMessage, surface]
  );

  return {
    chatSessionId,
    messages,
    status,
    error,
    submit,
    stop,
    model: resolvedModel,
    hydrating,
    requireToolApproval,
    setRequireToolApproval,
    addToolApprovalResponse: handleToolApprovalResponse,
  };
}
