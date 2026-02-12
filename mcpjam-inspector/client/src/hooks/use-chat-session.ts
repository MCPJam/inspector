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
import { getAuthHeaders as getSessionAuthHeaders } from "@/lib/session-token";

export interface UseChatSessionOptions {
  /** Server names to connect to */
  selectedServers: string[];
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

export function useChatSession({
  selectedServers,
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
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    getOllamaBaseUrl,
    getAzureBaseUrl,
  } = useAiProviderKeys();

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

  // Build available models
  const availableModels = useMemo(() => {
    return buildAvailableModels({
      hasToken,
      getLiteLLMBaseUrl,
      getLiteLLMModelAlias,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
      getAzureBaseUrl,
    });
  }, [
    hasToken,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
    getAzureBaseUrl,
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
    const apiKey = getToken(selectedModel.provider as keyof ProviderTokens);
    const isGpt5 = isGPT5Model(selectedModel.id);

    // Merge session auth headers with workos auth headers
    const sessionHeaders = getSessionAuthHeaders();
    const mergedHeaders = { ...sessionHeaders, ...authHeaders } as Record<
      string,
      string
    >;

    return new DefaultChatTransport({
      api: "/api/mcp/chat-v2",
      body: () => ({
        model: selectedModel,
        apiKey: apiKey,
        ...(isGpt5 ? {} : { temperature }),
        systemPrompt,
        selectedServers,
        requireToolApproval: requireToolApprovalRef.current,
      }),
      headers:
        Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
    });
  }, [
    selectedModel,
    getToken,
    authHeaders,
    temperature,
    systemPrompt,
    selectedServers,
    // requireToolApproval read from ref at request time
  ]);

  // useChat hook
  const {
    messages,
    sendMessage: baseSendMessage,
    stop,
    status,
    error,
    setMessages,
    addToolApprovalResponse,
  } = useChat({
    id: chatSessionId,
    transport: transport!,
    sendAutomaticallyWhen: requireToolApproval
      ? lastAssistantMessageIsCompleteWithApprovalResponses
      : undefined,
  });

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
    setChatSessionId(generateId());
    setMessages([]);
    onResetRef.current?.();
  }, [setMessages]);

  // Auth headers setup - reset chat after auth changes to ensure transport has correct headers
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const token = await getAccessToken?.();
        if (!active) return;
        if (token) {
          setAuthHeaders({ Authorization: `Bearer ${token}` });
        } else {
          setAuthHeaders(undefined);
        }
      } catch (err) {
        console.error("[useChatSession] Failed to get access token:", err);
        if (!active) return;
        setAuthHeaders(undefined);
      }
      // Reset chat to force new session with updated auth headers
      // This ensures the transport is recreated with the correct headers
      if (active) {
        setChatSessionId(generateId());
        setMessages([]);
        onResetRef.current?.();
      }
    })();
    return () => {
      active = false;
    };
  }, [getAccessToken, setMessages]);

  // Ollama model detection
  useEffect(() => {
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
        console.warn("[useChatSession] Failed to fetch tools metadata:", error);
        setToolsMetadata({});
        setToolServerMap({});
        setMcpToolsTokenCount(null);
      } finally {
        setMcpToolsTokenCountLoading(false);
      }
    };

    fetchToolsMetadata();
  }, [selectedServers, selectedModel]);

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
        console.warn(
          "[useChatSession] Failed to count system prompt tokens:",
          error,
        );
        setSystemPromptTokenCount(null);
      } finally {
        setSystemPromptTokenCountLoading(false);
      }
    };

    fetchSystemPromptTokenCount();
  }, [systemPrompt, selectedModel]);

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
  const isAuthReady = !isMcpJamModel || (isAuthenticated && !!authHeaders);
  const disableForAuthentication = !isAuthenticated && isMcpJamModel;
  const authHeadersNotReady = isMcpJamModel && isAuthenticated && !authHeaders;
  const isStreaming = status === "streaming" || status === "submitted";
  const submitBlocked =
    disableForAuthentication || isAuthLoading || authHeadersNotReady;
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
