import { useRef, useEffect, useState } from "react";
import {
  MessageCircle,
  Plug,
  PlusCircle,
  Settings,
  Sparkles,
} from "lucide-react";
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
import type { ServerWithName } from "@/hooks/use-app-state";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";

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
  const themeMode = usePreferencesStore((s) => s.themeMode);

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

  const isUsingMcpjamProvidedModel = model?.provider === "meta";
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

  // Empty state - centered input
  if (!hasMessages) {
    return (
      <div className="flex flex-col h-screen">
        <div className="flex-1 flex flex-col items-center justify-center px-4 relative">
          {/* Decorative Background */}
          <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_center,rgba(2,6,23,0.06),transparent_60%)]" />
          {/* Welcome Message */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center space-y-6 max-w-2xl mb-8"
          >
            <div className="space-y-3">
              <div className="flex items-center justify-center">
                <img
                  src={
                    themeMode === "dark"
                      ? "/mcp_jam_dark.png"
                      : "/mcp_jam_light.png"
                  }
                  alt="MCPJam logo"
                  className="h-12 w-auto mx-auto"
                />
              </div>
              {/* Quick actions */}
              <div className="flex items-center justify-center gap-2 pt-2">
                <a
                  href="#servers"
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs hover:bg-accent"
                >
                  <PlusCircle className="h-3 w-3" /> Add server
                </a>
                <a
                  href="#settings"
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs hover:bg-accent"
                >
                  <Settings className="h-3 w-3" /> Settings
                </a>
                <button
                  type="button"
                  onClick={() => setInput("What tools are available?")}
                  className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs hover:bg-accent"
                >
                  <Sparkles className="h-3 w-3" /> Try a prompt
                </button>
              </div>
              {noServersConnected ? (
                <div className="text-sm text-muted-foreground mt-4">
                  <p className="text-xs">
                    You must be connected to at least 1 MCP server to get
                    started.
                  </p>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground mt-4 flex flex-col items-center gap-2">
                  <p className="text-xs">Selected servers:</p>
                  {selectedServerNames.length === 0 ? (
                    <p className="text-xs">None</p>
                  ) : (
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {(selectedConnectedNames.length > 0
                        ? selectedConnectedNames
                        : selectedServerNames
                      ).map((name) => (
                        <span
                          key={name}
                          className="inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs bg-background/60"
                        >
                          <Plug className="h-3 w-3" /> {name}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </motion.div>

          {/* Centered Input */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.1 }}
            className="w-full max-w-3xl"
          >
            <div>
              <ChatInput
                value={input}
                onChange={setInput}
                onSubmit={sendMessage}
                onStop={stopGeneration}
                disabled={availableModels.length === 0 || noServersConnected}
                isLoading={isLoading}
                placeholder={
                  showSignInPrompt ? signInPromptMessage : "Send a message..."
                }
                className="border-2 shadow-lg bg-background/80 backdrop-blur-sm"
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
            </div>
            {/* System prompt editor shown inline above input */}
            {availableModels.length === 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-sm text-muted-foreground mt-3 text-center"
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
                onSubmit={sendMessage}
                onStop={stopGeneration}
                disabled={availableModels.length === 0 || noServersConnected}
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
