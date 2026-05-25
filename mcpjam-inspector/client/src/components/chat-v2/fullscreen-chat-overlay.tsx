import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import type { UIMessage } from "@ai-sdk/react";
import type { DynamicToolUIPart, ToolUIPart, UITools } from "ai";
import { ArrowUp, ChevronDown, ChevronUp, Square } from "lucide-react";

import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import {
  getChatboxChatBackground,
  getChatboxHostFamily,
  type ChatboxHostStyle,
} from "@/lib/chatbox-client-style";
import { cn } from "@/lib/utils";
import { Button } from "@mcpjam/design-system/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import {
  LoadingIndicatorContent,
  useResolvedHostStyleForIndicator,
} from "@/components/chat-v2/shared/loading-indicator-content";
import { ClaudeLoadingIndicator } from "@/lib/client-styles/indicators/claude-mark";
import {
  type AnyPart,
  getRenderableConversationMessages,
  getToolInfo,
  isDataPart,
  isDynamicTool,
  isToolPart,
} from "@/components/chat-v2/thread/thread-helpers";
import { ToolPart } from "@/components/chat-v2/thread/parts/tool-part";
import { TextPart } from "@/components/chat-v2/thread/parts/text-part";

function extractTextFromUnknown(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(extractTextFromUnknown).filter(Boolean).join("\n").trim();
  }
  if (!value || typeof value !== "object") return "";

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text.trim();
  if (Array.isArray(record.content)) {
    return extractTextFromUnknown(record.content);
  }
  if (record.value !== undefined) {
    return extractTextFromUnknown(record.value);
  }
  return "";
}

function getNonToolPartPreview(part: AnyPart): string {
  if (isDataPart(part)) {
    return extractTextFromUnknown((part as { data?: unknown }).data);
  }

  if (
    part.type === "reasoning" &&
    typeof (part as { text?: unknown }).text === "string" &&
    (part as { text: string }).text.trim() !== "[REDACTED]"
  ) {
    return "Reasoning...";
  }

  return "";
}

function getLegacyMessageContentText(message: UIMessage): string {
  const content = (message as unknown as { content?: unknown }).content;
  if (typeof content !== "string") {
    return "";
  }

  return content.trim();
}

function getTextPartPreview(part: AnyPart): string {
  if (!part || typeof part !== "object") return "";
  if (part.type !== "text") return "";
  if (typeof (part as { text?: unknown }).text !== "string") return "";
  return (part as { text: string }).text.trim();
}

type FullscreenToolPart = ToolUIPart<UITools> | DynamicToolUIPart;

type FullscreenMessageEntry =
  | {
      kind: "bubble";
      key: string;
      message: UIMessage;
      text: string;
    }
  | {
      kind: "tool";
      key: string;
      message: UIMessage;
      part: FullscreenToolPart;
    };

