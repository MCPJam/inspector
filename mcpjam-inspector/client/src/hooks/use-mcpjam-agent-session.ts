/**
 * useMcpjamAgentSession
 *
 * Tiny hook for the MCPJam Agent surfaces (Home page hero, future bubble).
 * Wraps `useChat` against `/api/web/mcpjam-agent` with hosted auth and
 * transcript hydration on mount — and nothing else.
 *
 * Per the plan, this is deliberately NOT a second `useChatSession`. If
 * Ollama / custom providers / app tools / chatbox / widget / trace
 * branches surface later, parameterize `useChatSession` and route the
 * agent through it instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useChat, type UIMessage } from "@ai-sdk/react";
import { DefaultChatTransport, generateId } from "ai";
import { authFetch } from "@/lib/session-token";
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

const AGENT_API_PATH = "/api/web/mcpjam-agent";

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
}

export function useMcpjamAgentSession(
  args: UseMcpjamAgentSessionArgs
): UseMcpjamAgentSessionResult {
  const { projectId, organizationId, chatSessionId: providedSessionId } = args;

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

  const modelRef = useRef<ModelDefinition | undefined>(resolvedModel);
  useEffect(() => {
    modelRef.current = resolvedModel;
  }, [resolvedModel]);

  // Transcript hydration: when we mount with a known session id, fetch the
  // persisted transcript and seed `useChat`. Without this, reload would
  // land on an empty thread despite the session being on disk.
  const [initialMessages, setInitialMessages] = useState<UIMessage[]>([]);
  const [hydrating, setHydrating] = useState<boolean>(Boolean(providedSessionId));
  const hydrationKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!providedSessionId) {
      setInitialMessages([]);
      setHydrating(false);
      hydrationKeyRef.current = null;
      return;
    }
    if (hydrationKeyRef.current === providedSessionId) return;
    hydrationKeyRef.current = providedSessionId;
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

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: AGENT_API_PATH,
        fetch: authFetch,
        body: () => ({
          model: modelRef.current,
          projectId,
          chatSessionId,
        }),
      }),
    [chatSessionId, projectId]
  );

  const { messages, sendMessage, status, error, stop, setMessages } = useChat({
    id: chatSessionId,
    transport,
  });

  // Seed `useChat` with hydrated history once it arrives.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (hydrating) return;
    if (initialMessages.length === 0) return;
    if (seededForRef.current === chatSessionId) return;
    seededForRef.current = chatSessionId;
    setMessages(initialMessages);
  }, [chatSessionId, hydrating, initialMessages, setMessages]);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      // Mint an id on first submit when the caller didn't provide one,
      // so the persistence path has something to dedupe on.
      if (!providedSessionId && seededForRef.current === null) {
        seededForRef.current = chatSessionId;
      }
      void sendMessage({ text: trimmed });
    },
    [chatSessionId, providedSessionId, sendMessage]
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
  };
}
