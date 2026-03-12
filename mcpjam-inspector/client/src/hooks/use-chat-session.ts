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
import { authFetch } from "@/lib/session-token";
import { HOSTED_MODE } from "@/lib/config";
import { useSharedChatWidgetCapture } from "@/hooks/useSharedChatWidgetCapture";
import { getHostedAuthorizationHeader } from "@/lib/apis/web/context";

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
  /** Optional sandbox token for hosted sandbox sessions */
  hostedSandboxToken?: string;
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

function getAuthHeadersSignature(
  headers: Record<string, string> | undefined,
): string {
  if (!headers) return "";

  return Object.entries(headers)
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}:${value}`)
    .join("|");
}

function resolveModelApiKey({
  selectedModel,
  getCustomProviderByName,
  getToken,
}: {
  selectedModel: ModelDefinition;
  getCustomProviderByName: ReturnType<
    typeof useCustomProviders
  >["getCustomProviderByName"];
  getToken: ReturnType<typeof useAiProviderKeys>["getToken"];
}): string {
  if (
    selectedModel.provider === "custom" &&
    selectedModel.customProviderName
  ) {
    // For custom providers, the API key is embedded in the provider config.
    const customProvider = getCustomProviderByName(
      selectedModel.customProviderName,
    );
    return customProvider?.apiKey || "";
  }

  return getToken(selectedModel.provider as keyof ProviderTokens);
}

export function useChatSession({
  selectedServers,
  hostedWorkspaceId,
  hostedSelectedServerIds = [],
  hostedOAuthTokens,
  hostedShareToken,
  hostedSandboxToken,
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
  const [requireToolApproval, setRequireToolApproval] = useState(
    initialRequireToolApproval,
  );
  const requireToolApprovalRef = useRef(requireToolApproval);
  requireToolApprovalRef.current = requireToolApproval;
  const skipNextForkDetectionRef = useRef(false);
  const pendingForkSessionIdRef = useRef<string | null>(null);
  const pendingForkMessagesRef = useRef<UIMessage[] | null>(null);
  const hasResolvedAuthHeadersRef = useRef(false);
  const authHeadersSignatureRef = useRef("");

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
      return models.filter((model) => isMCPJamProvidedModel(String(model.id)));
    }
    return models;
  }, [
    hasToken,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    getAzureBaseUrl,
    customProviders,
  ]);

  // Model selection with persistence
  const { selectedModelId, setSelectedModelId } = usePersistedModel();
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

  const transportConfigRef = useRef<{
    selectedModel: ModelDefinition;
    apiKey: string;
    temperature: number;
    systemPrompt: string;
    selectedServers: string[];
    hostedWorkspaceId?: string | null;
    hostedSelectedServerIds: string[];
    hostedOAuthTokens?: Record<string, string>;
    hostedShareToken?: string;
    hostedSandboxToken?: string;
    chatSessionId: string;
    requireToolApproval: boolean;
    customProviders: typeof customProviders;
    localAuthorizationHeader?: string;
  } | null>(null);
  const currentApiKey = resolveModelApiKey({
    selectedModel,
    getCustomProviderByName,
    getToken,
  });
  transportConfigRef.current = {
    selectedModel,
    apiKey: currentApiKey,
    temperature,
    systemPrompt,
    selectedServers,
    hostedWorkspaceId,
    hostedSelectedServerIds,
    hostedOAuthTokens,
    hostedShareToken,
    hostedSandboxToken,
    chatSessionId,
    requireToolApproval: requireToolApprovalRef.current,
    customProviders,
    localAuthorizationHeader:
      !HOSTED_MODE && isMcpJamModel ? authHeaders?.Authorization : undefined,
  };

  const transportRef = useRef<DefaultChatTransport<UIMessage> | null>(null);
  if (!transportRef.current) {
    const chatApi = HOSTED_MODE ? "/api/web/chat-v2" : "/api/mcp/chat-v2";

    // AI SDK useChat latches the transport instance until the chat id changes,
    // so request-time config must be read from refs instead of render closures.
    transportRef.current = new DefaultChatTransport({
      api: chatApi,
      fetch: authFetch,
      body: () => {
        const config = transportConfigRef.current!;
        const isGpt5 = isGPT5Model(config.selectedModel.id);

        return {
          model: config.selectedModel,
          ...(HOSTED_MODE ? {} : { apiKey: config.apiKey }),
          ...(isGpt5 ? {} : { temperature: config.temperature }),
          systemPrompt: config.systemPrompt,
          ...(HOSTED_MODE
            ? {
                workspaceId: config.hostedWorkspaceId,
                chatSessionId: config.chatSessionId,
                selectedServerIds: config.hostedSelectedServerIds,
                accessScope: "chat_v2" as const,
                ...(config.hostedShareToken
                  ? { shareToken: config.hostedShareToken }
                  : {}),
                ...(config.hostedSandboxToken
                  ? { sandboxToken: config.hostedSandboxToken }
                  : {}),
                ...(config.hostedOAuthTokens &&
                Object.keys(config.hostedOAuthTokens).length > 0
                  ? { oauthTokens: config.hostedOAuthTokens }
                  : {}),
              }
            : { selectedServers: config.selectedServers }),
          requireToolApproval: config.requireToolApproval,
          ...(!HOSTED_MODE && config.customProviders.length > 0
            ? { customProviders: config.customProviders }
            : {}),
        };
      },
      headers: () => {
        if (HOSTED_MODE) {
          return undefined;
        }

        const localAuthorizationHeader =
          transportConfigRef.current?.localAuthorizationHeader;
        return localAuthorizationHeader
          ? { Authorization: localAuthorizationHeader }
          : undefined;
      },
    });
  }
  const transport = transportRef.current;

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
    transport,
    sendAutomaticallyWhen: requireToolApproval
      ? lastAssistantMessageIsCompleteWithApprovalResponses
      : undefined,
  });

  useSharedChatWidgetCapture({
    enabled:
      HOSTED_MODE &&
      Boolean(hostedShareToken || hostedSandboxToken) &&
      isAuthenticated,
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

  // Resolve auth state for submit gating and reset when the auth identity changes.
  useEffect(() => {
    let active = true;
    (async () => {
      let nextAuthHeaders: Record<string, string> | undefined;

      try {
        if (HOSTED_MODE) {
          const hostedHeader = await getHostedAuthorizationHeader();
          if (!active) return;
          nextAuthHeaders = hostedHeader
            ? { Authorization: hostedHeader }
            : undefined;
        } else {
          const token = await getAccessToken?.();
          if (!active) return;
          if (token) {
            nextAuthHeaders = { Authorization: `Bearer ${token}` };
          } else {
            nextAuthHeaders = undefined;
          }
        }
      } catch (err) {
        console.error("[useChatSession] Failed to get access token:", err);
        if (!active) return;
        nextAuthHeaders = undefined;
      }

      if (!active) return;

      setAuthHeaders(nextAuthHeaders);

      const nextAuthHeadersSignature = getAuthHeadersSignature(nextAuthHeaders);
      if (!hasResolvedAuthHeadersRef.current) {
        hasResolvedAuthHeadersRef.current = true;
        authHeadersSignatureRef.current = nextAuthHeadersSignature;
        return;
      }

      if (authHeadersSignatureRef.current === nextAuthHeadersSignature) {
        return;
      }

      authHeadersSignatureRef.current = nextAuthHeadersSignature;
      skipNextForkDetectionRef.current = true;
      pendingForkSessionIdRef.current = null;
      pendingForkMessagesRef.current = null;
      setChatSessionId(generateId());
      setMessages([]);
      onResetRef.current?.();
    })();
    return () => {
      active = false;
    };
  }, [getAccessToken, setMessages]);

  useEffect(() => {
    setSystemPrompt(initialSystemPrompt);
  }, [initialSystemPrompt]);

  useEffect(() => {
    setTemperature(initialTemperature);
  }, [initialTemperature]);

  useEffect(() => {
    setRequireToolApproval(initialRequireToolApproval);
  }, [initialRequireToolApproval]);

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
        if (
          !(
            Boolean(hostedShareToken || hostedSandboxToken) &&
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
  }, [selectedServers, selectedModel, hostedShareToken, hostedSandboxToken]);

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
            Boolean(hostedShareToken || hostedSandboxToken) &&
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
  const requiresAuthForChat = HOSTED_MODE || isMcpJamModel;
  const isAuthReady = !requiresAuthForChat || !!authHeaders;
  const disableForAuthentication =
    !HOSTED_MODE && !isAuthenticated && requiresAuthForChat;
  const authHeadersNotReady = requiresAuthForChat && !authHeaders;
  const hostedContextNotReady =
    HOSTED_MODE &&
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