function getSerializableLength(value: unknown): number {
  if (value === undefined || value === null) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function getToolEntrySignature(part: FullscreenToolPart): string {
  const toolInfo = getToolInfo(part);
  return [
    toolInfo.toolCallId ?? "",
    toolInfo.toolName,
    toolInfo.toolState ?? "",
    getSerializableLength(toolInfo.input),
    getSerializableLength(toolInfo.rawOutput),
    toolInfo.errorText?.length ?? 0,
  ].join(":");
}

function getMessageEntries(message: UIMessage): FullscreenMessageEntry[] {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  const entries: FullscreenMessageEntry[] = [];
  const hasTextPart = parts.some((part) => getTextPartPreview(part).length > 0);
  const legacyContentText = hasTextPart
    ? ""
    : getLegacyMessageContentText(message);

  if (legacyContentText) {
    entries.push({
      kind: "bubble",
      key: `${message.id ?? message.role}:legacy-content`,
      message,
      text: legacyContentText,
    });
  }

  parts.forEach((part, partIndex) => {
    const text = getTextPartPreview(part);
    if (text) {
      entries.push({
        kind: "bubble",
        key: `${message.id ?? message.role}:text:${partIndex}`,
        message,
        text,
      });
      return;
    }

    if (isToolPart(part) || isDynamicTool(part)) {
      const toolInfo = getToolInfo(part);
      entries.push({
        kind: "tool",
        key: `${message.id ?? message.role}:tool:${
          toolInfo.toolCallId ?? toolInfo.toolName
        }:${partIndex}`,
        message,
        part,
      });
      return;
    }

    const fallbackText = getNonToolPartPreview(part);
    if (fallbackText) {
      entries.push({
        kind: "bubble",
        key: `${message.id ?? message.role}:fallback:${partIndex}`,
        message,
        text: fallbackText,
      });
    }
  });

  return entries;
}

function getVisibleMessageEntries(
  messages: UIMessage[]
): FullscreenMessageEntry[] {
  return getRenderableConversationMessages(messages).flatMap((message) =>
    getMessageEntries(message)
  );
}

function getFullscreenChatAppearance(
  chatboxHostStyle: ChatboxHostStyle | null,
  isDarkChatboxTheme: boolean
) {
  const hostFamily = getChatboxHostFamily(chatboxHostStyle);
  return {
    composerClassName:
      hostFamily === "chatgpt"
        ? cn(
            "chatbox-host-composer rounded-[1.75rem]",
            isDarkChatboxTheme
              ? "border border-white/10 shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_24px_rgba(130,130,130,0.14)]"
              : "border border-neutral-200/90 shadow-[0_1px_2px_rgba(0,0,0,0.04),0_4px_22px_rgba(100,100,100,0.08)]"
          )
        : hostFamily === "claude"
        ? cn(
            "chatbox-host-composer rounded-[1.35rem]",
            isDarkChatboxTheme
              ? "border-[#4b463d] shadow-[0_1px_2px_rgba(0,0,0,0.28),0_4px_22px_rgba(120,120,120,0.12)]"
              : "border border-[#DFDFDB] shadow-[0_1px_2px_rgba(0,0,0,0.05),0_4px_20px_rgba(110,110,110,0.08)]"
          )
        : "rounded-full border border-border/40 bg-background/95 backdrop-blur-xl",
    activeSubmitButtonClassName:
      hostFamily === "chatgpt"
        ? isDarkChatboxTheme
          ? "bg-[#f4f4f4] text-[#1f1f1f] hover:bg-[#e8e8e8]"
          : "bg-[#1f1f1f] text-white hover:bg-[#303030]"
        : hostFamily === "claude"
        ? isDarkChatboxTheme
          ? "bg-[#d07b53] text-[#fff7f0] hover:bg-[#c06f49]"
          : "bg-[#e27d47] text-white hover:bg-[#d16f3d]"
        : "bg-primary text-primary-foreground hover:bg-primary/90",
    inactiveSubmitButtonClassName:
      hostFamily === "chatgpt"
        ? isDarkChatboxTheme
          ? "bg-[#3a3a3a] text-[#8a8a8a] cursor-not-allowed"
          : "bg-[#e7e7e7] text-[#9b9b9b] cursor-not-allowed"
        : hostFamily === "claude"
        ? isDarkChatboxTheme
          ? "bg-[#45413b] text-[#8d857a] cursor-not-allowed"
          : "bg-[#ebe5dc] text-[#b6ada0] cursor-not-allowed"
        : "bg-muted text-muted-foreground cursor-not-allowed",
  };
}

function getFullscreenSurfaceStyle(
  chatboxHostStyle: ChatboxHostStyle | null,
  resolvedThemeMode: "light" | "dark"
): CSSProperties | undefined {
  const backgroundColor = getChatboxChatBackground(
    chatboxHostStyle,
    resolvedThemeMode
  );
  return backgroundColor ? { backgroundColor } : undefined;
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
              : "bg-muted text-foreground"
          )}
        >
          {isUser ? text : <TextPart text={text} role="assistant" />}
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

