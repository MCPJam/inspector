"use client";

import { useRef, useEffect, useState } from "react";
import { MessageCircle } from "lucide-react";
import { MastraMCPServerDefinition } from "@/lib/types";
import { useChat } from "@/hooks/use-chat";
import { Message } from "./message";
import { ChatInput } from "./chat-input";
import { TooltipProvider } from "./ui/tooltip";
import { cn } from "@/lib/chat-utils";
import { motion } from "framer-motion";

interface ChatTabProps {
  serverConfig?: MastraMCPServerDefinition;
  model?: string;
  apiKey?: string;
  systemPrompt?: string;
}

export function ChatTab({
  serverConfig,
  model,
  apiKey,
  systemPrompt,
}: ChatTabProps) {
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
  } = useChat({
    serverConfig,
    model,
    apiKey,
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

  if (!serverConfig || !model || !apiKey) {
    return (
      <div className="flex flex-col min-w-0 h-dvh bg-background">
        <div className="flex items-center justify-center h-full">
          <div className="text-center space-y-3">
            <MessageCircle className="h-12 w-12 mx-auto text-muted-foreground" />
            <div>
              <h3 className="font-medium text-lg">Configuration Required</h3>
              <p className="text-muted-foreground">
                Please select a server, model, and provide an API key to use
                chat functionality
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="flex flex-col min-w-0 h-dvh bg-background">
        {/* Chat Header */}
        <div className="flex items-center justify-between p-4 border-b bg-background">
          <div className="flex items-center gap-2">
            <MessageCircle className="h-5 w-5" />
            <span className="font-medium">Chat</span>
            <span className="text-muted-foreground">
              with {serverConfig.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {messages.length > 0 && (
              <button
                onClick={clearChat}
                className="text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            )}
            <div
              className={cn(
                "w-2 h-2 rounded-full",
                serverConfig ? "bg-green-500" : "bg-red-500",
              )}
            />
          </div>
        </div>

        {/* Messages Container */}
        <div
          ref={messagesContainerRef}
          onScroll={handleScroll}
          className="flex flex-col min-w-0 gap-6 flex-1 overflow-y-scroll pt-4 relative"
        >
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-3 max-w-md">
                <div className="text-4xl">👋</div>
                <div>
                  <h3 className="font-medium text-lg mb-2">
                    Start a conversation
                  </h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    I can help you interact with your MCP server and use its
                    tools. Try asking me to perform tasks or get information!
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
                initial={{ y: 5, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="w-full mx-auto max-w-4xl px-4"
              >
                <div className="flex gap-4">
                  <div className="size-8 flex items-center rounded-full justify-center ring-1 shrink-0 ring-border bg-background">
                    <MessageCircle className="h-4 w-4" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      <span className="text-sm">Thinking...</span>
                      <div className="flex space-x-1">
                        <div className="w-1 h-1 bg-current rounded-full animate-bounce" />
                        <div className="w-1 h-1 bg-current rounded-full animate-bounce delay-100" />
                        <div className="w-1 h-1 bg-current rounded-full animate-bounce delay-200" />
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

          <motion.div className="shrink-0 min-w-[24px] min-h-[24px]" />
        </div>

        {/* Error Display */}
        {error && (
          <div className="mx-4 mb-4 bg-destructive/10 border border-destructive/20 rounded-lg p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Chat Input */}
        <form className="flex mx-auto px-4 bg-background pb-4 md:pb-6 gap-2 w-full md:max-w-3xl">
          <ChatInput
            value={input}
            onChange={setInput}
            onSubmit={sendMessage}
            onStop={stopGeneration}
            disabled={!serverConfig || !model || !apiKey}
            isLoading={isLoading}
            placeholder={`Message ${serverConfig.name}...`}
            showScrollToBottom={showScrollButton}
            onScrollToBottom={scrollToBottom}
          />
        </form>
      </div>
    </TooltipProvider>
  );
}
