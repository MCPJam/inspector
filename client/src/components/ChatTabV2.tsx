import {
  FormEvent,
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
  generateId,
} from "ai";
import { useAuth } from "@workos-inc/authkit-react";
import { useConvexAuth } from "convex/react";
import { ModelDefinition, isGPT5Model } from "@/shared/types";
import {
  ProviderTokens,
  useAiProviderKeys,
} from "@/hooks/use-ai-provider-keys";
import { JsonRpcLoggerView } from "./logging/json-rpc-logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import type { DialogElicitation } from "@/components/ToolsTab";
import {
  detectOllamaModels,
  detectOllamaToolCapableModels,
} from "@/lib/ollama-utils";
import {
  buildAvailableModels,
  getDefaultModel,
} from "@/components/chat-v2/model-helpers";
import { isMCPJamProvidedModel } from "@/shared/types";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { Thread } from "@/components/chat-v2/thread";
import { ServerWithName } from "@/hooks/use-app-state";
import { getToolsMetadata, ToolServerMap } from "@/lib/mcp-tools-api";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { ConnectMcpServerCallout } from "@/components/chat-v2/connect-mcp-server-callout";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { ErrorBox } from "@/components/chat-v2/error";
import { usePersistedModel } from "@/hooks/use-persisted-model";
import { countMCPToolsTokens, countTextTokens } from "@/lib/mcp-tokenizer-api";
import {
  type MCPPromptResult,
  mcpPromptResultsToText,
} from "@/components/chat-v2/mcp-prompts-popover";

const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant with access to MCP tools.";

const STARTER_PROMPTS: Array<{ label: string; text: string }> = [
  {
    label: "Show me connected tools",
    text: "List my connected MCP servers and their available tools.",
  },
  {
    label: "Suggest an automation",
    text: "Suggest an automation I can build with my current MCP setup.",
  },
  {
    label: "Summarize recent activity",
    text: "Summarize the most recent activity across my MCP servers.",
  },
];

interface ChatTabProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
  onHasMessagesChange?: (hasMessages: boolean) => void;
}

function formatErrorMessage(
  error: unknown,
): { message: string; details?: string } | null {
  if (!error) return null;

  let errorString: string;
  if (typeof error === "string") {
    errorString = error;
  } else if (error instanceof Error) {
    errorString = error.message;
  } else {
    try {
      errorString = JSON.stringify(error);
    } catch {
      errorString = String(error);
    }
  }

  // Try to parse as JSON to extract message and details
  try {
    const parsed = JSON.parse(errorString);
    if (parsed && typeof parsed === "object" && parsed.message) {
      return {
        message: parsed.message,
        details: parsed.details,
      };
    }
  } catch {
    // Return as-is
  }

  return { message: errorString };
}

