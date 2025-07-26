"use client";

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { ChatMessage, ChatState, Attachment } from "@/lib/chat-types";
import { createMessage } from "@/lib/chat-utils";
import {
  MastraMCPServerDefinition,
  Model,
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
  onModelChange?: (model: Model) => void;
}

export function useChat(options: UseChatOptions = {}) {
  const { getToken, hasToken, tokens } = useAiProviderKeys();

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
  const [model, setModel] = useState(Model.GPT_4O);
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(state.messages);

  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  // Check for Ollama models on mount and periodically
  useEffect(() => {
    const checkOllama = async () => {
      const { isRunning, availableModels } = await detectOllamaModels();
      setIsOllamaRunning(isRunning);
      setOllamaModels(availableModels);
    };

    checkOllama();
    
    // Check every 30 seconds for Ollama availability
    const interval = setInterval(checkOllama, 30000);
    
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (tokens.anthropic?.length > 0) {
      setModel(Model.CLAUDE_3_5_SONNET_20240620);
    } else if (tokens.openai?.length > 0) {
      setModel(Model.GPT_4O);
    } else if (isOllamaRunning && ollamaModels.length > 0) {
      // Set to first available Ollama model if no API keys are available
      const firstOllamaModel = SUPPORTED_MODELS.find(m => 
        m.provider === "ollama" && 
        ollamaModels.some(om => om === m.id || om.startsWith(`${m.id}:`))
      );
      if (firstOllamaModel) {
        setModel(firstOllamaModel.id);
      }
    }
  }, [tokens, isOllamaRunning, ollamaModels]);

  const currentApiKey = useMemo(() => {
    const modelDefinition = SUPPORTED_MODELS.find((m) => m.id === model);
    if (modelDefinition) {
      if (modelDefinition.provider === "ollama") {
        // For Ollama, return "local" if it's running and the model is available
        return isOllamaRunning && ollamaModels.some(om => 
          om === model || om.startsWith(`${model}:`)
        ) ? "local" : "";
      }
      return getToken(modelDefinition.provider);
    }
    return "";
  }, [model, getToken, isOllamaRunning, ollamaModels]);

  const handleModelChange = useCallback(
    (newModel: Model) => {
      setModel(newModel);
      if (onModelChange) {
        onModelChange(newModel);
      }
    },
    [onModelChange],
  );

  // Available models with API keys or local Ollama models
  const availableModels = SUPPORTED_MODELS.filter((m) => {
    if (m.provider === "ollama") {
      // For Ollama models, check if they're actually available locally
      return isOllamaRunning && ollamaModels.some(om => 
        om === m.id || om.startsWith(`${m.id}:`)
      );
    }
    return hasToken(m.provider);
  });

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
        (parsed.toolCall || parsed.toolCall)
      ) {
        const toolCall = parsed.toolCall || parsed.toolCall;
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
        (parsed.toolResult || parsed.toolResult)
      ) {
        const toolResult = parsed.toolResult || parsed.toolResult;
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

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") {
                  setState((prev) => ({
                    ...prev,
                    isLoading: false,
                  }));
                  break;
                }

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
