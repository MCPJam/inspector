/**
 * McpjamAgentComposer — shared input shell for MCPJam Agent surfaces.
 *
 * Used by `McpjamAgentHero` (home greeting) and `McpjamAgentThread`
 * (follow-up composer). When rendered inside a `ChatboxHostStyleProvider`
 * (thread/sidebar), it picks up the same composer skin as the playground
 * `ChatInput`. On the home hero (no host context), it uses the orange
 * invite ring to prompt the first message.
 */
import {
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";
import { cn } from "@/lib/utils";
import {
  useChatboxHostStyle,
  useChatboxHostTheme,
} from "@/contexts/chatbox-client-style-context";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { getChatboxComposerAppearance } from "@/lib/chatbox-composer-appearance";
import { getChatboxHostFamily } from "@/lib/chatbox-client-style";

export interface McpjamAgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  ready?: boolean;
  placeholder?: string;
  loadingMessage?: string;
  isStreaming?: boolean;
  onStop?: () => void;
  className?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  minRows?: number;
  maxRows?: number;
  header?: ReactNode;
}

export function McpjamAgentComposer({
  value,
  onChange,
  onSubmit,
  ready = true,
  placeholder = "Ask anything…",
  loadingMessage = "Loading…",
  isStreaming = false,
  onStop,
  className,
  textareaRef,
  minRows,
  maxRows,
  header,
}: McpjamAgentComposerProps) {
  const [focused, setFocused] = useState(false);
  const chatboxHostStyle = useChatboxHostStyle();
  const chatboxHostTheme = useChatboxHostTheme();
  const globalThemeMode = usePreferencesStore((state) => state.themeMode);
  const isChatboxMode = chatboxHostStyle != null;
  const isDark =
    (chatboxHostTheme ?? globalThemeMode) === "dark";
  const hostFamily = getChatboxHostFamily(chatboxHostStyle);
  const chatboxAppearance = getChatboxComposerAppearance(hostFamily, isDark);

  const canSubmit = value.trim().length > 0 && ready && !isStreaming;
  const showInvite = !isChatboxMode && ready && value.length === 0 && !isStreaming;
  const showHint =
    !ready || (!isChatboxMode && ready && focused && value.length === 0);

  const resolvedMinRows = minRows ?? (isChatboxMode ? 2 : 3);
  const resolvedMaxRows = maxRows ?? (isChatboxMode ? 4 : 8);

  const onFormSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!isStreaming) {
      onSubmit();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isStreaming) return;
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      onSubmit();
    }
  };

  const hintText = !ready
    ? loadingMessage
    : "Enter to send · Shift+Enter for newline";

  const shellClasses = isChatboxMode
    ? cn(
        "relative flex w-full cursor-text flex-col px-2 pt-2 pb-2",
        chatboxAppearance.shellClasses,
      )
    : cn(
        "relative cursor-text rounded-2xl border bg-card/60 shadow-sm transition-[border-color,box-shadow,background-color]",
        showInvite
          ? cn(
              "border-primary/50 ring-2 ring-primary/25 shadow-[0_8px_24px_-12px] shadow-primary/30",
              focused && "border-primary/60 bg-card/80",
            )
          : cn(
              "border-border/70",
              focused &&
                "border-foreground/30 bg-card/80 shadow-md ring-1 ring-foreground/10",
            ),
      );

  const textareaClasses = isChatboxMode
    ? cn(
        "min-h-[64px] w-full resize-none overflow-y-auto overscroll-contain border-none bg-transparent dark:bg-transparent px-4",
        "pt-2 pb-3 text-base text-foreground placeholder:text-muted-foreground/70",
        "outline-none focus-visible:outline-none focus-visible:ring-0 shadow-none focus-visible:shadow-none",
        isStreaming && "cursor-not-allowed text-muted-foreground",
      )
    : "min-h-[5.5rem] resize-none rounded-none border-0 bg-transparent px-4 py-3 text-[15px] leading-[1.625] caret-foreground shadow-none outline-none focus-visible:border-0 focus-visible:ring-0 md:text-[15px]";

  const footerClasses = isChatboxMode
    ? "flex items-center justify-end gap-2 px-2 min-w-0"
    : "flex items-center justify-between gap-3 px-4 py-3";

  return (
    <form
      onSubmit={onFormSubmit}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("button")) return;
        textareaRef?.current?.focus();
      }}
      className={cn(shellClasses, className)}
    >
      {header}
      <TextareaAutosize
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={ready ? placeholder : loadingMessage}
        minRows={resolvedMinRows}
        maxRows={resolvedMaxRows}
        disabled={isStreaming}
        className={textareaClasses}
      />
      <div className={footerClasses}>
        {!isChatboxMode ? (
          <span
            className={cn(
              "text-[11px] leading-none text-muted-foreground/70 transition-opacity",
              showHint ? "opacity-100" : "opacity-0",
            )}
          >
            {hintText}
          </span>
        ) : showHint ? (
          <span className="mr-auto text-[11px] leading-none text-muted-foreground/70">
            {hintText}
          </span>
        ) : null}
        {isStreaming ? (
          <Button
            type="button"
            size="icon"
            variant={isChatboxMode ? "secondary" : "outline"}
            onClick={onStop}
            disabled={!onStop}
            aria-label="Stop generating"
            className={cn(
              "size-[34px] shrink-0 rounded-full transition-colors shadow-none",
            )}
          >
            <Square className="size-4" aria-hidden />
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon"
            disabled={!canSubmit}
            title={ready ? "Send" : loadingMessage}
            aria-label="Send"
            className={cn(
              "shrink-0 rounded-full transition-colors shadow-none",
              isChatboxMode ? "size-[34px]" : "size-8 self-center",
              isChatboxMode
                ? canSubmit
                  ? chatboxAppearance.activeSubmitButtonClasses
                  : chatboxAppearance.inactiveSubmitButtonClasses
                : undefined,
            )}
          >
            <ArrowUp className={isChatboxMode ? "size-4" : "size-4"} aria-hidden />
          </Button>
        )}
      </div>
    </form>
  );
}
