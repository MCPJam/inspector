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
import { getOrCreateAgentChat } from "@/lib/mcpjam-agent/agent-chat-instances";
import { fulfillOrphanedDeferredUiToolCalls } from "@/lib/webmcp/ui-tool-approval";
import {
  loadAgentRequireToolApproval,
  saveAgentRequireToolApproval,
  subscribeAgentRequireToolApproval,
} from "@/lib/agent-tool-approval-storage";
import { usePostHog } from "posthog-js/react";
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
  const posthog = usePostHog();
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
  const { chat, config, handleToolApprovalResponse } = useMemo(
    () => getOrCreateAgentChat(chatSessionId),
    [chatSessionId]
  );
  // Whether this hook found the instance pristine. Distinguishes "we own the
  // fresh instance and may seed it (even merging around a racing user send)"
  // from "we adopted a live instance from another surface (panel adoption
  // during a navigation handoff) and must never re-seed stale history".
  const instanceWasPristineRef = useRef(
    !config.seeded && chat.messages.length === 0 && chat.status === "ready"
  );
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
  const prevStatusRef = useRef(status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = status;
    if (prev === status) return;
    if ((prev === "submitted" || prev === "streaming") && status === "ready") {
      const startedAt = turnStartedAtRef.current;
      turnStartedAtRef.current = null;
      const last = messages[messages.length - 1];
      let toolCallCount = 0;
      if (last && last.role === "assistant" && Array.isArray(last.parts)) {
        toolCallCount = last.parts.filter((p) =>
          typeof (p as { type?: unknown }).type === "string" &&
          (p as { type: string }).type.startsWith("tool-")
        ).length;
      }
      posthog?.capture("mcpjam_agent_response_finished", {
        surface,
        session_id: chatSessionId,
        message_index: turnIndexRef.current,
        duration_ms: startedAt != null ? Date.now() - startedAt : null,
        tool_call_count: toolCallCount,
        message_count: messages.length,
      });
    } else if (status === "error") {
      const startedAt = turnStartedAtRef.current;
      turnStartedAtRef.current = null;
      posthog?.capture("mcpjam_agent_response_error", {
        surface,
        session_id: chatSessionId,
        message_index: turnIndexRef.current,
        duration_ms: startedAt != null ? Date.now() - startedAt : null,
        error_message: error?.message ?? null,
      });
    }
  }, [chatSessionId, error, messages, posthog, status, surface]);

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
    if (!instanceWasPristineRef.current) return;
    if (status !== "ready") return;
    config.seeded = true;
    if (chat.messages.length === 0) {
      setMessages(initialMessages);
    } else {
      setMessages([...initialMessages, ...chat.messages]);
    }
  }, [chat, config, hydrating, initialMessages, setMessages, status]);

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
      posthog?.capture("mcpjam_agent_message_sent", {
        surface,
        session_id: chatSessionId,
        message_index: turnIndexRef.current,
        prompt_length: trimmed.length,
        model_id: config.model?.id ?? null,
        provider: config.model?.provider ?? null,
      });
      void sendMessage({ text: trimmed });
    },
    [chatSessionId, config, posthog, providedSessionId, sendMessage, surface]
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
