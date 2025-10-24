import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { usePostHog } from "posthog-js/react";
import { ChatMessage, ChatState, Attachment } from "@/lib/chat-types";
import { createMessage } from "@/lib/chat-utils";
import {
  Model,
  ModelDefinition,
  SUPPORTED_MODELS,
  ModelProvider,
  isMCPJamProvidedModel,
} from "@/shared/types.js";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import { SSEvent } from "@/shared/sse";
import { parseSSEStream } from "@/lib/sse";

interface ElicitationRequest {
  requestId: string;
  message: string;
  schema: any;
  timestamp: string;
}

interface UseChatOptions {
  initialMessages?: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  onMessageSent?: (message: ChatMessage) => void;
  onMessageReceived?: (message: ChatMessage) => void;
  onError?: (error: string) => void;
  onModelChange?: (model: ModelDefinition) => void;
  sendMessagesToBackend?: boolean;
  selectedServers?: string[]; // original server names selected in UI
}

export function useChat(options: UseChatOptions = {}) {
  const {
    getToken,
    hasToken,
    tokens,
    getOllamaBaseUrl,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
  } = useAiProviderKeys();
  const posthog = usePostHog();

  const {
    initialMessages = [],
    systemPrompt,
    temperature,
    onMessageSent,
    onMessageReceived,
    onError,
    onModelChange,
    sendMessagesToBackend = false,
    selectedServers = [],
  } = options;

  const [state, setState] = useState<ChatState>({
    messages: initialMessages,
    isLoading: false,
    connectionStatus: "disconnected",
  });
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<"idle" | "error">("idle");
  const [model, setModel] = useState<ModelDefinition | null>(null);
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const [elicitationRequest, setElicitationRequest] =
    useState<ElicitationRequest | null>(null);
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(state.messages);
  const { getAccessToken } = useAuth();
  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  // Check for Ollama models on mount and periodically
  useEffect(() => {
    const checkOllama = async () => {
      const { isRunning, availableModels } =
        await detectOllamaModels(getOllamaBaseUrl());
      setIsOllamaRunning(isRunning);

      if (isRunning) {
        posthog.capture("ollama_running");
      }

      const toolCapableModels = isRunning
        ? await detectOllamaToolCapableModels(getOllamaBaseUrl())
        : [];
      const toolCapableSet = new Set(toolCapableModels);

      const ollamaModelDefinitions: ModelDefinition[] = availableModels.map(
        (modelName) => {
          const supportsTools = toolCapableSet.has(modelName);
          return {
            id: modelName,
            name: modelName,
            provider: "ollama" as const,
            disabled: !supportsTools,
            disabledReason: supportsTools
              ? undefined
              : "Model does not support tool calling",
          };
        },
      );

      setOllamaModels(ollamaModelDefinitions);
    };

    checkOllama();

    // Check every 30 seconds for Ollama availability
    const interval = setInterval(checkOllama, 30000);

    return () => clearInterval(interval);
  }, [getOllamaBaseUrl]);

  useEffect(() => {
    // Only set a model if we don't have one or the current model is not available
    if (!model || !availableModels.some((m) => m.id === model.id)) {
      const preferred = pickDefaultModel(availableModels, isOllamaRunning);
      setModel(preferred ?? null);
    }
  }, [tokens, ollamaModels, isOllamaRunning, hasToken, model]);

  const getApiKeyForModel = useCallback(
    (m: ModelDefinition | null) => {
      if (!m) return "";
      if (isMCPJamProvidedModel(m.id)) {
        return "router";
      }
      if (m.provider === "ollama") {
        const available =
          isOllamaRunning &&
          ollamaModels.some(
            (om) => om.id === m.id || om.id.startsWith(`${m.id}:`),
          );
        return available ? "local" : "";
      }
      return getToken(m.provider as keyof typeof tokens);
    },
    [getToken, isOllamaRunning, ollamaModels],
  );

  const currentApiKey = useMemo(
    () => getApiKeyForModel(model),
    [model, getApiKeyForModel],
  );

  const handleModelChange = useCallback(
    (newModel: ModelDefinition) => {
      setModel(newModel);
      if (onModelChange) {
        onModelChange(newModel);
      }
    },
    [onModelChange],
  );

  const availableModels = useMemo(() => {
    const providerHasKey: Record<string, boolean> = {
      anthropic: hasToken("anthropic"),
      openai: hasToken("openai"),
      deepseek: hasToken("deepseek"),
      google: hasToken("google"),
      mistral: hasToken("mistral"),
      ollama: isOllamaRunning,
      litellm: Boolean(getLiteLLMBaseUrl() && getLiteLLMModelAlias()),
      openrouter: Boolean(hasToken("openrouter") && getOpenRouterSelectedModels().length > 0),
      meta: false,
      "x-ai": false,
    } as const;

    const cloud = SUPPORTED_MODELS.filter((m) => {
      if (isMCPJamProvidedModel(m.id)) {
        return true;
      }
      return providerHasKey[m.provider];
    });

    const parseModelAliases = (
      aliasString: string,
      provider: ModelProvider,
    ): ModelDefinition[] => {
      return aliasString
        .split(",")
        .map((alias) => alias.trim())
        .filter((alias) => alias.length > 0)
        .map((alias) => ({
          id: alias,
          name: alias,
          provider,
        }));
    };

    // Add user's configured LiteLLM models if configured
    const litellmModels: ModelDefinition[] = [];
    if (providerHasKey.litellm) {
      const modelAliasString = getLiteLLMModelAlias();
      litellmModels.push(...parseModelAliases(modelAliasString, "litellm"));
    }

    const openRouterModels: ModelDefinition[] = [];
    if (providerHasKey.openrouter) {
      const selectedModels = getOpenRouterSelectedModels();
      selectedModels.forEach((modelId) => {
        openRouterModels.push({
          id: modelId,
          name: modelId,
          provider: "openrouter",
        });
      });
    }

    // Combine all models: cloud + ollama + litellm
    let allModels = cloud;
    if (isOllamaRunning && ollamaModels.length > 0) {
      allModels = allModels.concat(ollamaModels);
    }
    if (litellmModels.length > 0) {
      allModels = allModels.concat(litellmModels);
    }
    if (openRouterModels.length > 0) {
      allModels = allModels.concat(openRouterModels);
    }
    return allModels;
  }, [
    isOllamaRunning,
    ollamaModels,
    hasToken,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
  ]);

  const applySseEvent = useCallback(
    (
      evt: SSEvent,
      assistantMessage: ChatMessage,
      assistantContentRef: { current: string },
      toolCallsRef: { current: any[] },
      toolResultsRef: { current: any[] },
      contentBlocksRef: { current: any[] },
    ) => {
      switch (evt.type) {
        case "text": {
          assistantContentRef.current += evt.content;

          // Add or update current text block
          const lastBlock =
            contentBlocksRef.current[contentBlocksRef.current.length - 1];
          if (lastBlock && lastBlock.type === "text") {
            // Update existing text block
            lastBlock.content = (lastBlock.content || "") + evt.content;
          } else {
            // Create new text block
            contentBlocksRef.current = [
              ...contentBlocksRef.current,
              {
                id: `text-${Date.now()}`,
                type: "text" as const,
                content: evt.content,
                timestamp: new Date(),
              },
            ];
          }

          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                    ...msg,
                    content: assistantContentRef.current,
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg,
            ),
          }));
          break;
        }
        case "tool_call": {
          const toolCall = {
            ...evt.toolCall,
            timestamp: new Date(evt.toolCall.timestamp),
          };
          toolCallsRef.current = [...toolCallsRef.current, toolCall];

          // Add tool call block
          contentBlocksRef.current = [
            ...contentBlocksRef.current,
            {
              id: `tool-call-${toolCall.id}`,
              type: "tool_call" as const,
              toolCall,
              timestamp: new Date(),
            },
          ];

          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                    ...msg,
                    toolCalls: [...toolCallsRef.current],
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg,
            ),
          }));
          break;
        }
        case "tool_result": {
          const toolResult = {
            ...evt.toolResult,
            timestamp: new Date(evt.toolResult.timestamp),
          };
          toolResultsRef.current = [...toolResultsRef.current, toolResult];
          toolCallsRef.current = toolCallsRef.current.map((tc) =>
            tc.id === toolResult.toolCallId
              ? {
                  ...tc,
                  status: toolResult.error ? "error" : "completed",
                }
              : tc,
          );

          // Update corresponding tool call block with result
          contentBlocksRef.current = contentBlocksRef.current.map((block) =>
            block.type === "tool_call" &&
            block.toolCall?.id === toolResult.toolCallId
              ? {
                  ...block,
                  toolCall: {
                    ...block.toolCall,
                    status: toolResult.error ? "error" : "completed",
                  },
                  toolResult,
                }
              : block,
          );

          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                    ...msg,
                    toolCalls: [...toolCallsRef.current],
                    toolResults: [...toolResultsRef.current],
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg,
            ),
          }));
          break;
        }
        case "elicitation_request": {
          setElicitationRequest({
            requestId: evt.requestId,
            message: evt.message,
            schema: evt.schema,
            timestamp: evt.timestamp,
          });
          break;
        }
        case "elicitation_complete": {
          setElicitationRequest(null);
          break;
        }
        case "trace_step": {
          // Optional: hook for UI tracing; currently ignored
          break;
        }
        case "error": {
          // Add error as a content block instead of throwing
          contentBlocksRef.current = [
            ...contentBlocksRef.current,
            {
              id: `error-${Date.now()}`,
              type: "error" as const,
              content: evt.error,
              timestamp: new Date(),
            },
          ];

          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? {
                    ...msg,
                    contentBlocks: [...contentBlocksRef.current],
                  }
                : msg,
            ),
          }));
          break;
        }
      }
    },
    [],
  );

  const sendChatRequest = useCallback(
    async (userMessage: ChatMessage) => {
      const routeThroughBackend =
        sendMessagesToBackend || (model && isMCPJamProvidedModel(model.id));

      if (!routeThroughBackend && (!model || !currentApiKey)) {
        throw new Error(
          "Missing required configuration: model and apiKey are required",
        );
      }

      const assistantMessage = createMessage("assistant", "");

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      try {
        let authHeader: string | null = null;
        if (routeThroughBackend && getAccessToken) {
          try {
            const token = await getAccessToken();
            if (token) {
              authHeader = `Bearer ${token}`;
            }
          } catch (tokenError) {
            console.warn(
              "[useChat] failed to retrieve access token",
              tokenError,
            );
          }
        }

        const response = await fetch("/api/mcp/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(authHeader ? { Authorization: authHeader } : {}),
          },
          body: JSON.stringify({
            model: model!,
            provider: model!.provider,
            apiKey: currentApiKey,
            systemPrompt,
            temperature,
            messages: messagesRef.current.concat(userMessage),
            ollamaBaseUrl: getOllamaBaseUrl(),
            litellmBaseUrl: getLiteLLMBaseUrl(),
            sendMessagesToBackend: routeThroughBackend,
            selectedServers,
          }),
          signal: abortControllerRef.current?.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          let errorData;
          try {
            errorData = JSON.parse(errorText);
          } catch {
            throw new Error(`Chat request failed: ${response.status}`);
          }
          throw new Error(errorData.error || "Chat request failed");
        }

        // Handle streaming response via parser
        const reader = response.body?.getReader();
        const assistantContent = { current: "" };
        const toolCalls = { current: [] as any[] };
        const toolResults = { current: [] as any[] };
        const contentBlocks = { current: [] as any[] };
        if (reader) {
          for await (const evt of parseSSEStream(reader)) {
            if (evt === "[DONE]") break;
            try {
              applySseEvent(
                evt,
                assistantMessage,
                assistantContent,
                toolCalls,
                toolResults,
                contentBlocks,
              );
            } catch (parseError) {
              console.warn("Failed applying SSE event", parseError);
            }
          }
          // streaming finished successfully
          setState((prev) => ({ ...prev, isLoading: false }));
        } else {
          // no reader available; treat as finished
          setState((prev) => ({ ...prev, isLoading: false }));
        }

        // Ensure we have some content, even if empty
        if (!assistantContent.current && !toolCalls.current.length) {
          console.warn("No content received from stream");
        }

        if (onMessageReceived) {
          const finalMessage = {
            ...assistantMessage,
            content: assistantContent.current,
          };
          onMessageReceived(finalMessage);
        }
      } catch (error) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
        }));
        throw error;
      } finally {
        // clear abort controller for this request
        abortControllerRef.current = null;
      }
    },
    [
      model,
      currentApiKey,
      systemPrompt,
      onMessageReceived,
      applySseEvent,
      getOllamaBaseUrl,
      getLiteLLMBaseUrl,
      sendMessagesToBackend,
      getAccessToken,
      selectedServers,
    ],
  );

  const sendMessage = useCallback(
    async (content: string, attachments?: Attachment[]) => {
      if (!content.trim() || state.isLoading) return;

      const userMessage = createMessage("user", content, attachments);

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, userMessage],
        isLoading: true,
        error: undefined,
      }));

      if (onMessageSent) {
        onMessageSent(userMessage);
      }

      // Create abort controller for this request
      abortControllerRef.current = new AbortController();

      try {
        await sendChatRequest(userMessage);
        setStatus("idle");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "An error occurred";
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
        setStatus("error");
        onError?.(errorMessage);
      }
    },
    [state.isLoading, onMessageSent, sendChatRequest, onError],
  );

  const stopGeneration = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    setState((prev) => ({
      ...prev,
      isLoading: false,
    }));
    setStatus("idle");
    abortControllerRef.current = null;
  }, []);

  const regenerateMessage = useCallback(
    async (messageId: string) => {
      // Find the message and the user message before it
      const messages = messagesRef.current;
      const messageIndex = messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1 || messageIndex === 0) return;

      const userMessage = messages[messageIndex - 1];
      if (userMessage.role !== "user") return;

      // Remove the assistant message and regenerate
      setState((prev) => ({
        ...prev,
        messages: prev.messages.slice(0, messageIndex),
        isLoading: true,
      }));

      abortControllerRef.current = new AbortController();

      try {
        await sendChatRequest(userMessage);
        setStatus("idle");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "An error occurred";
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: errorMessage,
        }));
        setStatus("error");
        onError?.(errorMessage);
      }
    },
    [state.isLoading, onMessageSent, sendChatRequest, onError],
  );

  const deleteMessage = useCallback((messageId: string) => {
    setState((prev) => ({
      ...prev,
      messages: prev.messages.filter((msg) => msg.id !== messageId),
    }));
  }, []);

  const clearChat = useCallback(() => {
    setState((prev) => ({
      ...prev,
      messages: [],
      error: undefined,
    }));
    setInput("");
  }, []);

  const handleElicitationResponse = useCallback(
    async (
      action: "accept" | "decline" | "cancel",
      parameters?: Record<string, any>,
    ) => {
      if (!elicitationRequest) {
        console.warn("Cannot handle elicitation response: no active request");
        return;
      }

      setElicitationLoading(true);

      try {
        let responseData = null;
        if (action === "accept") {
          responseData = {
            action: "accept",
            content: parameters || {},
          };
        } else {
          responseData = {
            action,
          };
        }

        const response = await fetch("/api/mcp/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "elicitation_response",
            requestId: elicitationRequest.requestId,
            response: responseData,
          }),
        });

        if (!response.ok) {
          const errorMsg = `HTTP error! status: ${response.status}`;
          throw new Error(errorMsg);
        }

        setElicitationRequest(null);
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        console.error("Error responding to elicitation request:", errorMessage);

        if (onError) {
          onError("Error responding to elicitation request");
        }
      } finally {
        setElicitationLoading(false);
      }
    },
    [elicitationRequest, onError],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  return {
    // State
    messages: state.messages,
    isLoading: state.isLoading,
    error: state.error,
    connectionStatus: state.connectionStatus,
    status,
    input,
    setInput,
    model,
    availableModels,
    hasValidApiKey: Boolean(currentApiKey),
    elicitationRequest,
    elicitationLoading,

    // Actions
    sendMessage,
    stopGeneration,
    regenerateMessage,
    deleteMessage,
    clearChat,
    setModel: handleModelChange,
    handleElicitationResponse,
  };
}

// Helpers
function pickDefaultModel(
  available: ModelDefinition[],
  isOllamaRunning: boolean,
): ModelDefinition | undefined {
  if (isOllamaRunning) {
    const local = available.find((m) => m.provider === "ollama");
    if (local) return local;
  }
  const priorities = [
    Model.CLAUDE_3_5_SONNET_LATEST,
    Model.GPT_4O,
    Model.DEEPSEEK_CHAT,
    Model.GEMINI_2_5_FLASH,
  ];
  for (const id of priorities) {
    const m = available.find((x) => x.id === id);
    if (m) return m;
  }
  return available[0];
}
