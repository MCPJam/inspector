import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import type { UIMessage } from "@ai-sdk/react";
import { ArrowUp, ChevronDown, ChevronUp, Square } from "lucide-react";

import {
  useSandboxHostStyle,
  useSandboxHostTheme,
} from "@/contexts/sandbox-host-style-context";
import { CHATGPT_CHAT_BACKGROUND } from "@/config/chatgpt-host-context";
import { CLAUDE_DESKTOP_CHAT_BACKGROUND } from "@/config/claude-desktop-host-context";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import {
  LoadingIndicatorContent,
  type LoadingIndicatorVariant,
  useResolvedLoadingIndicatorVariant,
} from "@/components/chat-v2/shared/loading-indicator-content";
import { ClaudeLoadingIndicator } from "@/components/chat-v2/shared/claude-loading-indicator";
import { getRenderableConversationMessages } from "@/components/chat-v2/thread/thread-helpers";

function getMessagePreviewText(message: UIMessage): string {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const texts = parts
    .map((part: any) => {
      if (!part || typeof part !== "object") return "";
      if (part.type === "text" && typeof part.text === "string")
        return part.text;
      if ("text" in part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean);

  if (texts.length > 0) return texts.join("\n").trim();
  if (typeof (message as any)?.content === "string")
    return ((message as any).content as string).trim();
  return "";
}

function getFullscreenChatAppearance(
  sandboxHostStyle: "claude" | "chatgpt" | null,
  isDarkSandboxTheme: boolean,
) {
  return {
    composerClassName:
      sandboxHostStyle === "chatgpt"
        ? cn(
            "sandbox-host-composer rounded-[1.75rem]",
            isDarkSandboxTheme
              ? "border border-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]"
              : "border border-neutral-200/90 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]",
          )
        : sandboxHostStyle === "claude"
          ? cn(
              "sandbox-host-composer rounded-[1.35rem]",
              isDarkSandboxTheme
                ? "border-[#4b463d] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]"
                : "border border-[#DFDFDB] shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]",
            )
          : "rounded-full border border-border/40 bg-background/95 backdrop-blur-xl",
    activeSubmitButtonClassName:
      sandboxHostStyle === "chatgpt"
        ? isDarkSandboxTheme
          ? "bg-[#f4f4f4] text-[#1f1f1f] hover:bg-[#e8e8e8]"
          : "bg-[#1f1f1f] text-white hover:bg-[#303030]"
        : sandboxHostStyle === "claude"
          ? isDarkSandboxTheme
            ? "bg-[#d07b53] text-[#fff7f0] hover:bg-[#c06f49]"
            : "bg-[#e27d47] text-white hover:bg-[#d16f3d]"
          : "bg-primary text-primary-foreground hover:bg-primary/90",
    inactiveSubmitButtonClassName:
      sandboxHostStyle === "chatgpt"
        ? isDarkSandboxTheme
          ? "bg-[#3a3a3a] text-[#8a8a8a] cursor-not-allowed"
          : "bg-[#e7e7e7] text-[#9b9b9b] cursor-not-allowed"
        : sandboxHostStyle === "claude"
          ? isDarkSandboxTheme
            ? "bg-[#45413b] text-[#8d857a] cursor-not-allowed"
            : "bg-[#ebe5dc] text-[#b6ada0] cursor-not-allowed"
          : "bg-muted text-muted-foreground cursor-not-allowed",
  };
}

function getFullscreenSurfaceStyle(
  sandboxHostStyle: "claude" | "chatgpt" | null,
  resolvedThemeMode: "light" | "dark",
): CSSProperties | undefined {
  if (sandboxHostStyle === "chatgpt") {
    return { backgroundColor: CHATGPT_CHAT_BACKGROUND[resolvedThemeMode] };
  }

  if (sandboxHostStyle === "claude") {
    return {
      backgroundColor: CLAUDE_DESKTOP_CHAT_BACKGROUND[resolvedThemeMode],
    };
  }

  return undefined;
}

function MessageBubble({
  text,
  isUser,
  claudeFooterMode = "none",
}: {
  text: string;
  isUser: boolean;
  claudeFooterMode?: "none" | "animated" | "static";
}) {
  const showClaudeFooter = !isUser && claudeFooterMode !== "none";

  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div className={cn("max-w-[85%]", showClaudeFooter && "space-y-3")}>
        <div
          className={cn(
            "rounded-2xl px-3 py-2 text-sm leading-6 whitespace-pre-wrap",
            isUser
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground",
          )}
        >
          {text}
        </div>
        {showClaudeFooter ? (
          <div
            data-testid={`fullscreen-claude-footer-${claudeFooterMode}`}
            className="pl-1"
          >
            <ClaudeLoadingIndicator mode={claudeFooterMode} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThinkingRow({
  resolvedVariant,
}: {
  resolvedVariant?: LoadingIndicatorVariant;
}) {
  const shouldRenderDefaultBubble =
    resolvedVariant !== "claude-mark" && resolvedVariant !== "chatgpt-dot";

  return (
    <div
      data-testid="fullscreen-thinking-row"
      className="flex w-full justify-start"
    >
      {shouldRenderDefaultBubble ? (
        <div className="inline-flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground/80">
          <LoadingIndicatorContent variant={resolvedVariant} />
        </div>
      ) : (
        <LoadingIndicatorContent variant={resolvedVariant} />
      )}
    </div>
  );
}

function ToggleButton({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={open ? "Collapse chat" : "Expand chat"}
      className={cn(
        "absolute left-1/2 -translate-x-1/2 z-10 transition-all duration-200",
        open ? "-top-11" : "-top-9",
        "inline-flex h-8 w-8 items-center justify-center rounded-full",
        "border border-border/40 bg-background/95 shadow-sm backdrop-blur-md",
        "text-muted-foreground hover:text-foreground hover:bg-background hover:border-border/60",
      )}
      onClick={onToggle}
    >
      {open ? (
        <ChevronDown className="h-4 w-4" />
      ) : (
        <ChevronUp className="h-4 w-4" />
      )}
    </button>
  );
}

function MessageList({
  messages,
  isThinking,
  open,
  resolvedLoadingIndicatorVariant,
}: {
  messages: UIMessage[];
  isThinking: boolean;
  open: boolean;
  resolvedLoadingIndicatorVariant?: LoadingIndicatorVariant;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(
    () =>
      getRenderableConversationMessages(messages)
        .map((message) => ({
          message,
          text: getMessagePreviewText(message),
        }))
        .filter((entry) => entry.text.length > 0),
    [messages],
  );
  const lastVisibleMessage = visibleMessages.at(-1)?.message ?? null;
  const hasVisibleAssistantResponse = lastVisibleMessage?.role === "assistant";
  const shouldShowStandaloneThinkingRow =
    resolvedLoadingIndicatorVariant === "claude-mark" ||
    resolvedLoadingIndicatorVariant === "chatgpt-dot"
      ? isThinking && !hasVisibleAssistantResponse
      : isThinking;

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open, visibleMessages.length, isThinking]);

  if (!open) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-3xl border border-border/40 bg-background/95 shadow-2xl backdrop-blur-xl">
      <div className="max-h-[45vh] overflow-y-auto px-4 py-3 space-y-3">
        {visibleMessages.map(({ message, text }, idx) => {
          const claudeFooterMode =
            resolvedLoadingIndicatorVariant === "claude-mark" &&
            message.role === "assistant" &&
            message.id === lastVisibleMessage?.id
              ? isThinking
                ? "animated"
                : "static"
              : "none";
          return (
            <MessageBubble
              key={message.id ?? `${message.role}-${idx}`}
              text={text}
              isUser={message.role === "user"}
              claudeFooterMode={claudeFooterMode}
            />
          );
        })}
        {shouldShowStandaloneThinkingRow ? (
          <ThinkingRow resolvedVariant={resolvedLoadingIndicatorVariant} />
        ) : null}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Composer({
  value,
  onChange,
  placeholder,
  disabled,
  canSend,
  isThinking,
  onSubmit,
  onStop,
  composerClassName,
  composerStyle,
  activeSubmitButtonClassName,
  inactiveSubmitButtonClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  canSend: boolean;
  isThinking: boolean;
  onSubmit: () => void;
  onStop?: () => void;
  composerClassName: string;
  composerStyle?: CSSProperties;
  activeSubmitButtonClassName: string;
  inactiveSubmitButtonClassName: string;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isThinking || !canSend) return;
    onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (isThinking || !canSend) return;
      onSubmit();
    }
  };

  return (
    <form
      data-testid="fullscreen-composer"
      onSubmit={handleSubmit}
      className={composerClassName}
      style={composerStyle}
    >
      <div className="flex items-center gap-2 px-6 py-3">
        <TextareaAutosize
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={disabled}
          minRows={1}
          maxRows={3}
          className={cn(
            "w-full resize-none border-none bg-transparent dark:bg-transparent px-0 py-0 min-h-0 text-sm leading-tight",
            "placeholder:text-muted-foreground/60 shadow-none",
            "focus-visible:ring-0 focus-visible:outline-none focus-visible:border-none",
          )}
        />
        {isThinking ? (
          <Button
            type="button"
            size="icon"
            aria-label="Stop generating"
            className={cn(
              "size-8 rounded-full shrink-0 transition-all",
              onStop
                ? activeSubmitButtonClassName
                : inactiveSubmitButtonClassName,
              onStop && "hover:scale-105",
            )}
            disabled={!onStop}
            onClick={() => onStop?.()}
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            aria-label="Send message"
            className={cn(
              "size-8 rounded-full shrink-0 transition-all",
              canSend
                ? activeSubmitButtonClassName
                : inactiveSubmitButtonClassName,
              canSend && "hover:scale-105",
            )}
            disabled={!canSend}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>
    </form>
  );
}

type FullscreenChatOverlayProps = {
  messages: UIMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: string;
  onInputChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  canSend: boolean;
  isThinking: boolean;
  loadingIndicatorVariant?: LoadingIndicatorVariant;
  onStop?: () => void;
  onSend: () => void;
};
export function FullscreenChatOverlay({
  messages,
  open,
  onOpenChange,
  input,
  onInputChange,
  placeholder,
  disabled,
  canSend,
  isThinking,
  loadingIndicatorVariant,
  onStop,
  onSend,
}: FullscreenChatOverlayProps) {
  const sandboxHostStyle = useSandboxHostStyle();
  const sandboxHostTheme = useSandboxHostTheme();
  const resolvedLoadingIndicatorVariant = useResolvedLoadingIndicatorVariant(
    loadingIndicatorVariant,
  );
  const resolvedThemeMode = sandboxHostTheme ?? "light";
  const isDarkSandboxTheme = resolvedThemeMode === "dark";
  const appearance = useMemo(
    () => getFullscreenChatAppearance(sandboxHostStyle, isDarkSandboxTheme),
    [sandboxHostStyle, isDarkSandboxTheme],
  );
  const surfaceStyle = useMemo(
    () => getFullscreenSurfaceStyle(sandboxHostStyle, resolvedThemeMode),
    [sandboxHostStyle, resolvedThemeMode],
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50">
      <div
        className="pointer-events-auto mx-auto w-full max-w-3xl px-4 pb-4"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="relative">
          <ToggleButton open={open} onToggle={() => onOpenChange(!open)} />
          <MessageList
            messages={messages}
            isThinking={isThinking}
            open={open}
            resolvedLoadingIndicatorVariant={resolvedLoadingIndicatorVariant}
          />
          <Composer
            value={input}
            onChange={onInputChange}
            placeholder={placeholder}
            disabled={disabled}
            canSend={canSend}
            isThinking={isThinking}
            composerClassName={appearance.composerClassName}
            composerStyle={surfaceStyle}
            activeSubmitButtonClassName={appearance.activeSubmitButtonClassName}
            inactiveSubmitButtonClassName={
              appearance.inactiveSubmitButtonClassName
            }
            onStop={onStop}
            onSubmit={() => {
              onOpenChange(true);
              onSend();
            }}
          />
        </div>
      </div>
    </div>
  );
}
