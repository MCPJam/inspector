"use client";

import { useRef, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { MastraMCPServerDefinition } from "@/lib/types";
import { useChat } from "@/hooks/use-chat";
import { Message } from "./chat/message";
import { ChatInput } from "./chat/chat-input";
import { TooltipProvider } from "./ui/tooltip";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";

interface ChatTabProps {
  serverConfigs?: Record<string, MastraMCPServerDefinition>;
  systemPrompt?: string;
}

export function ChatTab({ serverConfigs, systemPrompt = "" }: ChatTabProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

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
    hasValidApiKey,
    setModel,
  } = useChat({
    serverConfigs: serverConfigs,
    systemPrompt,
    onError: (error) => {
      toast.error(error);
    },
  });
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

  const hasServerConfig =
    serverConfigs && Object.keys(serverConfigs).length > 0;

  if (!hasServerConfig) {
    return (
      <div className="flex flex-col h-screen">
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-6 max-w-md px-4">
            <div className="w-20 h-20 mx-auto bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-full flex items-center justify-center">
              <MessageCircle className="h-10 w-10 text-muted-foreground/60" />
            </div>
            <div className="space-y-3">
              <h3 className="text-2xl font-semibold">Connect to get started</h3>
              <p className="text-muted-foreground text-base leading-relaxed">
                Select MCP servers from the sidebar to begin chatting with
                multiple AI assistants.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Empty state - centered input
  if (!hasMessages) {
    return (
      <div className="flex flex-col h-screen">
        <div className="flex-1 flex flex-col items-center justify-center px-4">
          {/* Welcome Message */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center space-y-6 max-w-2xl mb-8"
          >
            <div className="space-y-3">
              <h1 className="text-4xl font-semibold bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
                Let&apos;s test out your MCP servers!
              </h1>
              {serverConfigs && (
                <div className="text-sm text-muted-foreground mt-4">
                  <p>
                    Connected servers: {Object.keys(serverConfigs).join(", ")}
                  </p>
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
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={sendMessage}
              onStop={stopGeneration}
              disabled={!hasServerConfig || !hasValidApiKey}
              isLoading={isLoading}
              placeholder="Send a message..."
              className="border-2 shadow-lg bg-background/80 backdrop-blur-sm"
              currentModel={model}
              availableModels={availableModels}
              onModelChange={setModel}
              onClearChat={clearChat}
              hasMessages={false}
            />
            {!hasValidApiKey && availableModels.length === 0 && (
              <motion.p
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 }}
                className="text-sm text-muted-foreground mt-3 text-center"
              >
                Configure API keys in Settings to start chatting
              </motion.p>
            )}
          </motion.div>
        </div>
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
                    model={model}
                    isLoading={isLoading && index === messages.length - 1}
                    onEdit={() => {}}
                    onRegenerate={regenerateMessage}
                    onCopy={handleCopyMessage}
                    showActions={true}
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
            <ChatInput
              value={input}
              onChange={setInput}
              onSubmit={sendMessage}
              onStop={stopGeneration}
              disabled={!hasServerConfig || !hasValidApiKey}
              isLoading={isLoading}
              placeholder="Send a message..."
              className="border-2 shadow-sm"
              currentModel={model}
              availableModels={availableModels}
              onModelChange={setModel}
              onClearChat={clearChat}
              hasMessages={hasMessages}
            />
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
