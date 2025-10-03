import { useRef, useEffect, useState, type ReactNode } from "react";
import { MessageCircle, PlusCircle, Settings, Sparkles } from "lucide-react";
import { useChat } from "@/hooks/use-chat";
import { Message } from "./chat/message";
import { ChatInput } from "./chat/chat-input";
import { ElicitationDialog } from "./ElicitationDialog";
import { TooltipProvider } from "./ui/tooltip";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { getDefaultTemperatureForModel } from "@/lib/chat-utils";
import { MastraMCPServerDefinition } from "@mastra/mcp";
import { useConvexAuth } from "convex/react";
import { useAuth } from "@workos-inc/authkit-react";
import type { ServerWithName } from "@/hooks/use-app-state";
import { Button } from "@/components/ui/button";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/logs/PosthogUtils";
import { isMCPJamProvidedModel } from "@/shared/types";
interface ChatTabProps {
  serverConfigs?: Record<string, MastraMCPServerDefinition>;
  connectedServerConfigs?: Record<string, ServerWithName>;
  systemPrompt?: string;
}

export function ChatTab({
  serverConfigs,
  connectedServerConfigs,
  systemPrompt = "",
}: ChatTabProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const { isAuthenticated } = useConvexAuth();
  const { signUp } = useAuth();
  const posthog = usePostHog();
  const [systemPromptState, setSystemPromptState] = useState(
    systemPrompt || "You are a helpful assistant with access to MCP tools.",
  );

  const [temperatureState, setTemperatureState] = useState(1.0);
  const selectedServerNames = Object.keys(serverConfigs || {});
  const selectedConnectedNames = selectedServerNames.filter(
    (name) => connectedServerConfigs?.[name]?.connectionStatus === "connected",
  );
  const noServersConnected = selectedConnectedNames.length === 0;

  const {
    messages,
    isLoading,
    error,
    input,
    setInput,
    sendMessage,
    stopGeneration,
    regenerateMessage,
    clearChat,
    model,
    availableModels,
    setModel,
    elicitationRequest,
    elicitationLoading,
    handleElicitationResponse,
  } = useChat({
    systemPrompt: systemPromptState,
    temperature: temperatureState,
    selectedServers: selectedConnectedNames,
    onError: (error) => {
      toast.error(error);
    },
  });
  const isUsingMcpjamProvidedModel = model
    ? isMCPJamProvidedModel(model.provider)
    : false;
  const showSignInPrompt = isUsingMcpjamProvidedModel && !isAuthenticated;
  const signInPromptMessage = "Sign in to use MCPJam provided models";

  useEffect(() => {
    if (showSignInPrompt) {
      setInput("");
    }
  }, [showSignInPrompt, setInput]);

  // Update temperature when model changes
  useEffect(() => {
    if (model) {
      setTemperatureState(getDefaultTemperatureForModel(model));
    }
  }, [model]);

  const hasMessages = messages.length > 0;
  const isChatDisabled = showSignInPrompt || noServersConnected;
  const disabledMessage = showSignInPrompt
    ? "Sign in to use free chat"
    : "Connect an MCP server to send your first message";
  const quickStartPrompts = [
    {
      label: "Available tools",
      value: "What tools are available?",
      icon: Sparkles,
    },
  ];
  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (isAtBottom && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop =
        messagesContainerRef.current.scrollHeight;
    }
  }, [messages, isAtBottom]);

  // Check if user is at bottom
  const handleScroll = () => {
    if (!messagesContainerRef.current) return;

    const { scrollTop, scrollHeight, clientHeight } =
      messagesContainerRef.current;
    const threshold = 100;
    const atBottom = scrollHeight - scrollTop - clientHeight < threshold;

    setIsAtBottom(atBottom);
  };

  const handleCopyMessage = (content: string) => {
    navigator.clipboard.writeText(content);
  };

  const renderEmptyLayout = (
    content: ReactNode,
    options: { placeholder: string; disabled: boolean },
  ) => (
    <div className="flex flex-col h-screen">
      <div className="flex-1 flex flex-col items-center justify-center px-4">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="w-full max-w-xl space-y-6 text-center"
        >
          {content}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05 }}
          className="w-full max-w-2xl pt-10"
        >
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={() => {
              posthog.capture("send_message", {
                location: "chat_tab",
                platform: detectPlatform(),
                environment: detectEnvironment(),
                model_id: model?.id ?? null,
                model_name: model?.name ?? null,
                model_provider: model?.provider ?? null,
              });
              sendMessage(input);
            }}
            onStop={stopGeneration}
            disabled={availableModels.length === 0 || options.disabled}
            isLoading={isLoading}
            placeholder={options.placeholder}
            className="border shadow-sm"
            currentModel={model || null}
            availableModels={availableModels}
            onModelChange={setModel}
            onClearChat={clearChat}
            hasMessages={false}
            systemPrompt={systemPromptState}
            onSystemPromptChange={setSystemPromptState}
            temperature={temperatureState}
            onTemperatureChange={setTemperatureState}
            isSendBlocked={showSignInPrompt}
          />
          {availableModels.length === 0 && (
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.25 }}
              className="mt-3 text-center text-xs text-muted-foreground"
            >
              Configure API keys in Settings or start Ollama to enable chat
            </motion.p>
          )}
        </motion.div>
      </div>

      {/* Elicitation Dialog */}
      <ElicitationDialog
        elicitationRequest={elicitationRequest}
        onResponse={handleElicitationResponse}
        loading={elicitationLoading}
      />
    </div>
  );

  if (!hasMessages && isChatDisabled) {
    const disabledContent = showSignInPrompt ? (
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium">
            Create an account to use free models
          </h2>
          <p className="text-sm text-muted-foreground">
            or bring your own API key in the settings tab
          </p>
        </div>
        <div className="flex justify-center gap-2">
          <Button
            onClick={() => {
              (posthog.capture("create_account", {
                location: "chat_tab",
                platform: detectPlatform(),
                environment: detectEnvironment(),
              }),
                signUp());
            }}
            style={{ backgroundColor: "#E55A3A" }}
            className="hover:opacity-90 cursor-pointer"
          >
            Create account
          </Button>
        </div>
      </div>
    ) : (
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium">
            You must connect to an MCP server
          </h2>
        </div>
        <div className="flex justify-center gap-2 text-xs text-muted-foreground">
          <a
            href="#servers"
            className="inline-flex items-center gap-1 rounded-full border px-3 py-1 transition hover:bg-muted/30"
          >
            <PlusCircle className="h-3 w-3" /> Add server
          </a>
          <a
            href="#settings"
            className="inline-flex items-center gap-1 rounded-full border px-3 py-1 transition hover:bg-muted/30"
          >
            <Settings className="h-3 w-3" /> Settings
          </a>
        </div>
      </div>
    );

    return renderEmptyLayout(disabledContent, {
      placeholder: disabledMessage,
      disabled: true,
    });
  }

  if (!hasMessages) {
    const suggestionsContent = (
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-medium">Test your servers</h2>
          <p className="text-sm text-muted-foreground">
            Start typing or choose a quick suggestion to begin.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          {quickStartPrompts.map(({ label, value, icon: Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() => setInput(value)}
              className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3 py-1.5 text-xs transition hover:border-border hover:bg-muted/40 cursor-pointer"
            >
              <Icon className="h-3.5 w-3.5 text-muted-foreground" />
              {label}
            </button>
          ))}
        </div>
      </div>
    );

    return renderEmptyLayout(suggestionsContent, {
      placeholder: "Send a message...",
      disabled: false,
    });
  }

  // Active state - messages with bottom input
  return (
    <TooltipProvider>
      <div className="relative bg-background h-screen overflow-hidden">
        {/* Messages Area - Scrollable with bottom padding for input */}
        <div
          ref={messagesContainerRef}
          onScroll={handleScroll}
          className="h-full overflow-y-auto pb-40"
        >
          <div className="max-w-4xl mx-auto px-4 pt-8 pb-8">
            <AnimatePresence mode="popLayout">
              {messages.map((message, index) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: index * 0.05 }}
                  className="mb-8"
                >
                  <Message
                    message={message}
                    model={model || null}
                    isLoading={isLoading && index === messages.length - 1}
                    onEdit={() => {}}
                    onRegenerate={regenerateMessage}
                    onCopy={handleCopyMessage}
                    showActions={true}
                    serverConfigs={serverConfigs}
                  />
                </motion.div>
              ))}
              {/* Thinking indicator */}
              {isLoading &&
                messages.length > 0 &&
                messages[messages.length - 1].role === "user" && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mb-8"
                  >
                    <div className="flex gap-4 items-start">
                      <div className="w-8 h-8 flex items-center rounded-full justify-center bg-muted/50 shrink-0">
                        <MessageCircle className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="flex items-center gap-2 pt-2">
                        <span className="text-sm text-muted-foreground">
                          Thinking
                        </span>
                        <div className="flex space-x-1">
                          <div className="w-1.5 h-1.5 bg-muted-foreground/60 rounded-full animate-bounce" />
                          <div className="w-1.5 h-1.5 bg-muted-foreground/60 rounded-full animate-bounce delay-100" />
                          <div className="w-1.5 h-1.5 bg-muted-foreground/60 rounded-full animate-bounce delay-200" />
                        </div>
                      </div>
                    </div>
                  </motion.div>
                )}
            </AnimatePresence>
          </div>
        </div>

        {/* Error Display - Absolute positioned above input */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="absolute bottom-40 left-0 right-0 px-4 py-3 bg-destructive/5 border-t border-destructive/10 z-10"
            >
              <div className="max-w-4xl mx-auto">
                <p className="text-sm text-destructive">{error}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Fixed Bottom Input - Absolute positioned */}
        <div className="absolute bottom-0 left-0 right-0 border-t border-border/50 bg-background/80 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto p-4">
            <div>
              <ChatInput
                value={input}
                onChange={setInput}
                onSubmit={(message, attachments) => {
                  posthog.capture("send_message", {
                    location: "chat_tab",
                    platform: detectPlatform(),
                    environment: detectEnvironment(),
                    model_id: model?.id ?? null,
                    model_name: model?.name ?? null,
                    model_provider: model?.provider ?? null,
                  });
                  sendMessage(message, attachments);
                }}
                onStop={stopGeneration}
                disabled={
                  availableModels.length === 0 ||
                  noServersConnected ||
                  showSignInPrompt
                }
                isLoading={isLoading}
                placeholder={
                  showSignInPrompt ? signInPromptMessage : "Send a message..."
                }
                className="border-2 shadow-sm"
                currentModel={model}
                availableModels={availableModels}
                onModelChange={setModel}
                onClearChat={clearChat}
                hasMessages={hasMessages}
                systemPrompt={systemPromptState}
                onSystemPromptChange={setSystemPromptState}
                temperature={temperatureState}
                onTemperatureChange={setTemperatureState}
                isSendBlocked={showSignInPrompt}
              />
            </div>
          </div>
        </div>

        {/* Elicitation Dialog */}
        <ElicitationDialog
          elicitationRequest={elicitationRequest}
          onResponse={handleElicitationResponse}
          loading={elicitationLoading}
        />
      </div>
    </TooltipProvider>
  );
}
