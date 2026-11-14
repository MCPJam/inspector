import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import "./reasoning-part.css";

export type ReasoningDisplayMode =
  | "inline"
  | "collapsible"
  | "collapsed"
  | "hidden";

/**
 * `Thread`'s default, so every live chat surface shows reasoning the same way
 * without passing it. Read-only transcripts (eval traces, share-usage, the
 * scenario chat page) pass their own mode.
 */
export const LIVE_CHAT_REASONING_DISPLAY_MODE: ReasoningDisplayMode =
  "collapsed";

export function ReasoningPart({
  text,
  state,
  displayMode = "inline",
}: {
  text: string;
  state?: "streaming" | "done";
  displayMode?: ReasoningDisplayMode;
}) {
  const isRedacted = !text || text.trim() === "[REDACTED]";
  const isHidden = displayMode === "hidden";
  const isCollapsible =
    displayMode === "collapsed" || displayMode === "collapsible";
  const [isExpanded, setIsExpanded] = useState(displayMode !== "collapsed");
  const contentId = useId();

  // Only a mode change resets the panel. Text grows with every streamed delta,
  // and a reader who opened the panel mid-stream must be able to keep reading.
  useEffect(() => {
    setIsExpanded(displayMode !== "collapsed");
  }, [displayMode]);

  // While reasoning streams, a collapsible block shows its "Thinking…" header
  // even before any text: a provider that sends no summary streams an empty
  // block, and it may already hide the thread's own thinking indicator.
  const showsEmptyHeader = isRedacted && isCollapsible && state === "streaming";
  if ((isRedacted && !showsEmptyHeader) || isHidden) return null;

  if (!isCollapsible) {
    return (
      <div className="rounded-lg border border-border/30 bg-muted/10 p-3 text-xs text-muted-foreground">
        <pre className="whitespace-pre-wrap break-words">{text}</pre>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/30 bg-muted/10 p-3 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => setIsExpanded((expanded) => !expanded)}
        className="flex w-full items-center justify-between gap-3 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/90"
        aria-expanded={isExpanded}
        aria-controls={contentId}
      >
        {/* Motion on the label shows a long reasoning turn is still alive. */}
        <span
          className={
            state === "streaming" ? "reasoning-shimmer-text" : undefined
          }
        >
          {state === "streaming" ? "Thinking…" : "Reasoning"}
        </span>
        <span className="flex items-center gap-2">
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>
      {isExpanded && !isRedacted ? (
        <pre
          id={contentId}
          className="mt-3 whitespace-pre-wrap break-words text-[12px]"
        >
          {text}
        </pre>
      ) : null}
    </div>
  );
}
