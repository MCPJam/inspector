import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { ChatMessage, ChatState, Attachment } from "@/lib/chat-types";
import { createMessage } from "@/lib/chat-utils";
import {
  MastraMCPServerDefinition,
  Model,
  ModelDefinition,
  SUPPORTED_MODELS,
} from "@/shared/types.js";
import { useAiProviderKeys } from "@/hooks/use-ai-provider-keys";
import { detectOllamaModels } from "@/lib/ollama-utils";
import { CreateMLCEngine } from "@mlc-ai/web-llm";

interface ElicitationRequest {
  requestId: string;
  message: string;
  schema: any;
  timestamp: string;
}

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
  const [elicitationRequest, setElicitationRequest] =
    useState<ElicitationRequest | null>(null);
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [webGpuSupported, setWebGpuSupported] = useState<boolean | null>(null);
  const [webLlmEngine, setWebLlmEngine] = useState<any | null>(null);
  const [webLlmLoading, setWebLlmLoading] = useState(false);
  const [webLlmToolsCache, setWebLlmToolsCache] = useState<
    | null
    | {
        tools: any[];
        serverKeyByPrefixedName: Record<string, { serverKey: string; toolName: string }>;
      }
  >(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const messagesRef = useRef(state.messages);
  console.log("model", model);
  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  // Detect WebGPU support
  useEffect(() => {
    const checkWebGpu = async () => {
      if (typeof navigator !== "undefined" && (navigator as any).gpu) {
        try {
          const adapter = await (navigator as any).gpu.requestAdapter();
          setWebGpuSupported(!!adapter);
        } catch {
          setWebGpuSupported(false);
        }
      } else {
        setWebGpuSupported(false);
      }
    };
    checkWebGpu();
  }, []);

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
      } else if (hasToken("deepseek")) {
        const deepseekModel = SUPPORTED_MODELS.find(
          (m) => m.id === Model.DEEPSEEK_CHAT,
        );
        if (deepseekModel) setModel(deepseekModel);
      } else if (webGpuSupported) {
        const webLlmDefault = SUPPORTED_MODELS.find(
          (m) => m.provider === "web-llm",
        );
        if (webLlmDefault) setModel(webLlmDefault);
      } else {
        setModel(null);
      }
    }
  }, [tokens, ollamaModels, isOllamaRunning, hasToken, model, webGpuSupported]);

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
      } else if (model.provider === "web-llm") {
        // WebLLM runs locally in browser; no API key needed
        return "local";
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
      } else if (model.provider === "deepseek" && hasToken("deepseek")) {
        availableModelsList.push(model);
      } else if (model.provider === "web-llm" && webGpuSupported) {
        availableModelsList.push(model);
      }
    }

    // Add Ollama models if Ollama is running
    if (isOllamaRunning && ollamaModels.length > 0) {
      availableModelsList.push(...ollamaModels);
    }

    return availableModelsList;
  }, [isOllamaRunning, ollamaModels, hasToken, webGpuSupported]);

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

      // Handle elicitation requests
      if (parsed.type === "elicitation_request") {
        setElicitationRequest({
          requestId: parsed.requestId,
          message: parsed.message,
          schema: parsed.schema,
          timestamp: parsed.timestamp,
        });
        return;
      }

      // Handle elicitation completion
      if (parsed.type === "elicitation_complete") {
        setElicitationRequest(null);
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

  // Initialize WebLLM engine for the given model id
  const initializeWebLlmEngine = useCallback(
    async (modelId: string) => {
      if (webLlmEngine || webLlmLoading) return webLlmEngine;
      setWebLlmLoading(true);
      try {
        const engine = await CreateMLCEngine(modelId, {
          initProgressCallback: (p: any) => {
            console.log("[WebLLM] init progress", p);
          },
        });
        setWebLlmEngine(engine);
        return engine;
      } finally {
        setWebLlmLoading(false);
      }
    },
    [webLlmEngine, webLlmLoading],
  );

  // Fetch tools for a single server (returns JSON schema tools)
  const fetchServerTools = useCallback(
    async (serverKey: string, serverConfig: MastraMCPServerDefinition) => {
      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list", serverConfig }),
      });
      if (!response.ok) throw new Error("Failed to list tools");
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("No SSE body when listing tools");
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "tools_list") {
                return parsed.tools as Record<string, any>;
              }
            } catch {}
          }
        }
      }
      return {} as Record<string, any>;
    },
    [],
  );

  // Build WebLLM tools array combining all configured servers
  const buildWebLlmTools = useCallback(async () => {
    if (!serverConfigs || Object.keys(serverConfigs).length === 0) {
      return { tools: [], serverKeyByPrefixedName: {} as Record<string, { serverKey: string; toolName: string }> };
    }
    if (webLlmToolsCache) return webLlmToolsCache;
    const serverEntries = Object.entries(serverConfigs);
    const serverKeyByPrefixedName: Record<string, { serverKey: string; toolName: string }> = {};
    const toolsArray: any[] = [];
    // Fetch all servers in parallel
    const toolsByServer = await Promise.all(
      serverEntries.map(async ([key, cfg]) => {
        try {
          const tools = await fetchServerTools(key, cfg);
          return { key, tools } as const;
        } catch (e) {
          console.warn("Failed to fetch tools for server", key, e);
          return { key, tools: {} } as const;
        }
      }),
    );
    for (const { key, tools } of toolsByServer) {
      for (const [toolName, toolDef] of Object.entries(tools)) {
        const prefixed = `${key}__${toolName}`;
        serverKeyByPrefixedName[prefixed] = { serverKey: key, toolName };
        toolsArray.push({
          type: "function",
          function: {
            name: prefixed,
            description: (toolDef as any).description || undefined,
            parameters: (toolDef as any).inputSchema || { type: "object", properties: {} },
          },
        });
      }
    }
    const built = { tools: toolsArray, serverKeyByPrefixedName };
    setWebLlmToolsCache(built);
    return built;
  }, [serverConfigs, webLlmToolsCache, fetchServerTools]);

  const executeToolOnServer = useCallback(
    async (
      serverKey: string,
      serverConfig: MastraMCPServerDefinition,
      toolName: string,
      parameters: Record<string, any>,
    ) => {
      const response = await fetch("/api/mcp/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "execute",
          serverConfig,
          toolName,
          parameters,
        }),
      });
      if (!response.ok) throw new Error(`Tool execution failed (${serverKey}/${toolName})`);
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) return null;
      let result: any = null;
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "tool_result") {
                result = parsed.result;
              }
            } catch {}
          }
        }
      }
      return result;
    },
    [],
  );

  const sendWebLlmRequest = useCallback(
    async (userMessage: ChatMessage) => {
      if (!model || model.provider !== "web-llm") {
        throw new Error("Invalid WebLLM model");
      }
      const engine = (await initializeWebLlmEngine(String(model.id))) as any;
      if (!engine) throw new Error("Failed to initialize WebLLM engine");

      const assistantMessage = createMessage("assistant", "");
      setState((prev) => ({
        ...prev,
        messages: [...prev.messages, assistantMessage],
      }));

      const messages = messagesRef.current.concat(userMessage).map((m) => ({
        role: m.role,
        content: m.content,
      }));
      if (systemPrompt) {
        messages.unshift({ role: "system", content: systemPrompt } as any);
      }

      // Prepare tools
      const { tools, serverKeyByPrefixedName } = await buildWebLlmTools();

      // Local states for UI streaming updates
      const assistantContent = { current: "" };
      const toolCalls = { current: [] as any[] };
      const toolResults = { current: [] as any[] };

      // Round-based tool calling until no more tool calls
      const maxRounds = 6;
      let round = 0;
      let conversation = [...messages];
      while (round < maxRounds) {
        round++;
        const response = await engine.chat.completions.create({
          messages: conversation,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? "auto" : undefined,
          stream: false,
        });
        const choice = response?.choices?.[0];
        const msg = choice?.message || {};
        const contentText = (msg as any).content || "";
        if (contentText) {
          assistantContent.current += contentText;
          setState((prev) => ({
            ...prev,
            messages: prev.messages.map((m) =>
              m.id === assistantMessage.id
                ? { ...m, content: assistantContent.current }
                : m,
            ),
          }));
        }

        // Normalize tool calls across possible shapes
        const tc =
          (msg as any).tool_calls ||
          (msg as any).toolCalls ||
          ((msg as any).function_call
            ? [
                {
                  id: (msg as any).id || `call_${Date.now()}`,
                  type: "function",
                  function: {
                    name: (msg as any).function_call?.name,
                    arguments: (msg as any).function_call?.arguments,
                  },
                },
              ]
            : []);

        if (tc && Array.isArray(tc) && tc.length > 0) {
          // For each tool call, execute against MCP server
          for (const call of tc) {
            const callId = call.id || `call_${Date.now()}_${Math.random()}`;
            const rawName = call.function?.name || (call as any).name;
            const argsRaw = call.function?.arguments || (call as any).arguments || "{}";
            let args: Record<string, any> = {};
            try {
              args = typeof argsRaw === "string" ? JSON.parse(argsRaw) : argsRaw;
            } catch {
              args = {};
            }

            // Track tool_call event
            const toolCallEvent = {
              id: callId,
              name: rawName,
              parameters: args,
              timestamp: new Date(),
              status: "executing" as const,
            };
            toolCalls.current = [...toolCalls.current, toolCallEvent];
            setState((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === assistantMessage.id
                  ? { ...m, toolCalls: [...toolCalls.current] }
                  : m,
              ),
            }));

            // Route to server and execute
            const mapping = rawName ? serverKeyByPrefixedName[rawName] : undefined;
            if (!mapping) {
              // Mark error if unknown mapping
              const errResult = {
                id: callId,
                toolCallId: callId,
                error: `Unknown tool: ${rawName}`,
                timestamp: new Date(),
              };
              toolResults.current = [...toolResults.current, errResult];
              setState((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === assistantMessage.id
                    ? {
                        ...m,
                        toolResults: [...toolResults.current],
                        toolCalls: toolCalls.current.map((tc) =>
                          tc.id === callId ? { ...tc, status: "error" } : tc,
                        ),
                      }
                    : m,
                ),
              }));
              continue;
            }

            const { serverKey, toolName } = mapping;
            const serverConfig = serverConfigs?.[serverKey];
            let result: any = null;
            try {
              result = await executeToolOnServer(serverKey, serverConfig!, toolName, args);
            } catch (e) {
              const err = e instanceof Error ? e.message : String(e);
              const toolResEvent = {
                id: callId,
                toolCallId: callId,
                error: err,
                timestamp: new Date(),
              };
              toolResults.current = [...toolResults.current, toolResEvent];
              setState((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === assistantMessage.id
                    ? {
                        ...m,
                        toolResults: [...toolResults.current],
                        toolCalls: toolCalls.current.map((tc) =>
                          tc.id === callId ? { ...tc, status: "error" } : tc,
                        ),
                      }
                    : m,
                ),
              }));
              // Append tool message so model can recover
              conversation.push({
                role: "tool",
                tool_call_id: callId,
                content: JSON.stringify({ error: err }),
              } as any);
              continue;
            }

            const toolResEvent = {
              id: callId,
              toolCallId: callId,
              result,
              timestamp: new Date(),
            };
            toolResults.current = [...toolResults.current, toolResEvent];
            // Mark completed
            toolCalls.current = toolCalls.current.map((tc) =>
              tc.id === callId ? { ...tc, status: "completed" } : tc,
            );
            setState((prev) => ({
              ...prev,
              messages: prev.messages.map((m) =>
                m.id === assistantMessage.id
                  ? {
                      ...m,
                      toolCalls: [...toolCalls.current],
                      toolResults: [...toolResults.current],
                    }
                  : m,
              ),
            }));

            // Provide result back to LLM
            conversation.push({
              role: "tool",
              tool_call_id: callId,
              content: typeof result === "string" ? result : JSON.stringify(result),
            } as any);
          }
          // After executing tools, ask the model again for the final answer in a streaming pass
          const stream = await engine.chat.completions.create({
            messages: conversation,
            stream: true,
          });
          for await (const chunk of stream as any) {
            const delta = chunk?.choices?.[0]?.delta?.content || "";
            if (delta) {
              assistantContent.current += delta;
              setState((prev) => ({
                ...prev,
                messages: prev.messages.map((m) =>
                  m.id === assistantMessage.id
                    ? { ...m, content: assistantContent.current }
                    : m,
                ),
              }));
            }
          }
          break;
        } else {
          // No tool calls; we are done
          break;
        }
      }

      setState((prev) => ({
        ...prev,
        isLoading: false,
      }));

      if (onMessageReceived) {
        const finalMessage = {
          ...assistantMessage,
          content: assistantContent.current,
        };
        onMessageReceived(finalMessage);
      }
    },
    [model, initializeWebLlmEngine, buildWebLlmTools, executeToolOnServer, systemPrompt, onMessageReceived, serverConfigs],
  );

  const sendChatRequest = useCallback(
    async (userMessage: ChatMessage) => {
      if (model && model.provider === "web-llm") {
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
    hasValidApiKey:
      Boolean(currentApiKey) || (model?.provider === "web-llm" && !!webGpuSupported),
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
