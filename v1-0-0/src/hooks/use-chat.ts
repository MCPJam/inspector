"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { ChatMessage, ChatState, Attachment } from "@/lib/chat-types";
import { createMessage } from "@/lib/chat-utils";
import { MastraMCPServerDefinition, SUPPORTED_MODELS } from "@/lib/types";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";

interface UseChatOptions {
  initialMessages?: ChatMessage[];
  serverConfig?: MastraMCPServerDefinition;
  initialModel?: string;
  systemPrompt?: string;
  onMessageSent?: (message: ChatMessage) => void;
  onMessageReceived?: (message: ChatMessage) => void;
  onError?: (error: string) => void;
  onModelChange?: (model: string) => void;
}

export function useChat(options: UseChatOptions = {}) {
  const {
    initialMessages = [],
    serverConfig,
    initialModel = "claude-3-5-sonnet-20240620",
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
  const [model, setModel] = useState(initialModel);
  const abortControllerRef = useRef<AbortController | null>(null);
  const { getToken, hasToken } = useAiProviderKeys();

  // Get API key based on current model
  const getApiKeyForModel = useCallback(
    (modelName: string) => {
      if (modelName.includes("claude")) {
        return getToken("anthropic");
      } else if (modelName.includes("gpt")) {
        return getToken("openai");
      }
      return "";
    },
    [getToken],
  );

  const currentApiKey = getApiKeyForModel(model);

  // Handle model changes
  const handleModelChange = useCallback(
    (newModel: string) => {
      setModel(newModel);
      if (onModelChange) {
        onModelChange(newModel);
      }
    },
    [onModelChange],
  );

  // Available models with API keys
  const availableModels = SUPPORTED_MODELS.filter((m) => hasToken(m.provider));

  const sendChatRequest = useCallback(
    async (userMessage: ChatMessage) => {
      if (!serverConfig || !model || !currentApiKey) {
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
        console.log("serverConfig", serverConfig);
        const response = await fetch("/api/mcp/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            serverConfig,
            model,
            apiKey: currentApiKey,
            systemPrompt,
            messages: state.messages.concat(userMessage),
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
        let assistantContent = "";
        let toolCalls: any[] = [];
        const toolResults: any[] = [];

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

                  if (parsed.content) {
                    assistantContent += parsed.content;
                    setState((prev) => ({
                      ...prev,
                      messages: prev.messages.map((msg) =>
                        msg.id === assistantMessage.id
                          ? { ...msg, content: assistantContent }
                          : msg,
                      ),
                    }));
                  }

                  if (parsed.toolCall) {
                    toolCalls.push(parsed.toolCall);
                    setState((prev) => ({
                      ...prev,
                      messages: prev.messages.map((msg) =>
                        msg.id === assistantMessage.id
                          ? { ...msg, toolCalls: [...toolCalls] }
                          : msg,
                      ),
                    }));
                  }

                  if (parsed.toolResult) {
                    toolResults.push(parsed.toolResult);
                    // Update the corresponding tool call status
                    toolCalls = toolCalls.map((tc) =>
                      tc.id === parsed.toolResult.toolCallId
                        ? {
                            ...tc,
                            status: parsed.toolResult.error
                              ? "error"
                              : "completed",
                          }
                        : tc,
                    );
                    setState((prev) => ({
                      ...prev,
                      messages: prev.messages.map((msg) =>
                        msg.id === assistantMessage.id
                          ? {
                              ...msg,
                              toolCalls: [...toolCalls],
                              toolResults: [...toolResults],
                            }
                          : msg,
                      ),
                    }));
                  }

                  if (parsed.error) {
                    throw new Error(parsed.error);
                  }
                } catch (parseError) {
                  console.warn("Failed to parse SSE data:", data);
                }
              }
            }
          }
        }

        if (onMessageReceived) {
          const finalMessage = {
            ...assistantMessage,
            content: assistantContent,
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
      serverConfig,
      model,
      currentApiKey,
      systemPrompt,
      state.messages,
      onMessageReceived,
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
      const messageIndex = state.messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1 || messageIndex === 0) return;

      const userMessage = state.messages[messageIndex - 1];
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
    [state.messages, sendChatRequest, onError],
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
