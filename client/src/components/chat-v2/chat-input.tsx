import { useRef, useState, useCallback } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { cn } from "@/lib/chat-utils";
import { Button } from "@/components/ui/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { PromptsPopover } from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import { ArrowUp, Square } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ModelSelector } from "@/components/chat-v2/chat-input/model-selector";
import { ModelDefinition } from "@/shared/types";
import { SystemPromptSelector } from "@/components/chat-v2/chat-input/system-prompt-selector";
import { useTextareaCaretPosition } from "@/hooks/use-textarea-caret-position";
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
} from "@/components/chat-v2/chat-input/context";
import {
  type MCPPromptResult,
  isMCPPromptsRequested,
} from "@/components/chat-v2/chat-input/prompts/mcp-prompts-popover";
import { MCPPromptResultCard } from "@/components/chat-v2/chat-input/prompts/mcp-prompt-result-card";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (
    event: FormEvent<HTMLFormElement>,
    additionalInput?: string,
  ) => void;
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
  mcpPromptResults: MCPPromptResult[];
  onChangeMcpPromptResults: (mcpPromptResults: MCPPromptResult[]) => void;
  /** When true, shows icons only for a more compact layout */
  compact?: boolean;
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
  mcpPromptResults,
  onChangeMcpPromptResults,
  compact = false,
}: ChatInputProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [caretIndex, setCaretIndex] = useState(0);
  const [mcpPromptPopoverKeyTrigger, setMcpPromptPopoverKeyTrigger] = useState<
    string | null
  >(null);

  const caret = useTextareaCaretPosition(
    textareaRef,
    containerRef,
    value,
    caretIndex,
  );

  const onMCPPromptSelected = useCallback(
    (mcpPromptResult: MCPPromptResult) => {
      // Add the prompt result to the mcpPromptResults state
      onChangeMcpPromptResults([...mcpPromptResults, mcpPromptResult]);

      // Remove the "/" that triggered the popover
      const textBeforeCaret = value.slice(0, caretIndex);
      const textAfterCaret = value.slice(caretIndex);
      const cleanedBefore = textBeforeCaret.replace(/\/\s*$/, "");
      const newValue = cleanedBefore + textAfterCaret;
      onChange(newValue);
    },
    [value, caretIndex, onChange, mcpPromptResults, onChangeMcpPromptResults],
  );

  const removeMCPPromptResult = (index: number) => {
    onChangeMcpPromptResults(mcpPromptResults.filter((_, i) => i !== index));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const currentCaretIndex = event.currentTarget.selectionStart;
    if (
      isMCPPromptsRequested(value, currentCaretIndex) &&
      ["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      setMcpPromptPopoverKeyTrigger(event.key);
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      const trimmed = value.trim();
      event.preventDefault();
      if (
        (!trimmed && mcpPromptResults.length === 0) ||
        disabled ||
        submitDisabled ||
        isLoading
      ) {
        return;
      }
      formRef.current?.requestSubmit();
    }
  };

  const renderMcpPromptResultCards = () => {
    if (mcpPromptResults.length === 0) return null;
    return (
      <div className="px-4 pt-1 pb-0.5">
        <div className="flex flex-wrap gap-1.5">
          {mcpPromptResults.map((mcpPromptResult, index) => (
            <MCPPromptResultCard
              key={index}
              mcpPromptResult={mcpPromptResult}
              onRemove={() => removeMCPPromptResult(index)}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <form ref={formRef} className={cn("w-full", className)} onSubmit={onSubmit}>
      <div
        ref={containerRef}
        className={cn(
          "relative flex w-full flex-col rounded-3xl border border-border/40",
          "bg-muted/70 px-2 pt-2 pb-2",
        )}
      >
        <PromptsPopover
          anchor={caret}
          selectedServers={selectedServers}
          onPromptSelected={onMCPPromptSelected}
          actionTrigger={mcpPromptPopoverKeyTrigger}
          setActionTrigger={setMcpPromptPopoverKeyTrigger}
          value={value}
          caretIndex={caretIndex}
        />

        {/* MCP Prompts Cards */}
        {renderMcpPromptResultCards()}

        <TextareaAutosize
          ref={textareaRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setCaretIndex(e.target.selectionStart);
          }}
          onKeyDown={handleKeyDown}
          onKeyUp={(e) => setCaretIndex(e.currentTarget.selectionStart)}
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

        <div className="flex items-center justify-between gap-2 px-2 flex-wrap min-w-0">
          <div className="flex items-center gap-1 min-w-0 flex-shrink overflow-hidden">
            <ModelSelector
              currentModel={currentModel}
              availableModels={availableModels}
              onModelChange={onModelChange}
              isLoading={isLoading}
              hasMessages={hasMessages}
              compact={compact}
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
              compact={compact}
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
              {/* Only render popover content when there's something to show */}
              {(hasMessages && tokenUsage && tokenUsage.totalTokens > 0) ||
              (systemPromptTokenCount && systemPromptTokenCount > 0) ||
              systemPromptTokenCountLoading ||
              (mcpToolsTokenCount &&
                Object.keys(mcpToolsTokenCount).length > 0) ||
              mcpToolsTokenCountLoading ? (
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
              ) : null}
            </Context>
            {isLoading ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="destructive"
                    className="size-[34px] rounded-full transition-colors bg-destructive text-destructive-foreground hover:bg-destructive/90"
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
                      (value.trim() || mcpPromptResults.length > 0) &&
                        !disabled &&
                        !submitDisabled
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "bg-muted text-muted-foreground cursor-not-allowed",
                    )}
                    disabled={
                      (!value.trim() && mcpPromptResults.length === 0) ||
                      disabled ||
                      submitDisabled
                    }
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
