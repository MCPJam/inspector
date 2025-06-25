import React, { useState, useEffect, useRef } from "react";
import { useMcpClient } from "@/context/McpClientContext";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  Tool as MessageTool,
} from "@anthropic-ai/sdk/resources/messages/messages.mjs";
import { Send, User, Key, ChevronDown, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { ToolCallMessage } from "./ToolCallMessage";
import { parseToolCallContent } from "@/utils/toolCallHelpers";
import { ProviderLogo } from "./ProviderLogo";
import { providerManager, SupportedProvider } from "@/lib/providers";
import { ProviderModel } from "@/lib/providers/types";
import { MCPJamClient } from "@/mcpjamClient";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

// Helper functions
const createMessage = (
  role: "user" | "assistant",
  content: string,
): Message => ({
  role,
  content,
  timestamp: new Date(),
});

const getAnyApiKey = (): boolean => {
  const providers: SupportedProvider[] = ["anthropic", "openai", "deepseek"];
  return providers.some(provider => providerManager.isProviderReady(provider));
};

const getAvailableProviders = (): SupportedProvider[] => {
  const providers: SupportedProvider[] = [];
  if (providerManager.isProviderReady("anthropic")) providers.push("anthropic");
  if (providerManager.isProviderReady("openai")) providers.push("openai");
  if (providerManager.isProviderReady("deepseek")) providers.push("deepseek");
  return providers;
};

const getProviderDisplayName = (provider: SupportedProvider): string => {
  switch (provider) {
    case "anthropic": return "Claude";
    case "openai": return "OpenAI";
    case "deepseek": return "DeepSeek";
    default: return provider;
  }
};

const getModelsForProvider = (provider: SupportedProvider): ProviderModel[] => {
  try {
    const providerInstance = providerManager.getProvider(provider);
    if (providerInstance) {
      return providerInstance.getSupportedModels();
    }
  } catch (error) {
    console.warn(`Failed to get models for provider ${provider}:`, error);
  }
  return [];
};

const validateSendConditions = (
  input: string,
  mcpClient: unknown,
  hasAnyApiKey: boolean,
  loading: boolean,
) => {
  return {
    isDisabled: loading || !hasAnyApiKey,
    isSendDisabled: loading || !hasAnyApiKey || !input.trim(),
    canSend: input.trim() && mcpClient && hasAnyApiKey && !loading,
  };
};

const handleTextareaResize = (target: HTMLTextAreaElement) => {
  target.style.height = "auto";
  target.style.height = Math.min(target.scrollHeight, 128) + "px";
};

const createSyntheticFormEvent = (
  preventDefault: () => void,
): React.FormEvent => {
  const formEvent = new Event("submit", {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(formEvent, "preventDefault", {
    value: preventDefault,
    writable: false,
  });
  return formEvent as unknown as React.FormEvent;
};

// Loading dots animation component
const LoadingDots: React.FC = () => (
  <div className="flex items-center space-x-1 py-2">
    <div className="flex space-x-1">
      <div className="w-1 h-1 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
      <div className="w-1 h-1 bg-muted-foreground/40 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
      <div className="w-1 h-1 bg-muted-foreground/40 rounded-full animate-bounce"></div>
    </div>
  </div>
);

// Message bubble component
const MessageBubble: React.FC<{ 
  message: Message; 
  selectedProvider: SupportedProvider;
}> = ({ message, selectedProvider }) => {
  const isUser = message.role === "user";
  const parsedContent = parseToolCallContent(message.content);

  return (
    <div
      className={cn(
        "flex gap-3 px-6 py-4",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      {!isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <ProviderLogo
            className="text-slate-600 dark:text-slate-300"
            size={20}
            provider={selectedProvider}
          />
        </div>
      )}

      <div
        className={cn(
          "max-w-[75%] rounded-xl px-4 py-3 break-words",
          isUser
            ? "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900"
            : "bg-slate-50 dark:bg-slate-800/50 text-slate-900 dark:text-slate-100",
        )}
      >
        {/* Regular text content */}
        {parsedContent.text && (
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {parsedContent.text}
          </p>
        )}

        {/* Tool calls */}
        {parsedContent.toolCalls.length > 0 && (
          <div className="mt-3">
            {parsedContent.toolCalls.map((toolCall, index) => (
              <ToolCallMessage key={index} toolCall={toolCall} />
            ))}
          </div>
        )}

        <div
          className={cn(
            "text-xs mt-2 opacity-50",
            isUser
              ? "text-white/60 dark:text-slate-900/60"
              : "text-slate-500 dark:text-slate-400",
          )}
        >
          {message.timestamp.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </div>
      </div>

      {isUser && (
        <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-200 dark:bg-slate-700 flex items-center justify-center">
          <User className="w-3 h-3 text-slate-600 dark:text-slate-300" />
        </div>
      )}
    </div>
  );
};

// Empty state components
const ApiKeyRequiredState: React.FC = () => (
  <div className="flex items-center justify-center h-full p-8">
    <div className="text-center max-w-sm space-y-4">
      <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
        <Key className="w-5 h-5 text-slate-400" />
      </div>
      <div className="space-y-2">
        <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100">
          API Key Required
        </h3>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Configure your API key to start chatting
        </p>
      </div>
    </div>
  </div>
);

const EmptyChatsState: React.FC<{
  onSuggestionClick: (suggestion: string) => void;
  selectedProvider: SupportedProvider;
}> = ({ onSuggestionClick, selectedProvider }) => {
  const suggestions = [
    "Hello! How can you help me?",
    "Help me write some code",
    "Explain a concept to me",
    "Help me with writing",
  ];

  return (
    <div className="flex items-center justify-center h-full p-8">
      <div className="text-center max-w-md space-y-6">
        <div className="w-12 h-12 mx-auto rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
          <ProviderLogo
            className="text-slate-600 dark:text-slate-300"
            size={20}
            provider={selectedProvider}
          />
        </div>
        <div className="space-y-2">
          <h3 className="text-lg font-medium text-slate-900 dark:text-slate-100">
            Start chatting with {getProviderDisplayName(selectedProvider)}
          </h3>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Ask me anything - I'm here to help!
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 pt-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              className="px-4 py-2 text-sm bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

const ChatTab: React.FC = () => {
  const mcpClient = useMcpClient();
  const [input, setInput] = useState("");
  const [chat, setChat] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tools, setTools] = useState<Tool[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<SupportedProvider>("anthropic");
  const [selectedModel, setSelectedModel] = useState<string>("claude-3-5-sonnet-latest");
  const [showProviderSelector, setShowProviderSelector] = useState(false);
  const [showModelSelector, setShowModelSelector] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const providerSelectorRef = useRef<HTMLDivElement>(null);
  const modelSelectorRef = useRef<HTMLDivElement>(null);

  const hasAnyApiKey = getAnyApiKey();
  const availableProviders = getAvailableProviders();
  const availableModels = getModelsForProvider(selectedProvider);
  const { isDisabled, isSendDisabled, canSend } = validateSendConditions(
    input,
    mcpClient,
    hasAnyApiKey,
    loading,
  );

  // Helper functions for component logic
  const fetchTools = async () => {
    if (!mcpClient) return;
    try {
      const response = await mcpClient.listTools();
      setTools(response.tools || []);
    } catch (e: unknown) {
      const errorMessage =
        e instanceof Error ? e.message : "Failed to fetch tools";
      setError(errorMessage);
    }
  };

  const addMessageToChat = (message: Message) => {
    setChat((prev) => [...prev, message]);
  };

  const processUserQuery = async (userMessage: string, signal?: AbortSignal) => {
    if (
      !mcpClient || !(mcpClient instanceof MCPJamClient)
    ) {
      throw new Error(
        "Chat functionality is not available. Please ensure you have a valid API key and the server is connected.",
      );
    }

    await (
      mcpClient as typeof mcpClient & {
        processQuery: (
          query: string,
          tools: Tool[],
          onUpdate?: (content: string) => void,
          model?: string,
          provider?: string,
          signal?: AbortSignal,
        ) => Promise<string>;
      }
    ).processQuery(
      userMessage,
      tools as unknown as MessageTool[],
      (content: string) => {
        const assistantMessage = createMessage("assistant", content);
        addMessageToChat(assistantMessage);
      },
      selectedModel,
      selectedProvider,
      signal,
    );
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!canSend) return;

    const userMessage = input.trim();
    const newMessage = createMessage("user", userMessage);

    addMessageToChat(newMessage);
    setInput("");
    setLoading(true);

    // Create new AbortController for this request
    const controller = new AbortController();
    setAbortController(controller);

    try {
      await processUserQuery(userMessage, controller.signal);
    } catch (e: unknown) {
      const errorMessage =
        e instanceof Error ? e.message : "Error sending message";
      // Don't show error message if the request was cancelled
      if (errorMessage !== "Chat was cancelled") {
        setError(errorMessage);
      }
    } finally {
      setLoading(false);
      setAbortController(null);
    }
  };

  const handleStop = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!isSendDisabled) {
        const formEvent = createSyntheticFormEvent(() => e.preventDefault());
        handleSend(formEvent);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    handleTextareaResize(e.target);
  };

  const handleProviderSelect = (provider: SupportedProvider) => {
    setSelectedProvider(provider);
    setShowProviderSelector(false);
    
    // Update model to first available model for this provider
    const models = getModelsForProvider(provider);
    if (models.length > 0) {
      setSelectedModel(models[0].id);
    }
  };

  const handleModelSelect = (modelId: string) => {
    setSelectedModel(modelId);
    setShowModelSelector(false);
  };

  const toggleProviderSelector = () => {
    setShowProviderSelector(!showProviderSelector);
  };

  const toggleModelSelector = () => {
    setShowModelSelector(!showModelSelector);
  };

  // Initialize with first available provider and model
  useEffect(() => {
    if (availableProviders.length > 0) {
      const firstProvider = availableProviders[0];
      setSelectedProvider(firstProvider);
      
      const models = getModelsForProvider(firstProvider);
      if (models.length > 0) {
        setSelectedModel(models[0].id);
      }
    }
  }, []);

  // Effects
  useEffect(() => {
    let mounted = true;
    const initializeTools = async () => {
      if (mounted) {
        await fetchTools();
      }
    };
    initializeTools();
    return () => {
      mounted = false;
    };
  }, [mcpClient]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chat]);

  useEffect(() => {
    if (hasAnyApiKey && inputRef.current) {
      inputRef.current.focus();
    }
  }, [hasAnyApiKey]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        providerSelectorRef.current &&
        !providerSelectorRef.current.contains(event.target as Node)
      ) {
        setShowProviderSelector(false);
      }
      if (
        modelSelectorRef.current &&
        !modelSelectorRef.current.contains(event.target as Node)
      ) {
        setShowModelSelector(false);
      }
    };

    if (showProviderSelector || showModelSelector) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [showProviderSelector, showModelSelector]);

  // Cleanup effect to abort any ongoing requests when component unmounts
  useEffect(() => {
    return () => {
      if (abortController) {
        abortController.abort();
      }
    };
  }, [abortController]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-slate-200 dark:border-slate-800">
        <div className="px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                <ProviderLogo
                  className="text-slate-600 dark:text-slate-300"
                  size={20}
                  provider={selectedProvider}
                />
              </div>
              <div>
                <h1 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  {getProviderDisplayName(selectedProvider)}
                </h1>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {hasAnyApiKey ? "Ready to help" : "API key required"}
                </p>
              </div>
            </div>

            {hasAnyApiKey && (
              <div className="flex items-center gap-2">
                {/* Provider Selector */}
                <div className="relative" ref={providerSelectorRef}>
                  <button
                    onClick={toggleProviderSelector}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-700"
                    disabled={loading}
                  >
                    <span className="text-slate-700 dark:text-slate-200 font-medium">
                      {getProviderDisplayName(selectedProvider)}
                    </span>
                    <ChevronDown className="w-3 h-3 text-slate-400" />
                  </button>

                  {showProviderSelector && (
                    <div className="absolute right-0 top-full mt-2 w-48 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg z-50">
                      <div className="py-2">
                        {availableProviders.map((provider) => (
                          <button
                            key={provider}
                            onClick={() => handleProviderSelect(provider)}
                            className={cn(
                              "w-full px-4 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors",
                              selectedProvider === provider && "bg-slate-50 dark:bg-slate-800",
                            )}
                          >
                            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                              {getProviderDisplayName(provider)}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Model Selector */}
                <div className="relative" ref={modelSelectorRef}>
                  <button
                    onClick={toggleModelSelector}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-slate-50 dark:bg-slate-800/50 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors border border-slate-200 dark:border-slate-700"
                    disabled={loading}
                  >
                    <span className="text-slate-700 dark:text-slate-200 font-medium">
                      {availableModels.find(m => m.id === selectedModel)?.name || selectedModel}
                    </span>
                    <ChevronDown className="w-3 h-3 text-slate-400" />
                  </button>

                  {showModelSelector && (
                    <div className="absolute right-0 top-full mt-2 w-72 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-lg z-50">
                      <div className="py-2">
                        {availableModels.map((model) => (
                          <button
                            key={model.id}
                            onClick={() => handleModelSelect(model.id)}
                            className={cn(
                              "w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors",
                              selectedModel === model.id && "bg-slate-50 dark:bg-slate-800",
                            )}
                          >
                            <div className="text-sm font-medium text-slate-900 dark:text-slate-100">
                              {model.name}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                              {model.description}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto">
        {!hasAnyApiKey ? (
          <ApiKeyRequiredState />
        ) : chat.length === 0 ? (
          <EmptyChatsState onSuggestionClick={setInput} selectedProvider={selectedProvider} />
        ) : (
          <div className="py-2">
            {chat.map((message, idx) => (
              <MessageBubble key={idx} message={message} selectedProvider={selectedProvider} />
            ))}
            {loading && (
              <div className="flex gap-3 px-6 py-4">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                  <ProviderLogo
                    className="text-slate-600 dark:text-slate-300"
                    size={20}
                    provider={selectedProvider}
                  />
                </div>
                <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl px-4 py-3">
                  <LoadingDots />
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* Error Display */}
      {error && (
        <div className="flex-shrink-0 px-6 py-3 bg-red-50 dark:bg-red-950/50 border-t border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 text-red-700 dark:text-red-300 text-sm">
            <span className="text-xs">⚠️</span>
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Input Form */}
      <div className="flex-shrink-0 border-t border-slate-200 dark:border-slate-800">
        <div className="p-6">
          <form onSubmit={handleSend} className="relative">
            <div className="relative flex items-end gap-3">
              <textarea
                ref={inputRef}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                placeholder={
                  !hasAnyApiKey
                    ? "API key required..."
                    : loading
                      ? `${getProviderDisplayName(selectedProvider)} is thinking...`
                      : `Message ${getProviderDisplayName(selectedProvider)}...`
                }
                disabled={isDisabled}
                rows={1}
                className={cn(
                  "flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none",
                  "focus:outline-none focus:ring-2 focus:ring-slate-400 dark:focus:ring-slate-500 focus:border-transparent",
                  "placeholder:text-slate-400 dark:placeholder:text-slate-500 text-sm",
                  "min-h-[48px] max-h-32 overflow-y-auto",
                  !hasAnyApiKey && "opacity-50 cursor-not-allowed",
                )}
                style={{
                  height: "auto",
                  minHeight: "48px",
                  maxHeight: "128px",
                }}
              />
              {loading ? (
                <button
                  type="button"
                  onClick={handleStop}
                  className={cn(
                    "flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
                    "bg-red-600 hover:bg-red-700 text-white",
                  )}
                >
                  <Square className="w-4 h-4" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isSendDisabled}
                  className={cn(
                    "flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
                    isSendDisabled
                      ? "bg-slate-100 dark:bg-slate-800 text-slate-400 cursor-not-allowed"
                      : "bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:bg-slate-800 dark:hover:bg-slate-200",
                  )}
                >
                  <Send className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Tips */}
            {hasAnyApiKey && !loading && (
              <div className="text-xs text-slate-400 dark:text-slate-500 mt-3 px-1">
                <span className="hidden sm:inline">
                  Press Enter to send • Shift+Enter for new line
                </span>
              </div>
            )}
          </form>
        </div>
      </div>
    </div>
  );
};

export default ChatTab;