export function ChatTabV2({
  connectedServerConfigs,
  selectedServerNames,
  onHasMessagesChange,
}: ChatTabProps) {
  const { getAccessToken, signUp } = useAuth();
  const { isAuthenticated, isLoading: isAuthLoading } = useConvexAuth();
  const posthog = usePostHog();
  const {
    hasToken,
    getToken,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    getOllamaBaseUrl,
  } = useAiProviderKeys();

  const [input, setInput] = useState("");
  const [ollamaModels, setOllamaModels] = useState<ModelDefinition[]>([]);
  const [isOllamaRunning, setIsOllamaRunning] = useState(false);
  const [authHeaders, setAuthHeaders] = useState<
    Record<string, string> | undefined
  >(undefined);
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [temperature, setTemperature] = useState(0.7);
  const [chatSessionId, setChatSessionId] = useState(generateId());
  const [toolsMetadata, setToolsMetadata] = useState<
    Record<string, Record<string, any>>
  >({});
  const [toolServerMap, setToolServerMap] = useState<ToolServerMap>({});
  const [mcpToolsTokenCount, setMcpToolsTokenCount] = useState<Record<
    string,
    number
  > | null>(null);
  const [mcpToolsTokenCountLoading, setMcpToolsTokenCountLoading] =
    useState(false);
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [systemPromptTokenCount, setSystemPromptTokenCount] = useState<
    number | null
  >(null);
  const [systemPromptTokenCountLoading, setSystemPromptTokenCountLoading] =
    useState(false);
  const availableModels = useMemo(() => {
    return buildAvailableModels({
      hasToken,
      getLiteLLMBaseUrl,
      getLiteLLMModelAlias,
      getOpenRouterSelectedModels,
      isOllamaRunning,
      ollamaModels,
    });
  }, [
    hasToken,
    getLiteLLMBaseUrl,
    getLiteLLMModelAlias,
    getOpenRouterSelectedModels,
    isOllamaRunning,
    ollamaModels,
  ]);
  const { selectedModelId, setSelectedModelId } = usePersistedModel();
  const selectedModel = useMemo<ModelDefinition>(() => {
    const fallback = getDefaultModel(availableModels);
    if (!selectedModelId) return fallback;
    const found = availableModels.find((m) => String(m.id) === selectedModelId);
    return found ?? fallback;
  }, [availableModels, selectedModelId]);

  const [elicitation, setElicitation] = useState<DialogElicitation | null>(
    null,
  );
  const [elicitationLoading, setElicitationLoading] = useState(false);

  const selectedConnectedServerNames = useMemo(
    () =>
      selectedServerNames.filter(
        (name) =>
          connectedServerConfigs[name]?.connectionStatus === "connected",
      ),
    [selectedServerNames, connectedServerConfigs],
  );
  const noServersConnected = selectedConnectedServerNames.length === 0;

  const transport = useMemo(() => {
    const apiKey = getToken(selectedModel.provider as keyof ProviderTokens);
    const isGpt5 = isGPT5Model(selectedModel.id);

    return new DefaultChatTransport({
      api: "/api/mcp/chat-v2",
      body: {
        model: selectedModel,
        apiKey: apiKey,
        ...(isGpt5 ? {} : { temperature }),
        systemPrompt,
        selectedServers: selectedConnectedServerNames,
      },
      headers: authHeaders,
    });
  }, [
    selectedModel,
    getToken,
    authHeaders,
    temperature,
    systemPrompt,
    selectedConnectedServerNames,
  ]);

  useEffect(() => {
    posthog.capture("chat_tab_viewed", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, []);

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
      } catch {
        if (!active) return;
        setAuthHeaders(undefined);
      }
      resetChat();
    })();
    return () => {
      active = false;
    };
  }, [getAccessToken]);

  const isMcpJamModel = useMemo(() => {
    return selectedModel?.id
      ? isMCPJamProvidedModel(String(selectedModel.id))
      : false;
  }, [selectedModel]);

  const { messages, sendMessage, stop, status, error, setMessages } = useChat({
    id: chatSessionId,
    transport: transport!,
    // Disable client auto-send for MCPJam-provided models; server handles tool loop
    sendAutomaticallyWhen: isMcpJamModel
      ? undefined
      : lastAssistantMessageIsCompleteWithToolCalls,
  });

  // Notify parent when messages change
  useEffect(() => {
    onHasMessagesChange?.(messages.length > 0);
  }, [messages.length, onHasMessagesChange]);

  // Sum token usage from all assistant messages with metadata
  const tokenUsage = useMemo(() => {
    let lastInputTokens = 0;
    let totalOutputTokens = 0;

    // Find the last assistant message with metadata for inputTokens
    // Sum outputTokens across all assistant messages
    for (const message of messages) {
      if (message.role === "assistant" && message.metadata) {
        const metadata = message.metadata as
          | {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
            }
          | undefined;

        if (metadata) {
          // Update lastInputTokens with the most recent value
          lastInputTokens = metadata.inputTokens ?? 0;
          // Sum outputTokens across all messages
          totalOutputTokens += metadata.outputTokens ?? 0;
        }
      }
    }

    const totalTokens = lastInputTokens + totalOutputTokens;

    return {
      inputTokens: lastInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
    };
  }, [messages]);
  const resetChat = useCallback(() => {
    setChatSessionId(generateId());
    setMessages([]);
    setInput("");
  }, [setMessages]);

  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: any) => {
      setMessages((prevMessages) => {
        const messageId = `widget-state-${toolCallId}`;

        // If state is null, remove the widget state message
        if (state === null) {
          return prevMessages.filter((msg) => msg.id !== messageId);
        }

        const stateText = `The state of widget ${toolCallId} is: ${JSON.stringify(state)}`;

        const existingIndex = prevMessages.findIndex(
          (msg) => msg.id === messageId,
        );

        if (existingIndex !== -1) {
          const existingMessage = prevMessages[existingIndex];
          const existingText =
            existingMessage.parts?.[0]?.type === "text"
              ? (existingMessage.parts[0] as any).text
              : null;
          if (existingText === stateText) {
            return prevMessages;
          }

          const newMessages = [...prevMessages];
          newMessages[existingIndex] = {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text", text: stateText }],
          };
          return newMessages;
        }

        return [
          ...prevMessages,
          {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text", text: stateText }],
          },
        ];
      });
    },
    [setMessages],
  );

  useEffect(() => {
    resetChat();
  }, [resetChat]);

  const previousSelectedServersRef = useRef<string[]>(
    selectedConnectedServerNames,
  );

  useEffect(() => {
    const previousNames = previousSelectedServersRef.current;
    const currentNames = selectedConnectedServerNames;
    const hasChanged =
      previousNames.length !== currentNames.length ||
      previousNames.some((name, index) => name !== currentNames[index]);

    if (hasChanged) {
      resetChat();
    }

    previousSelectedServersRef.current = currentNames;
  }, [selectedConnectedServerNames, resetChat]);

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

  useEffect(() => {
    const es = new EventSource("/api/mcp/elicitation/stream");
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data?.type === "elicitation_request") {
          setElicitation({
            requestId: data.requestId,
            message: data.message,
            schema: data.schema,
            timestamp: data.timestamp || new Date().toISOString(),
          });
        } else if (data?.type === "elicitation_complete") {
          setElicitation((prev) =>
            prev?.requestId === data.requestId ? null : prev,
          );
        }
      } catch (error) {
        console.warn("[ChatTabV2] Failed to parse elicitation event:", error);
      }
    };
    es.onerror = () => {
      console.warn(
        "[ChatTabV2] Elicitation SSE connection error, browser will retry",
      );
    };
    return () => es.close();
  }, []);

  const handleElicitationResponse = async (
    action: "accept" | "decline" | "cancel",
    parameters?: Record<string, any>,
  ) => {
    if (!elicitation) return;
    setElicitationLoading(true);
    try {
      await fetch("/api/mcp/elicitation/respond", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: elicitation.requestId,
          action,
          content: parameters,
        }),
      });
      setElicitation(null);
    } finally {
      setElicitationLoading(false);
    }
  };

  useEffect(() => {
    const fetchToolsMetadata = async () => {
      const { metadata, toolServerMap } = await getToolsMetadata(
        selectedConnectedServerNames,
      );
      setToolsMetadata(metadata);
      setToolServerMap(toolServerMap);
    };
    fetchToolsMetadata();
  }, [selectedConnectedServerNames]);

  useEffect(() => {
    const fetchMcpToolsTokenCount = async () => {
      if (
        selectedConnectedServerNames.length === 0 ||
        !selectedModel?.id ||
        !selectedModel?.provider
      ) {
        setMcpToolsTokenCount(null);
        setMcpToolsTokenCountLoading(false);
        return;
      }

      setMcpToolsTokenCountLoading(true);
      try {
        const modelId = isMCPJamProvidedModel(String(selectedModel.id))
          ? String(selectedModel.id)
          : `${selectedModel.provider}/${selectedModel.id}`;
        const counts = await countMCPToolsTokens(
          selectedConnectedServerNames,
          modelId,
        );
        setMcpToolsTokenCount(
          counts && Object.keys(counts).length > 0 ? counts : null,
        );
      } catch (error) {
        console.warn("[ChatTabV2] Failed to count MCP tools tokens:", error);
        setMcpToolsTokenCount(null);
      } finally {
        setMcpToolsTokenCountLoading(false);
      }
    };

    fetchMcpToolsTokenCount();
  }, [selectedConnectedServerNames, selectedModel]);

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
          "[ChatTabV2] Failed to count system prompt tokens:",
          error,
        );
        setSystemPromptTokenCount(null);
      } finally {
        setSystemPromptTokenCountLoading(false);
      }
    };

    fetchSystemPromptTokenCount();
  }, [systemPrompt, selectedModel]);

  const disableForAuthentication = !isAuthenticated && isMcpJamModel;
  const disableForServers = noServersConnected;
  const isStreaming = status === "streaming" || status === "submitted";
  const submitBlocked = disableForAuthentication || disableForServers;
  const inputDisabled = status !== "ready" || submitBlocked;

  let placeholder = 'Ask something… Use Slash "/" commands for MCP prompts';
  if (disableForServers) {
    placeholder = "Connect an MCP server to send your first message";
  }
  if (disableForAuthentication) {
    placeholder = "Sign in to use free chat";
  }

  // Show loading state while auth is initializing
  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const shouldShowConnectCallout =
    disableForServers && !shouldShowUpsell && !isAuthLoading;
  const showDisabledCallout =
    messages.length === 0 && (shouldShowUpsell || shouldShowConnectCallout);

  const errorMessage = formatErrorMessage(error);

  const handleSignUp = () => {
    posthog.capture("sign_up_button_clicked", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
    signUp();
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      (input.trim() || mcpPromptResults.length > 0) &&
      status === "ready" &&
      !disableForAuthentication &&
      !disableForServers
    ) {
      posthog.capture("send_message", {
        location: "chat_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });
      sendMessage({
        text: `${mcpPromptResultsToText(mcpPromptResults) || ""}${input}`,
      });
      setInput("");
      setMcpPromptResults([]);
    }
  };

  const handleStarterPrompt = (prompt: string) => {
    if (submitBlocked || inputDisabled) {
      setInput(prompt);
      return;
    }
    posthog.capture("send_message", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
      model_id: selectedModel?.id ?? null,
      model_name: selectedModel?.name ?? null,
      model_provider: selectedModel?.provider ?? null,
    });
    sendMessage({ text: prompt });
    setInput("");
  };

  const sharedChatInputProps = {
    value: input,
    onChange: setInput,
    onSubmit,
    stop,
    disabled: inputDisabled,
    isLoading: isStreaming,
    placeholder,
    currentModel: selectedModel,
    availableModels,
    onModelChange: (model: ModelDefinition) => {
      setSelectedModelId(String(model.id));
      resetChat();
    },
    systemPrompt,
    onSystemPromptChange: setSystemPrompt,
    temperature,
    onTemperatureChange: setTemperature,
    onResetChat: resetChat,
    submitDisabled: submitBlocked,
    tokenUsage,
    selectedServers: selectedConnectedServerNames,
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    connectedServerConfigs,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,
    mcpPromptResults,
    onChangeMcpPromptResults: setMcpPromptResults,
  };

  const showStarterPrompts =
    !showDisabledCallout && messages.length === 0 && !isAuthLoading;

  return (
    <div className="flex flex-1 h-full min-h-0 flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 h-full"
      >
        <ResizablePanel defaultSize={70} minSize={40} className="min-w-0">
          <div className="flex flex-col bg-background h-full min-h-0 overflow-hidden">
            {messages.length === 0 ? (
              <div className="flex-1 flex items-center justify-center overflow-y-auto px-4">
                <div className="w-full max-w-3xl space-y-6 py-8">
                  {isAuthLoading ? (
                    <div className="text-center space-y-4">
                      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-primary" />
                      <p className="text-sm text-muted-foreground">
                        Loading...
                      </p>
                    </div>
                  ) : showDisabledCallout ? (
                    <div className="space-y-4">
                      {shouldShowUpsell ? (
                        <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
                      ) : (
                        <ConnectMcpServerCallout />
                      )}
                    </div>
                  ) : null}

                  <div className="space-y-4">
                    {showStarterPrompts && (
                      <div className="text-center">
                        <p className="text-sm text-muted-foreground mb-3">
                          Try one of these to get started
                        </p>
                        <div className="flex flex-wrap justify-center gap-2">
                          {STARTER_PROMPTS.map((prompt) => (
                            <button
                              key={prompt.text}
                              type="button"
                              onClick={() => handleStarterPrompt(prompt.text)}
                              className="rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground transition hover:border-foreground hover:bg-accent cursor-pointer font-light"
                            >
                              {prompt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {!isAuthLoading && (
                      <ChatInput
                        {...sharedChatInputProps}
                        hasMessages={false}
                      />
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-1 flex-col min-h-0 animate-in fade-in duration-300">
                  <div className="flex-1 overflow-y-auto">
                    <Thread
                      messages={messages}
                      sendFollowUpMessage={(text: string) =>
                        sendMessage({ text })
                      }
                      model={selectedModel}
                      isLoading={status === "submitted"}
                      toolsMetadata={toolsMetadata}
                      toolServerMap={toolServerMap}
                      onWidgetStateChange={handleWidgetStateChange}
                    />
                  </div>
                  {errorMessage && (
                    <div className="px-4 pb-4 pt-4">
                      <ErrorBox
                        message={errorMessage.message}
                        errorDetails={errorMessage.details}
                        onResetChat={resetChat}
                      />
                    </div>
                  )}
                </div>

                <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0 animate-in slide-in-from-bottom duration-500">
                  <div className="max-w-4xl mx-auto p-4">
                    <ChatInput {...sharedChatInputProps} hasMessages />
                  </div>
                </div>
              </>
            )}

            <ElicitationDialog
              elicitationRequest={elicitation}
              onResponse={handleElicitationResponse}
              loading={elicitationLoading}
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        <ResizablePanel
          defaultSize={30}
          minSize={20}
          maxSize={50}
          className="min-w-[260px] min-h-0 overflow-hidden"
        >
          <div className="h-full minh-0 overflow-hidden">
            <JsonRpcLoggerView />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  );
}
