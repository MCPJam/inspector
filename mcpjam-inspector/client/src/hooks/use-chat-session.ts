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
  DefaultChatTransport,
  generateId,
  lastAssistantMessageIsCompleteWithApprovalResponses,
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
import { GUEST_ALLOWED_MODEL_IDS, isGuestAllowedModel } from "@/shared/types";
import { useSharedChatWidgetCapture } from "@/hooks/useSharedChatWidgetCapture";

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
  /** Minimal UI mode for shared chat (hides diagnostics surfaces only) */
  minimalMode?: boolean;
  /** Initial system prompt (defaults to DEFAULT_SYSTEM_PROMPT) */
  initialSystemPrompt?: string;
  /** Initial temperature (defaults to 0.7) */
  initialTemperature?: number;
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
  availableModels: ModelDefinition[];
  isMcpJamModel: boolean;

  // Auth state
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  authHeaders: Record<string, string> | undefined;
  isAuthReady: boolean;

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

  // Computed state for UI
  isStreaming: boolean;
  disableForAuthentication: boolean;
  submitBlocked: boolean;
  inputDisabled: boolean;
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
  initialSystemPrompt = DEFAULT_SYSTEM_PROMPT,
  initialTemperature = 0.7,
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
  const [systemPrompt, setSystemPrompt] = useState(initialSystemPrompt);
  const [temperature, setTemperature] = useState(initialTemperature);
  const [chatSessionId, setChatSessionId] = useState(generateId());
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
  const [requireToolApproval, setRequireToolApproval] = useState(false);
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
    !!hostedShareToken;
  const guestMode = directGuestMode || sharedGuestMode;
  const skipNextForkDetectionRef = useRef(false);
  const pendingForkSessionIdRef = useRef<string | null>(null);
  const pendingForkMessagesRef = useRef<UIMessage[] | null>(null);

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
      // Guest users only see the free guest models
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
  const { selectedModelId, setSelectedModelId } = usePersistedModel();
  const selectedModel = useMemo<ModelDefinition>(() => {
    const fallback = getDefaultModel(availableModels);
    if (!selectedModelId) return fallback;
    const found = availableModels.find((m) => String(m.id) === selectedModelId);
    return found ?? fallback;
  }, [availableModels, selectedModelId]);

  const setSelectedModel = useCallback(
    (model: ModelDefinition) => {
      setSelectedModelId(String(model.id));
    },
    [setSelectedModelId],
  );

  const isMcpJamModel = useMemo(() => {
    return selectedModel?.id
      ? isMCPJamProvidedModel(String(selectedModel.id))
      : false;
  }, [selectedModel]);

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
        return {};
      }
      return {
        workspaceId: hostedWorkspaceId,
        chatSessionId,
        selectedServerIds: hostedSelectedServerIds,
        accessScope: "chat_v2" as const,
        ...(hostedShareToken ? { shareToken: hostedShareToken } : {}),
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
        ...(HOSTED_MODE ? buildHostedBody() : { selectedServers }),
        requireToolApproval: requireToolApprovalRef.current,
        ...(!HOSTED_MODE && customProviders.length > 0
          ? { customProviders }
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
    hostedWorkspaceId,
    chatSessionId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    hostedShareToken,
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
    sendAutomaticallyWhen: requireToolApproval
      ? lastAssistantMessageIsCompleteWithApprovalResponses
      : undefined,
  });

  useSharedChatWidgetCapture({
    enabled: HOSTED_MODE && !!hostedShareToken && isAuthenticated,
    chatSessionId,
    hostedShareToken,
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
          pendingForkSessionIdRef.current = nextSessionId;
          pendingForkMessagesRef.current = nextMessages;
          queueMicrotask(() => {
            if (pendingForkSessionIdRef.current === nextSessionId) {
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
    if (pendingForkSessionIdRef.current !== chatSessionId) {
      return;
    }

    const pendingForkMessages = pendingForkMessagesRef.current;
    pendingForkSessionIdRef.current = null;
    pendingForkMessagesRef.current = null;

    if (pendingForkMessages) {
      baseSetMessages(pendingForkMessages);
    }
  }, [baseSetMessages, chatSessionId]);

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
    pendingForkSessionIdRef.current = null;
    pendingForkMessagesRef.current = null;
    setChatSessionId(generateId());
    setMessages([]);
    onResetRef.current?.();
  }, [setMessages]);

  // Auth headers setup - reset chat after auth changes to ensure transport has correct headers
  useEffect(() => {
    let active = true;
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

      // Only fall back to a guest token for explicit guest surfaces:
      // direct guest chat and shared-chat guests. A regular hosted workspace
      // should never silently downgrade to guest auth.
      if (
        !resolved &&
        active &&
        !isAuthenticated &&
        HOSTED_MODE &&
        (!hostedWorkspaceId || !!hostedShareToken)
      ) {
        const guestToken = await getGuestBearerToken();
        if (!active) return;
        if (guestToken) {
          setAuthHeaders({ Authorization: `Bearer ${guestToken}` });
        } else {
          setAuthHeaders(undefined);
        }
      } else if (!resolved && active) {
        setAuthHeaders(undefined);
      }

      // Reset chat to force new session with updated auth headers
      if (active) {
        skipNextForkDetectionRef.current = true;
        pendingForkSessionIdRef.current = null;
        pendingForkMessagesRef.current = null;
        setChatSessionId(generateId());
        setMessages([]);
        onResetRef.current?.();
      }
    })();
    return () => {
      active = false;
    };
  }, [
    getAccessToken,
    hostedShareToken,
    hostedWorkspaceId,
    isAuthenticated,
    setMessages,
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
        setToolsMetadata({});
        setToolServerMap({});
        setMcpToolsTokenCount(null);
        setMcpToolsTokenCountLoading(false);
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
        if (!(hostedShareToken && isAuthDeniedError(error))) {
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
  }, [selectedServers, selectedModel, hostedShareToken]);

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
        if (!(hostedShareToken && isAuthDeniedError(error))) {
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
  }, [systemPrompt, selectedModel, hostedShareToken]);

  // Reset chat when selected servers change
  const previousSelectedServersRef = useRef<string[]>(selectedServers);
  useEffect(() => {
    const previousNames = previousSelectedServersRef.current;
    const currentNames = selectedServers;
    const hasChanged =
      previousNames.length !== currentNames.length ||
      previousNames.some((name, index) => name !== currentNames[index]);

    if (hasChanged) {
      resetChat();
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
  // In non-hosted mode: only require auth for non-guest MCPJam models
  // (server injects production guest token for guest-allowed models).
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
    availableModels,
    isMcpJamModel,

    // Auth state
    isAuthenticated,
    isAuthLoading,
    authHeaders,
    isAuthReady,

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

    // Computed state
    isStreaming,
    disableForAuthentication,
    submitBlocked,
    inputDisabled,
  };
}
