import { useRef } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { cn } from "@/lib/chat-utils";
import { Button } from "../ui/button";
import { TextareaAutosize } from "../ui/textarea-autosize";
import { ArrowUp, Square } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ModelSelector } from "./model-selector";
import { ModelDefinition } from "@/shared/types";
import { SystemPromptSelector } from "./system-prompt-selector";
import {
  Context,
  ContextTrigger,
  ContextContent,
  ContextContentHeader,
  ContextContentBody,
  ContextInputUsage,
  ContextOutputUsage,
  ContextMCPServerUsage,
  ContextSystemPromptUsage,
} from "./context";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  stop: () => void;
  disabled?: boolean;
  submitDisabled?: boolean;
  isLoading?: boolean;
  placeholder?: string;
  className?: string;
  currentModel: ModelDefinition;
  availableModels: ModelDefinition[];
  onModelChange: (model: ModelDefinition) => void;
  systemPrompt: string;
  onSystemPromptChange: (prompt: string) => void;
  temperature: number;
  onTemperatureChange: (temperature: number) => void;
  hasMessages?: boolean;
  onResetChat: () => void;
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  selectedServers?: string[];
  mcpToolsTokenCount?: Record<string, number> | null;
  mcpToolsTokenCountLoading?: boolean;
  connectedServerConfigs?: Record<string, { name: string }>;
  systemPromptTokenCount?: number | null;
  systemPromptTokenCountLoading?: boolean;
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  stop,
  disabled = false,
  submitDisabled = false,
  isLoading = false,
  placeholder = "Type your message...",
  className,
  currentModel,
  availableModels,
  onModelChange,
  systemPrompt,
  onSystemPromptChange,
  temperature,
  onTemperatureChange,
  onResetChat,
  hasMessages = false,
  tokenUsage,
  selectedServers,
  mcpToolsTokenCount,
  mcpToolsTokenCountLoading = false,
  connectedServerConfigs,
  systemPromptTokenCount,
  systemPromptTokenCountLoading = false,
}: ChatInputProps) {
  const formRef = useRef<HTMLFormElement>(null);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      const trimmed = value.trim();
      event.preventDefault();
      if (!trimmed || disabled || submitDisabled || isLoading) {
        return;
      }
      formRef.current?.requestSubmit();
    }
  };

  return (
    <form ref={formRef} className={cn("w-full", className)} onSubmit={onSubmit}>
      <div
        className={cn(
          "relative flex w-full flex-col rounded-3xl border border-border/40",
          "bg-muted/70 px-2 pt-2 pb-2",
        )}
      >
        <TextareaAutosize
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={disabled}
          minRows={2}
          className={cn(
            "max-h-32 min-h-[64px] w-full resize-none border-none bg-transparent dark:bg-transparent px-4",
            "pt-2 pb-3 text-base text-foreground placeholder:text-muted-foreground/70",
            "outline-none focus-visible:outline-none focus-visible:ring-0 shadow-none focus-visible:shadow-none",
            disabled ? "cursor-not-allowed text-muted-foreground" : "",
          )}
          autoFocus={!disabled}
        />

        <div className="flex items-center justify-between gap-2 px-2">
          <div className="flex items-center gap-1">
            <ModelSelector
              currentModel={currentModel}
              availableModels={availableModels}
              onModelChange={onModelChange}
              isLoading={isLoading}
              hasMessages={hasMessages}
            />
            <SystemPromptSelector
              systemPrompt={
                systemPrompt ||
                "You are a helpful assistant with access to MCP tools."
              }
              onSystemPromptChange={onSystemPromptChange}
              temperature={temperature}
              onTemperatureChange={onTemperatureChange}
              isLoading={isLoading}
              hasMessages={hasMessages}
              onResetChat={onResetChat}
              currentModel={currentModel}
            />
          </div>

          <div className="flex items-center gap-2">
            <Context
              usedTokens={tokenUsage?.totalTokens ?? 0}
              usage={
                tokenUsage && tokenUsage.totalTokens > 0
                  ? {
                      inputTokens: tokenUsage.inputTokens,
                      outputTokens: tokenUsage.outputTokens,
                      totalTokens: tokenUsage.totalTokens,
                    }
                  : undefined
              }
              modelId={`${currentModel.id}`}
              selectedServers={selectedServers}
              mcpToolsTokenCount={mcpToolsTokenCount}
              mcpToolsTokenCountLoading={mcpToolsTokenCountLoading}
              connectedServerConfigs={connectedServerConfigs}
              systemPromptTokenCount={systemPromptTokenCount}
              systemPromptTokenCountLoading={systemPromptTokenCountLoading}
              hasMessages={hasMessages}
            >
              <ContextTrigger />
              <ContextContent>
                {hasMessages && tokenUsage && tokenUsage.totalTokens > 0 && (
                  <ContextContentHeader />
                )}
                <ContextContentBody>
                  {hasMessages && tokenUsage && tokenUsage.totalTokens > 0 && (
                    <>
                      <ContextInputUsage />
                      <ContextOutputUsage />
                    </>
                  )}
                  <ContextSystemPromptUsage />
                  <ContextMCPServerUsage />
                </ContextContentBody>
              </ContextContent>
            </Context>
            {isLoading ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    className="size-[34px] rounded-full transition-colors bg-red-500 hover:bg-red-600"
                    onClick={() => stop()}
                  >
                    <Square size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Stop generating</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="submit"
                    size="icon"
                    className={cn(
                      "size-[34px] rounded-full transition-colors",
                      value.trim() && !disabled && !submitDisabled
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-muted text-muted-foreground cursor-not-allowed",
                    )}
                    disabled={!value.trim() || disabled || submitDisabled}
                  >
                    <ArrowUp size={16} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Send message</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
