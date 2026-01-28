import { FormEvent, useMemo, useState, useEffect, useCallback } from "react";
import { ArrowDown } from "lucide-react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { ModelDefinition } from "@/shared/types";
import { LoggerView } from "./logger-view";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { ElicitationDialog } from "@/components/ElicitationDialog";
import type { DialogElicitation } from "@/components/ToolsTab";
import { ChatInput } from "@/components/chat-v2/chat-input";
import { Thread } from "@/components/chat-v2/thread";
import { ServerWithName } from "@/hooks/use-app-state";
import { MCPJamFreeModelsPrompt } from "@/components/chat-v2/mcpjam-free-models-prompt";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import { ErrorBox } from "@/components/chat-v2/error";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { type MCPPromptResult } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import type { SkillResult } from "@/components/chat-v2/chat-input/skills/skill-types";
import {
  STARTER_PROMPTS,
  formatErrorMessage,
  buildMcpPromptMessages,
  buildSkillMessages,
} from "@/components/chat-v2/shared/chat-helpers";
import { useJsonRpcPanelVisibility } from "@/hooks/use-json-rpc-panel";
import { CollapsedPanelStrip } from "@/components/ui/collapsed-panel-strip";
import { useChatSession } from "@/hooks/use-chat-session";
import { addTokenToUrl, authFetch } from "@/lib/session-token";

interface ChatTabProps {
  connectedServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
  onHasMessagesChange?: (hasMessages: boolean) => void;
}

function ScrollToBottomButton() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 flex bottom-12 justify-center animate-in slide-in-from-bottom fade-in duration-200">
      <button
        type="button"
        className="pointer-events-auto inline-flex items-center gap-2 rounded-full border border-border bg-background/90 px-2 py-2 text-xs font-medium shadow-sm transition hover:bg-accent"
        onClick={() => scrollToBottom({ animation: "smooth" })}
      >
        <ArrowDown className="h-4 w-4" />
      </button>
    </div>
  );
}

