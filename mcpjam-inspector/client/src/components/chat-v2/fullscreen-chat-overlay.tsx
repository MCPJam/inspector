import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef } from "react";

import type { UIMessage } from "@ai-sdk/react";
import { ArrowUp, ChevronDown, ChevronUp } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { TextareaAutosize } from "@/components/ui/textarea-autosize";

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

function MessageBubble({ text, isUser }: { text: string; isUser: boolean }) {
  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-6 whitespace-pre-wrap",
          isUser
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground",
        )}
      >
        {text}
      </div>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="flex w-full justify-start">
      <div className="inline-flex items-center gap-2 rounded-2xl bg-muted px-3 py-2 text-sm text-muted-foreground/80">
        <span className="italic">
          Thinking
          <span className="inline-flex">
            <span className="animate-[blink_1.4s_ease-in-out_infinite]">.</span>
            <span className="animate-[blink_1.4s_ease-in-out_0.2s_infinite]">
              .
            </span>
            <span className="animate-[blink_1.4s_ease-in-out_0.4s_infinite]">
              .
            </span>
          </span>
        </span>
      </div>
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
}: {
  messages: UIMessage[];
  isThinking: boolean;
  open: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const visibleMessages = useMemo(
    () =>
      messages
        .filter((m) => !m.id?.startsWith("widget-state-"))
        .filter((m) => m.role === "user" || m.role === "assistant"),
    [messages],
  );

  useEffect(() => {
    if (!open) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [open, visibleMessages.length, isThinking]);

  if (!open) return null;

  return (
    <div className="mb-4 overflow-hidden rounded-3xl border border-border/40 bg-background/95 shadow-2xl backdrop-blur-xl">
      <div className="max-h-[45vh] overflow-y-auto px-4 py-3 space-y-3">
        {visibleMessages.map((m, idx) => {
          const text = getMessagePreviewText(m);
          if (!text) return null;
          return (
            <MessageBubble
              key={m.id ?? `${m.role}-${idx}`}
              text={text}
              isUser={m.role === "user"}
            />
          );
        })}
        {isThinking && <ThinkingRow />}
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
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  canSend: boolean;
  onSubmit: () => void;
}) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSend) return;
    onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      if (!canSend) return;
      onSubmit();
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-full border border-border/40 bg-background/95 backdrop-blur-xl"
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
            "w-full resize-none border-none bg-transparent px-0 py-0 min-h-0 text-sm leading-tight",
            "placeholder:text-muted-foreground/60 shadow-none",
            "focus-visible:ring-0 focus-visible:outline-none focus-visible:border-none",
          )}
        />
        <Button
          type="submit"
          size="icon"
          className={cn(
            "size-8 rounded-full shrink-0 transition-all",
            canSend
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "bg-muted text-muted-foreground cursor-not-allowed",
            canSend && "hover:scale-105",
          )}
          disabled={!canSend}
        >
          <ArrowUp className="h-4 w-4" />
        </Button>
      </div>
    </form>
  );
}

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
  onSend,
}: {
  messages: UIMessage[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  input: string;
  onInputChange: (value: string) => void;
  placeholder: string;
  disabled: boolean;
  canSend: boolean;
  isThinking: boolean;
  onSend: () => void;
}) {
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
          />
          <Composer
            value={input}
            onChange={onInputChange}
            placeholder={placeholder}
            disabled={disabled}
            canSend={canSend}
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
