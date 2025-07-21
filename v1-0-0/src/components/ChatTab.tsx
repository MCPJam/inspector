"use client";

import { useRef, useEffect, useState } from "react";
import { MessageCircle, ChevronUp } from "lucide-react";
import { MastraMCPServerDefinition } from "@/lib/types";
import { useChat } from "@/hooks/use-chat";
import { Message } from "./chat/message";
import { ChatInput } from "./chat/chat-input";
import { ModelSelector } from "./chat/model-selector";
import { TooltipProvider } from "./ui/tooltip";
import { Button } from "./ui/button";
import { motion } from "framer-motion";

interface ChatTabProps {
  serverConfig?: MastraMCPServerDefinition;
  systemPrompt?: string;
}

export function ChatTab({ serverConfig, systemPrompt = "" }: ChatTabProps) {
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

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
    serverConfig,
    systemPrompt,
    onError: (error) => {
      console.error("Chat error:", error);
    },
  });

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
    setShowScrollButton(!atBottom && messages.length > 0);
  };

  const scrollToBottom = () => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTo({
        top: messagesContainerRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  };

  const handleCopyMessage = (content: string) => {
    navigator.clipboard.writeText(content);
    // You could add a toast notification here
  };

  if (!serverConfig) {
    return (
      <div className="flex flex-col min-w-0 h-dvh">
        <div className="flex items-center justify-center h-full">
          <div className="text-center space-y-4 max-w-sm">
            <div className="w-16 h-16 mx-auto bg-muted/50 rounded-full flex items-center justify-center">
              <MessageCircle className="h-8 w-8 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-medium">No Server Connected</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Connect to an MCP server to start chatting with AI assistants.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col min-w-0 h-dvh">
        {/* Minimal Header */}
        <div className="flex items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 bg-green-500 rounded-full" />
              <span className="text-sm font-medium">{serverConfig.name}</span>
            </div>
          </div>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearChat}
              className="text-xs h-7 px-2 text-muted-foreground hover:text-foreground"
            >
              Clear
            </Button>
          )}
        </div>

        {/* Messages Container */}
        <div
          ref={messagesContainerRef}
          onScroll={handleScroll}
          className="flex flex-col min-w-0 gap-6 flex-1 overflow-y-scroll px-6 relative"
        >
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-4 max-w-md">
                <div className="text-5xl">💬</div>
                <div className="space-y-2">
                  <h3 className="text-xl font-medium">
                    Ready to chat
                  </h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    Ask me anything about your MCP server or request help with tasks.
                    I can use the available tools to assist you.
                  </p>
                </div>
              </div>
            </div>
          )}

          {messages.map((message, index) => (
            <Message
              key={message.id}
              message={message}
              isLoading={isLoading && index === messages.length - 1}
              onEdit={() => {}}
              onRegenerate={regenerateMessage}
              onCopy={handleCopyMessage}
              showActions={true}
            />
          ))}

          {/* Thinking indicator */}
          {isLoading &&
            messages.length > 0 &&
            messages[messages.length - 1].role === "user" && (
              <motion.div
                initial={{ y: 8, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="w-full max-w-4xl mx-auto"
              >
                <div className="flex gap-3">
                  <div className="w-7 h-7 flex items-center rounded-full justify-center bg-muted/50 shrink-0">
                    <MessageCircle className="h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div className="flex items-center gap-2 text-muted-foreground pt-1">
                    <span className="text-sm">Thinking</span>
                    <div className="flex space-x-0.5">
                      <div className="w-1 h-1 bg-current rounded-full animate-bounce" />
                      <div className="w-1 h-1 bg-current rounded-full animate-bounce delay-100" />
                      <div className="w-1 h-1 bg-current rounded-full animate-bounce delay-200" />
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

          <div className="shrink-0 h-4" />
        </div>

        {/* Error Display */}
        {error && (
          <div className="mx-6 mb-4 bg-destructive/5 border border-destructive/10 rounded-lg p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Chat Input */}
        <div className="px-6 pb-6">
          <div className="mx-auto max-w-4xl">
            <div className="flex gap-3 items-end">
              <div className="flex-1">
                <ChatInput
                  value={input}
                  onChange={setInput}
                  onSubmit={sendMessage}
                  onStop={stopGeneration}
                  disabled={!serverConfig || !hasValidApiKey}
                  isLoading={isLoading}
                  placeholder={`Message ${serverConfig.name}...`}
                  showScrollToBottom={showScrollButton}
                  onScrollToBottom={scrollToBottom}
                />
              </div>
              <div className="flex items-center gap-2">
                <ModelSelector
                  currentModel={model}
                  availableModels={availableModels}
                  onModelChange={setModel}
                  disabled={isLoading}
                />
                {showScrollButton && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={scrollToBottom}
                    className="h-7 w-7 p-0"
                  >
                    <ChevronUp className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </div>
            {!hasValidApiKey && availableModels.length === 0 && (
              <p className="text-xs text-muted-foreground mt-2 text-center">
                Configure API keys in Settings to enable chat
              </p>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  );
}