export function ChatTabV2({
  connectedServerConfigs,
  selectedServerNames,
  onHasMessagesChange,
}: ChatTabProps) {
  const { signUp } = useAuth();
  const { isVisible: isJsonRpcPanelVisible, toggle: toggleJsonRpcPanel } =
    useJsonRpcPanelVisibility();
  const posthog = usePostHog();

  // Local state for ChatTabV2-specific features
  const [input, setInput] = useState("");
  const [mcpPromptResults, setMcpPromptResults] = useState<MCPPromptResult[]>(
    [],
  );
  const [skillResults, setSkillResults] = useState<SkillResult[]>([]);
  const [widgetStateQueue, setWidgetStateQueue] = useState<
    { toolCallId: string; state: unknown }[]
  >([]);
  const [modelContextQueue, setModelContextQueue] = useState<
    {
      toolCallId: string;
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      };
    }[]
  >([]);
  const [elicitation, setElicitation] = useState<DialogElicitation | null>(
    null,
  );
  const [elicitationLoading, setElicitationLoading] = useState(false);
  const [isWidgetFullscreen, setIsWidgetFullscreen] = useState(false);

  // Filter to only connected servers
  const selectedConnectedServerNames = useMemo(
    () =>
      selectedServerNames.filter(
        (name) =>
          connectedServerConfigs[name]?.connectionStatus === "connected",
      ),
    [selectedServerNames, connectedServerConfigs],
  );

  // Use shared chat session hook
  const {
    messages,
    setMessages,
    sendMessage,
    stop,
    status,
    error,
    selectedModel,
    setSelectedModel,
    availableModels,
    isMcpJamModel,
    isAuthenticated,
    isAuthLoading,
    systemPrompt,
    setSystemPrompt,
    temperature,
    setTemperature,
    toolsMetadata,
    toolServerMap,
    tokenUsage,
    mcpToolsTokenCount,
    mcpToolsTokenCountLoading,
    systemPromptTokenCount,
    systemPromptTokenCountLoading,
    resetChat: baseResetChat,
    isStreaming,
    disableForAuthentication,
    submitBlocked: baseSubmitBlocked,
  } = useChatSession({
    selectedServers: selectedConnectedServerNames,
    onReset: () => {
      setInput("");
      setWidgetStateQueue([]);
    },
  });

  // Check if thread is empty
  const isThreadEmpty = !messages.some(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );

  // Server instructions
  const selectedServerInstructions = useMemo(() => {
    const instructions: Record<string, string> = {};
    for (const serverName of selectedServerNames) {
      const server = connectedServerConfigs[serverName];
      const instruction = server?.initializationInfo?.instructions;
      if (instruction) {
        instructions[serverName] = instruction;
      }
    }
    return instructions;
  }, [connectedServerConfigs, selectedServerNames]);

  // Keep server instruction system messages in sync with selected servers
  useEffect(() => {
    setMessages((prev) => {
      const filtered = prev.filter(
        (msg) =>
          !(
            msg.role === "system" &&
            (msg as { metadata?: { source?: string } })?.metadata?.source ===
              "server-instruction"
          ),
      );

      const instructionMessages = Object.entries(selectedServerInstructions)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([serverName, instruction]) => ({
          id: `server-instruction-${serverName}`,
          role: "system" as const,
          parts: [
            {
              type: "text" as const,
              text: `Server ${serverName} instructions: ${instruction}`,
            },
          ],
          metadata: { source: "server-instruction", serverName },
        }));

      return [...instructionMessages, ...filtered];
    });
  }, [selectedServerInstructions, setMessages]);

  // PostHog tracking
  useEffect(() => {
    posthog.capture("chat_tab_viewed", {
      location: "chat_tab",
      platform: detectPlatform(),
      environment: detectEnvironment(),
    });
  }, [posthog]);

  // Notify parent when messages change
  useEffect(() => {
    onHasMessagesChange?.(!isThreadEmpty);
  }, [isThreadEmpty, onHasMessagesChange]);

  // Widget state management
  const applyWidgetStateUpdates = useCallback(
    (
      prevMessages: typeof messages,
      updates: { toolCallId: string; state: unknown }[],
    ) => {
      let nextMessages = prevMessages;

      for (const { toolCallId, state } of updates) {
        const messageId = `widget-state-${toolCallId}`;

        if (state === null) {
          const filtered = nextMessages.filter((msg) => msg.id !== messageId);
          nextMessages = filtered;
          continue;
        }

        const stateText = `The state of widget ${toolCallId} is: ${JSON.stringify(state)}`;
        const existingIndex = nextMessages.findIndex(
          (msg) => msg.id === messageId,
        );

        if (existingIndex !== -1) {
          const existingMessage = nextMessages[existingIndex];
          const existingText =
            existingMessage.parts?.[0]?.type === "text"
              ? (existingMessage.parts[0] as { text?: string }).text
              : null;

          if (existingText === stateText) {
            continue;
          }

          const updatedMessages = [...nextMessages];
          updatedMessages[existingIndex] = {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text" as const, text: stateText }],
          };
          nextMessages = updatedMessages;
          continue;
        }

        nextMessages = [
          ...nextMessages,
          {
            id: messageId,
            role: "assistant",
            parts: [{ type: "text" as const, text: stateText }],
          },
        ];
      }

      return nextMessages;
    },
    [],
  );

  const handleWidgetStateChange = useCallback(
    (toolCallId: string, state: unknown) => {
      if (status === "ready") {
        setMessages((prevMessages) =>
          applyWidgetStateUpdates(prevMessages, [{ toolCallId, state }]),
        );
      } else {
        setWidgetStateQueue((prev) => [...prev, { toolCallId, state }]);
      }
    },
    [status, setMessages, applyWidgetStateUpdates],
  );

  useEffect(() => {
    if (status !== "ready" || widgetStateQueue.length === 0) return;

    setMessages((prevMessages) =>
      applyWidgetStateUpdates(prevMessages, widgetStateQueue),
    );
    setWidgetStateQueue([]);
  }, [status, widgetStateQueue, setMessages, applyWidgetStateUpdates]);

  const handleModelContextUpdate = useCallback(
    (
      toolCallId: string,
      context: {
        content?: ContentBlock[];
        structuredContent?: Record<string, unknown>;
      },
    ) => {
      // Queue model context to be included in next message
      setModelContextQueue((prev) => {
        // Remove any existing context from same widget (overwrite pattern per SEP-1865)
        const filtered = prev.filter((item) => item.toolCallId !== toolCallId);
        return [...filtered, { toolCallId, context }];
      });
    },
    [],
  );

  // Elicitation SSE listener
  useEffect(() => {
    const es = new EventSource(addTokenToUrl("/api/mcp/elicitation/stream"));
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
    parameters?: Record<string, unknown>,
  ) => {
    if (!elicitation) return;
    setElicitationLoading(true);
    try {
      await authFetch("/api/mcp/elicitation/respond", {
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

  // Submit blocking with server check
  const submitBlocked = baseSubmitBlocked;
  const inputDisabled = status !== "ready" || submitBlocked;

  let placeholder =
    'Ask something… Use Slash "/" commands for Skills & MCP prompts';
  if (isAuthLoading) {
    placeholder = "Loading...";
  } else if (disableForAuthentication) {
    placeholder = "Sign in to use free chat";
  }

  const shouldShowUpsell = disableForAuthentication && !isAuthLoading;
  const showDisabledCallout = isThreadEmpty && shouldShowUpsell;

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
    const hasResults = mcpPromptResults.length > 0 || skillResults.length > 0;
    if ((input.trim() || hasResults) && status === "ready" && !submitBlocked) {
      posthog.capture("send_message", {
        location: "chat_tab",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        model_id: selectedModel?.id ?? null,
        model_name: selectedModel?.name ?? null,
        model_provider: selectedModel?.provider ?? null,
      });

      // Build messages from MCP prompts
      const promptMessages = buildMcpPromptMessages(mcpPromptResults);
      if (promptMessages.length > 0) {
        setMessages((prev) => [...prev, ...promptMessages]);
      }

      // Build messages from skills
      const skillMessages = buildSkillMessages(skillResults);
      if (skillMessages.length > 0) {
        setMessages((prev) => [...prev, ...skillMessages]);
      }

      // Include any pending model context from widgets (SEP-1865 ui/update-model-context)
      // Sent as "user" messages for compatibility with model provider APIs
      const contextMessages = modelContextQueue.map(
        ({ toolCallId, context }) => ({
          id: `model-context-${toolCallId}-${Date.now()}`,
          role: "user" as const,
          parts: [
            {
              type: "text" as const,
              text: `Widget ${toolCallId} context: ${JSON.stringify(context)}`,
            },
          ],
          metadata: {
            source: "widget-model-context",
            toolCallId,
          },
        }),
      );

      if (contextMessages.length > 0) {
        setMessages((prev) => [...prev, ...contextMessages]);
      }

      sendMessage({ text: input });
      setInput("");
      setMcpPromptResults([]);
      setSkillResults([]);
      setModelContextQueue([]); // Clear after sending
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
      setSelectedModel(model);
      baseResetChat();
    },
    systemPrompt,
    onSystemPromptChange: setSystemPrompt,
    temperature,
    onTemperatureChange: setTemperature,
    onResetChat: baseResetChat,
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
    skillResults,
    onChangeSkillResults: setSkillResults,
  };

  const showStarterPrompts =
    !showDisabledCallout && isThreadEmpty && !isAuthLoading;

  return (
    <div className="flex flex-1 h-full min-h-0 flex-col overflow-hidden">
      <ResizablePanelGroup
        direction="horizontal"
        className="flex-1 min-h-0 h-full"
      >
        <ResizablePanel
          defaultSize={isJsonRpcPanelVisible ? 70 : 100}
          minSize={40}
          className="min-w-0"
        >
          <div
            className="flex flex-col bg-background h-full min-h-0 overflow-hidden"
            style={{
              transform: isWidgetFullscreen ? "none" : "translateZ(0)",
            }}
          >
            {isThreadEmpty ? (
              <div className="flex-1 flex items-center justify-center overflow-y-auto px-4">
                <div className="w-full max-w-3xl space-y-6 py-8">
                  {isAuthLoading ? (
                    <div className="text-center space-y-4">
                      <div className="mx-auto h-8 w-8 animate-spin rounded-full border-b-2 border-primary" />
                      <p className="text-sm text-muted-foreground">
                        Loading...
                      </p>
                    </div>
                  ) : showDisabledCallout ? (
                    <div className="space-y-4">
                      <MCPJamFreeModelsPrompt onSignUp={handleSignUp} />
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
              <StickToBottom
                className="relative flex flex-1 flex-col min-h-0 animate-in fade-in duration-300"
                resize="smooth"
                initial="smooth"
              >
                <div className="relative flex-1 min-h-0">
                  <StickToBottom.Content className="flex flex-col min-h-0">
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
                      onModelContextUpdate={handleModelContextUpdate}
                      onFullscreenChange={setIsWidgetFullscreen}
                      enableFullscreenChatOverlay
                      fullscreenChatPlaceholder={placeholder}
                      fullscreenChatDisabled={inputDisabled}
                    />
                    {errorMessage && (
                      <div className="px-4 pb-4 pt-4">
                        <ErrorBox
                          message={errorMessage.message}
                          errorDetails={errorMessage.details}
                          onResetChat={baseResetChat}
                        />
                      </div>
                    )}
                  </StickToBottom.Content>
                  <ScrollToBottomButton />
                </div>

                <div className="bg-background/80 backdrop-blur-sm border-t border-border flex-shrink-0">
                  <div className="max-w-4xl mx-auto p-4">
                    <ChatInput {...sharedChatInputProps} hasMessages />
                  </div>
                </div>
              </StickToBottom>
            )}

            <ElicitationDialog
              elicitationRequest={elicitation}
              onResponse={handleElicitationResponse}
              loading={elicitationLoading}
            />
          </div>
        </ResizablePanel>

        {isJsonRpcPanelVisible ? (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={30}
              minSize={20}
              maxSize={50}
              className="min-w-[260px] min-h-0 overflow-hidden"
            >
              <div className="h-full min-h-0 overflow-hidden">
                <LoggerView onClose={toggleJsonRpcPanel} />
              </div>
            </ResizablePanel>
          </>
        ) : (
          <CollapsedPanelStrip onOpen={toggleJsonRpcPanel} />
        )}
      </ResizablePanelGroup>
    </div>
  );
}
