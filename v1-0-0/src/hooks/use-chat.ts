"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { ChatMessage, ChatState, Attachment } from "@/lib/chat-types";
import { createMessage } from "@/lib/chat-utils";
import {
  MastraMCPServerDefinition,
  Model,
  ModelDefinition,
  SUPPORTED_MODELS,
} from "@/lib/types";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { detectOllamaModels } from "@/lib/ollama-utils";

interface UseChatOptions {
  initialMessages?: ChatMessage[];
  serverConfigs?: Record<string, MastraMCPServerDefinition>;
  systemPrompt?: string;
  onMessageSent?: (message: ChatMessage) => void;
  onMessageReceived?: (message: ChatMessage) => void;
  onError?: (error: string) => void;
  onModelChange?: (model: ModelDefinition) => void;
}

export function useChat(options: UseChatOptions = {}) {
  const { getToken, hasToken, tokens, getOllamaBaseUrl } = useAiProviderKeys();

  const {
    initialMessages = [],
    serverConfigs,
    systemPrompt,
    onMessageSent,
    onMessageReceived,
    onError,
    onModelChange,
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
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(state.messages);
  console.log("model", model);
  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  // Check for Ollama models on mount and periodically
  useEffect(() => {
    const checkOllama = async () => {
      const { isRunning, availableModels } =
        await detectOllamaModels(getOllamaBaseUrl());
      setIsOllamaRunning(isRunning);

      // Convert string model names to ModelDefinition objects
      const ollamaModelDefinitions: ModelDefinition[] = availableModels.map(
        (modelName) => ({
          id: modelName,
          name: modelName,
          provider: "ollama" as const,
        }),
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
      if (isOllamaRunning && ollamaModels.length > 0) {
        setModel(ollamaModels[0]);
      } else if (hasToken("anthropic")) {
        const claudeModel = SUPPORTED_MODELS.find(
          (m) => m.id === Model.CLAUDE_3_5_SONNET_LATEST,
        );
        if (claudeModel) setModel(claudeModel);
      } else if (hasToken("openai")) {
        const gptModel = SUPPORTED_MODELS.find((m) => m.id === Model.GPT_4O);
        if (gptModel) setModel(gptModel);
      } else {
        setModel(null);
      }
    }
  }, [tokens, ollamaModels, isOllamaRunning, hasToken, model]);

  const currentApiKey = useMemo(() => {
    if (model) {
      if (model.provider === "ollama") {
        // For Ollama, return "local" if it's running and the model is available
        return isOllamaRunning &&
          ollamaModels.some(
            (om) => om.id === model.id || om.id.startsWith(`${model.id}:`),
          )
          ? "local"
          : "";
      }
      return getToken(model.provider);
    }
    return "";
  }, [model, getToken, isOllamaRunning, ollamaModels]);

  const handleModelChange = useCallback(
    (newModel: ModelDefinition) => {
      setModel(newModel);
      if (onModelChange) {
        onModelChange(newModel);
      }
    },
    [onModelChange],
  );

  // Available models with API keys or local Ollama models
  const availableModels = useMemo(() => {
    const availableModelsList: ModelDefinition[] = [];

    // Add supported models only if the provider has a valid API key
    for (const model of SUPPORTED_MODELS) {
      if (model.provider === "anthropic" && hasToken("anthropic")) {
        availableModelsList.push(model);
      } else if (model.provider === "openai" && hasToken("openai")) {
        availableModelsList.push(model);
      }
    }

    // Add Ollama models if Ollama is running
    if (isOllamaRunning && ollamaModels.length > 0) {
      availableModelsList.push(...ollamaModels);
    }

    return availableModelsList;
  }, [isOllamaRunning, ollamaModels, hasToken]);

  const handleStreamingEvent = useCallback(
    (
      parsed: any,
      assistantMessage: ChatMessage,
      assistantContent: { current: string },
      toolCalls: { current: any[] },
      toolResults: { current: any[] },
    ) => {
      // Handle text content
      if (
        (parsed.type === "text" || (!parsed.type && parsed.content)) &&
        parsed.content
      ) {
        assistantContent.current += parsed.content;
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((msg) =>
            msg.id === assistantMessage.id
              ? { ...msg, content: assistantContent.current }
              : msg,
          ),
        }));
        return;
      }

      // Handle tool calls
      if (
        (parsed.type === "tool_call" || (!parsed.type && parsed.toolCall)) &&
        parsed.toolCall
      ) {
        const toolCall = parsed.toolCall;
        toolCalls.current = [...toolCalls.current, toolCall];
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((msg) =>
            msg.id === assistantMessage.id
              ? { ...msg, toolCalls: [...toolCalls.current] }
              : msg,
          ),
        }));
        return;
      }

      // Handle tool results
      if (
        (parsed.type === "tool_result" ||
          (!parsed.type && parsed.toolResult)) &&
        parsed.toolResult
      ) {
        const toolResult = parsed.toolResult;
        toolResults.current = [...toolResults.current, toolResult];

        // Update the corresponding tool call status
        toolCalls.current = toolCalls.current.map((tc) =>
          tc.id === toolResult.toolCallId
            ? {
                ...tc,
                status: toolResult.error ? "error" : "completed",
              }
            : tc,
        );

        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((msg) =>
            msg.id === assistantMessage.id
              ? {
                  ...msg,
                  toolCalls: [...toolCalls.current],
                  toolResults: [...toolResults.current],
                }
              : msg,
          ),
        }));
        return;
      }

      // Handle errors
      if (
        (parsed.type === "error" || (!parsed.type && parsed.error)) &&
        parsed.error
      ) {
        throw new Error(parsed.error);
      }
    },
    [],
  );

  const sendChatRequest = useCallback(
    async (userMessage: ChatMessage) => {
      if (!serverConfigs || !model || !currentApiKey) {
        throw new Error(
          "Missing required configuration: serverConfig, model, and apiKey are required",
        );
      }

      const assistantMessage = createMessage("assistant", "");

      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      try {
        const response = await fetch("/api/mcp/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            serverConfigs,
            model,
            apiKey: currentApiKey,
            systemPrompt,
            messages: messagesRef.current.concat(userMessage),
            ollamaBaseUrl: getOllamaBaseUrl(),
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

        // Handle streaming response
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        const assistantContent = { current: "" };
        const toolCalls = { current: [] as any[] };
        const toolResults = { current: [] as any[] };
        let buffer = "";
        let isDone = false;

        if (reader) {
          while (!isDone) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");

            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6).trim();
                if (data === "[DONE]") {
                  isDone = true;
                  setState((prev) => ({
                    ...prev,
                    isLoading: false,
                  }));
                  break;
                }

                if (data) {
                  try {
                    const parsed = JSON.parse(data);
                    handleStreamingEvent(
                      parsed,
                      assistantMessage,
                      assistantContent,
                      toolCalls,
                      toolResults,
                    );
                  } catch (parseError) {
                    console.warn("Failed to parse SSE data:", data, parseError);
                  }
                }
              }
            }
          }
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
      }
    },
    [
      serverConfigs,
      model,
      currentApiKey,
      systemPrompt,
      onMessageReceived,
      handleStreamingEvent,
      getOllamaBaseUrl,
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

        if (onError) {
          onError(errorMessage);
        }
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

        if (onError) {
          onError(errorMessage);
        }
      }
    },
    [sendChatRequest, onError],
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

    // Actions
    sendMessage,
    stopGeneration,
    regenerateMessage,
    deleteMessage,
    clearChat,
    setModel: handleModelChange,
  };
}
