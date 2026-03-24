import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";

export type ReasoningDisplayMode =
  | "inline"
  | "collapsible"
  | "collapsed"
  | "hidden";

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

  useEffect(() => {
    setIsExpanded(displayMode !== "collapsed");
  }, [displayMode, text]);

  if (isRedacted || isHidden) return null;

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
        <span>Reasoning</span>
        <span className="flex items-center gap-2">
          {state === "streaming" ? (
            <span className="text-[10px] normal-case tracking-normal text-muted-foreground/70">
              Streaming
            </span>
          ) : null}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${
              isExpanded ? "rotate-180" : ""
            }`}
          />
        </span>
      </button>
      {isExpanded ? (
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