function ToolMessageEntry({
  part,
  chatSessionId,
  claudeFooterMode = "none",
}: {
  part: FullscreenToolPart;
  chatSessionId?: string;
  claudeFooterMode?: "none" | "animated" | "static";
}) {
  const showClaudeFooter = claudeFooterMode !== "none";

  return (
    <div className="flex w-full justify-start">
      <div className={cn("w-full", showClaudeFooter && "space-y-3")}>
        <ToolPart part={part} chatSessionId={chatSessionId} />
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

function ThinkingRow({ modelProvider }: { modelProvider?: string | null }) {
  // Branded indicators (Claude / ChatGPT) render bare so the brand art
  // owns the spacing; the generic "Thinking…" text gets the muted bubble.
  const hasBrandIndicator =
    useResolvedHostStyleForIndicator(modelProvider) !== null;

  return (
    <div
      data-testid="fullscreen-thinking-row"
      className="flex w-full justify-start"
    >
      {hasBrandIndicator ? (
        <LoadingIndicatorContent modelProvider={modelProvider} />
      ) : (
        <div className="inline-flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground/80">
          <LoadingIndicatorContent modelProvider={modelProvider} />
        </div>
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
        "text-muted-foreground hover:text-foreground hover:bg-background hover:border-border/60"
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
  modelProvider,
  chatSessionId,
}: {
  messages: UIMessage[];
  isThinking: boolean;
  open: boolean;
  modelProvider?: string | null;
  chatSessionId?: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const resolvedIndicatorHostStyle =
    useResolvedHostStyleForIndicator(modelProvider);
  const hasBrandIndicator = resolvedIndicatorHostStyle !== null;
  // Claude paints its mark inline beneath the last assistant bubble
  // ("footer" treatment); other hosts use the standalone row only.
  // Resolve through the provider-aware helper so Direct Chat (no chatbox
  // host context) still gets the footer when model.provider is Anthropic.
  const isClaudeFamily =
    getChatboxHostFamily(resolvedIndicatorHostStyle) === "claude";

  const visibleEntries = getVisibleMessageEntries(messages);
  const visibleMessageScrollKey = visibleEntries
    .map((entry) =>
      entry.kind === "tool"
        ? `${entry.key}:${entry.message.role}:${getToolEntrySignature(
            entry.part
          )}`
        : `${entry.key}:${entry.message.role}:${entry.text.length}`
    )
    .join("|");
  const lastVisibleEntry = visibleEntries.at(-1) ?? null;
  const lastVisibleMessage = lastVisibleEntry?.message ?? null;
  const hasVisibleAssistantResponse = lastVisibleMessage?.role === "assistant";
  const shouldShowStandaloneThinkingRow = hasBrandIndicator
    ? isThinking && !hasVisibleAssistantResponse
    : isThinking;

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open, visibleMessageScrollKey, isThinking]);

  if (!open) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-3xl border border-border/40 bg-background/95 shadow-2xl backdrop-blur-xl">
      <div className="max-h-[45vh] overflow-y-auto px-4 py-3 space-y-3">
        {visibleEntries.map((entry) => {
          const message = entry.message;
          const claudeFooterMode =
            isClaudeFamily &&
            message.role === "assistant" &&
            entry.key === lastVisibleEntry?.key
              ? isThinking
                ? "animated"
                : "static"
              : "none";
          return entry.kind === "tool" ? (
            <ToolMessageEntry
              key={entry.key}
              part={entry.part}
              chatSessionId={chatSessionId}
              claudeFooterMode={claudeFooterMode}
            />
          ) : (
            <MessageBubble
              key={entry.key}
              text={entry.text}
              isUser={message.role === "user"}
              claudeFooterMode={claudeFooterMode}
            />
          );
        })}
        {shouldShowStandaloneThinkingRow ? (
          <ThinkingRow modelProvider={modelProvider} />
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
            "focus-visible:ring-0 focus-visible:outline-none focus-visible:border-none"
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
              onStop && "hover:scale-105"
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
              canSend && "hover:scale-105"
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
  chatSessionId?: string;
  messages: UIMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: string;
  onInputChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  canSend: boolean;
  isThinking: boolean;
  onStop?: () => void;
  onSend: () => void;
  /** Provider id from the active chat model — feeds the indicator's
   * fallback path for surfaces without a chatbox host context. */
  modelProvider?: string | null;
};
export function FullscreenChatOverlay({
  chatSessionId,
  messages,
  open,
  onOpenChange,
  input,
  onInputChange,
  placeholder,
  disabled,
  canSend,
  isThinking,
  onStop,
  onSend,
  modelProvider,
}: FullscreenChatOverlayProps) {
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const resolvedThemeMode = chatboxHostTheme ?? "light";
  const isDarkChatboxTheme = resolvedThemeMode === "dark";
  const appearance = useMemo(
    () => getFullscreenChatAppearance(chatboxHostStyle, isDarkChatboxTheme),
    [chatboxHostStyle, isDarkChatboxTheme]
  );
  const surfaceStyle = useMemo(
    () => getFullscreenSurfaceStyle(chatboxHostStyle, resolvedThemeMode),
    [chatboxHostStyle, resolvedThemeMode]
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
            modelProvider={modelProvider}
            chatSessionId={chatSessionId}
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
