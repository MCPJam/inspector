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
import { CreateMLCEngine, MLCEngine } from "@mlc-ai/web-llm";

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
  const [webLlmEngine, setWebLlmEngine] = useState<MLCEngine | null>(null);
  const [webLlmLoading, setWebLlmLoading] = useState(false);
  const [webGpuSupported, setWebGpuSupported] = useState<boolean | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(state.messages);

  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  // Check WebGPU support
  useEffect(() => {
    const checkWebGpuSupport = async () => {
      if (typeof navigator !== "undefined" && "gpu" in navigator) {
        try {
          const gpu = (navigator as any).gpu;
          const adapter = await gpu.requestAdapter();
          setWebGpuSupported(!!adapter);
        } catch {
          setWebGpuSupported(false);
        }
      } else {
        setWebGpuSupported(false);
      }
    };
    checkWebGpuSupport();
  }, []);

  useEffect(() => {
    if (tokens.anthropic?.length > 0) {
      setModel(Model.CLAUDE_3_5_SONNET_20240620);
    } else if (tokens.openai?.length > 0) {
      setModel(Model.GPT_4O);
    } else if (webGpuSupported) {
      setModel(Model.LLAMA_3_1_8B_INSTRUCT);
    }
  }, [tokens, webGpuSupported]);

  const currentApiKey = useMemo(() => {
    const modelDefinition = SUPPORTED_MODELS.find((m) => m.id === model);
    if (modelDefinition && modelDefinition.provider !== "web-llm") {
      return getToken(modelDefinition.provider);
    }
    return "";
  }, [model, getToken]);

  const handleModelChange = useCallback(
    (newModel: Model) => {
      setModel(newModel);
      if (onModelChange) {
        onModelChange(newModel);
      }
    },
    [onModelChange],
  );

  // Available models with API keys or WebGPU support
  const availableModels = SUPPORTED_MODELS.filter((m) => 
    m.provider === "web-llm" ? webGpuSupported : hasToken(m.provider)
  );

  // Initialize web-llm engine when needed
  const initializeWebLlmEngine = useCallback(async (modelId: string) => {
    if (webLlmEngine || webLlmLoading) return webLlmEngine;
    
    setWebLlmLoading(true);
    try {
      const engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (progress) => {
          console.log("WebLLM init progress:", progress);
        },
      });
      setWebLlmEngine(engine);
      setWebLlmLoading(false);
      return engine;
    } catch (error) {
      console.error("Failed to initialize WebLLM engine:", error);
      setWebLlmLoading(false);
      throw error;
    }
  }, [webLlmEngine, webLlmLoading]);

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

  const sendWebLlmRequest = useCallback(
    async (userMessage: ChatMessage) => {
      const modelDefinition = SUPPORTED_MODELS.find((m) => m.id === model);
      if (!modelDefinition || modelDefinition.provider !== "web-llm") {
        throw new Error("Invalid web-llm model");
      }

      const engine = await initializeWebLlmEngine(model);
      if (!engine) {
        throw new Error("Failed to initialize WebLLM engine");
      }

      const assistantMessage = createMessage("assistant", "");
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      try {
        const messages = messagesRef.current.concat(userMessage).map(msg => ({
          role: msg.role,
          content: msg.content,
        }));

        if (systemPrompt) {
          messages.unshift({ role: "system", content: systemPrompt });
        }

        const completion = await engine.chat.completions.create({
          messages: messages as any,
          stream: true,
        });

        let content = "";
        for await (const chunk of completion) {
          const delta = chunk.choices[0]?.delta?.content || "";
          content += delta;
          
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((msg) =>
              msg.id === assistantMessage.id
                ? { ...msg, content }
                : msg,
            ),
          }));
        }

        setState((prev) => ({
          ...prev,
          isLoading: false,
        }));

        if (onMessageReceived) {
          const finalMessage = {
            ...assistantMessage,
            content,
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
    [model, initializeWebLlmEngine, systemPrompt, onMessageReceived],
  );

  const sendChatRequest = useCallback(
    async (userMessage: ChatMessage) => {
      const modelDefinition = SUPPORTED_MODELS.find((m) => m.id === model);
      
      if (modelDefinition?.provider === "web-llm") {
        return sendWebLlmRequest(userMessage);
      }

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
      sendWebLlmRequest,
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
    hasValidApiKey: Boolean(currentApiKey) || SUPPORTED_MODELS.find((m) => m.id === model)?.provider === "web-llm",

    // Actions
    sendMessage,
    stopGeneration,
    regenerateMessage,
    deleteMessage,
    clearChat,
    setModel: handleModelChange,
  };
}
