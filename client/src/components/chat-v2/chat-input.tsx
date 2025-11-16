import { useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, ChangeEvent } from "react";
import { cn } from "@/lib/chat-utils";
import { Button } from "../ui/button";
import { TextareaAutosize } from "../ui/textarea-autosize";
import { ArrowUp, Square, X } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { ModelSelector } from "./model-selector";
import { ModelDefinition } from "@/shared/types";
import { SystemPromptSelector } from "./system-prompt-selector";
import { useTextareaCaretPosition } from "@/hooks/use-textarea-caret-position";
import { PromptsPopover } from "./prompts-popover";
import type { NamespacedPrompt } from "@/components/ChatTabV2";
import type { PromptContentResponse } from "@/lib/mcp-prompts-api";
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
  prompts: NamespacedPrompt[];
  onSelectMCPPrompt: (promptNamespacedName: string) => Promise<void>;
  promptResults: Record<string, PromptContentResponse>;
  onRemovePromptResult: (promptNamespacedName: string) => void;
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
  prompts,
  promptResults,
  onSelectMCPPrompt,
  onRemovePromptResult,
  tokenUsage,
  selectedServers,
  mcpToolsTokenCount,
  mcpToolsTokenCountLoading = false,
  connectedServerConfigs,
  systemPromptTokenCount,
  systemPromptTokenCountLoading = false,
}: ChatInputProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Prompts popover state
  const [isPromptsOpen, setIsPromptsOpen] = useState(false);
  const [caretIndex, setCaretIndex] = useState(0);
  const [highlightedPromptIndex, setHighlightedPromptIndex] = useState(-1);
  const [isHoveringPrompt, setIsHoveringPrompt] = useState(false);

  const caret = useTextareaCaretPosition(
    textareaRef,
    containerRef,
    value,
    caretIndex,
  );

  const isPromptsRequested = (
    currentValue: string,
    currentCaretIndex: number,
  ) => {
    // Check text up to caret position for " /" or "/" at start of line or textarea
    const textUpToCaret = currentValue.slice(0, currentCaretIndex);
    const matches = /(?:^\/$|\s+\/$)/.test(textUpToCaret);
    return matches;
  };

  const handlePromptsRequest = (
    currentValue: string,
    currentCaretIndex: number = 0,
  ) => {
    const isRequestingPrompts = isPromptsRequested(
      currentValue,
      currentCaretIndex,
    );
    setCaretIndex(currentCaretIndex);
    setIsPromptsOpen(isRequestingPrompts);
  };

  const handlePromptArrowKeyNavigation = (
    direction: "ArrowUp" | "ArrowDown",
  ) => {
    if (direction === "ArrowDown") {
      setHighlightedPromptIndex((prev) => (prev + 1) % prompts.length);
    } else {
      setHighlightedPromptIndex(
        (prev) => (prev - 1 + prompts.length) % prompts.length,
      );
    }
  };

  const handleSelectPrompt = async (promptNamespacedName: string) => {
    try {
      await onSelectMCPPrompt(promptNamespacedName);

      // Remove the "/" that triggered the popover
      const textBeforeCaret = value.slice(0, caretIndex);
      const textAfterCaret = value.slice(caretIndex);
      const cleanedBefore = textBeforeCaret.replace(/\/\s*$/, "");
      const newValue = cleanedBefore + textAfterCaret;
      onChange(newValue);

      // Clear popover state
      setIsPromptsOpen(false);
      setHighlightedPromptIndex(-1);
    } catch (error) {
      // Keep popover open on error so user can try again
      console.error("[ChatInput] Failed to select prompt:", error);
    }
  };

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const newValue = event.target.value;
    handlePromptsRequest(newValue, event.target.selectionStart);
    onChange(newValue);
  }

  const handleKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    handlePromptsRequest(value, event.currentTarget.selectionStart);
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !isPromptsOpen
    ) {
      const trimmed = value.trim();
      event.preventDefault();
      if (!trimmed || disabled || submitDisabled || isLoading) {
        return;
      }
      formRef.current?.requestSubmit();
    }

    // Prompt events
    if (event.key === "Escape" && isPromptsOpen) {
      event.preventDefault();
      setIsPromptsOpen(false);
    }

    if (event.key === "Enter" && isPromptsOpen) {
      event.preventDefault();
      if (highlightedPromptIndex === -1) {
        return;
      }
      const highlightedPromptNamespacedName =
        prompts[highlightedPromptIndex].namespacedName;
      await handleSelectPrompt(highlightedPromptNamespacedName);
    }

    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      isPromptsOpen
    ) {
      event.preventDefault();
      setIsHoveringPrompt(false);
      handlePromptArrowKeyNavigation(event.key);
    }
  };

  return (
    <div className="relative">
      <form
        ref={formRef}
        className={cn("w-full", className)}
        onSubmit={onSubmit}
      >
        <div
          ref={containerRef}
          className={cn(
            "relative flex w-full flex-col rounded-3xl border border-border/40",
            "bg-muted/70 px-2 pt-2 pb-2",
          )}
        >
          <PromptsPopover
            anchor={caret}
            open={isPromptsOpen}
            setOpen={setIsPromptsOpen}
            highlightedIndex={highlightedPromptIndex}
            setHighlightedIndex={setHighlightedPromptIndex}
            isHovering={isHoveringPrompt}
            setIsHovering={setIsHoveringPrompt}
            prompts={prompts}
            onPromptClick={handleSelectPrompt}
          />

          {/* Prompt Response Cards */}
          {Object.keys(promptResults).length > 0 && (
            <div className="px-4 pt-1 pb-0.5">
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(promptResults).map(
                  ([namespacedName, result]) => (
                    <div
                      key={namespacedName}
                      className="group inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/50 px-2 py-0.5 text-xs"
                    >
                      <span className="font-medium text-foreground truncate max-w-[180px]">
                        {namespacedName}
                      </span>
                      {result.messages.length > 0 && (
                        <span className="text-[10px] text-muted-foreground">
                          ({result.messages.length})
                        </span>
                      )}
                      {onRemovePromptResult && (
                        <button
                          type="button"
                          onClick={() => onRemovePromptResult(namespacedName)}
                          className="flex-shrink-0 rounded-sm opacity-60 hover:opacity-100 transition-opacity hover:bg-accent p-0.5"
                          aria-label={`Remove ${namespacedName}`}
                        >
                          <X size={12} className="text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}

          <TextareaAutosize
            ref={textareaRef}
            value={value}
            onChange={(e) => handleChange(e)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            readOnly={disabled}
            minRows={2}
            className={cn(
              "max-h-32 min-h-[64px] w-full resize-none border-none bg-transparent px-4",
              "pt-2 pb-3 text-base text-foreground placeholder:text-muted-foreground/70",
              "outline-none focus-visible:outline-none focus-visible:ring-0 shadow-none focus-visible:shadow-none",
              disabled ? "cursor-not-allowed text-muted-foreground" : "",
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

            <div className="flex items-center">
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
    </div>
  );
}
