import { useEffect, useId, useState } from "react";
import { ChevronDown } from "lucide-react";

export type ReasoningDisplayMode =
  | "inline"
  | "collapsible"
  | "collapsed"
  | "hidden";

/**
 * The mode every LIVE chat surface uses (BB-111).
 *
 * There is more than one live-chat render path — the single-host Playground
 * thread, the multi-model / multi-host compare cards, and the MCPJam agent
 * thread — and each one reaches `Thread` separately. Setting `"collapsed"` on
 * only some of them is what produced the reported inconsistency: reasoning
 * appeared as a tidy collapsed block when comparing models, but as a raw wall
 * of inline text with a single client selected.
 *
 * Import this instead of writing the literal, so a new live surface inherits
 * the same behavior and the paths cannot drift apart again. Read-only
 * transcript surfaces (evals traces, share-usage, the public chatbox) are
 * deliberately NOT covered — they set their own mode.
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

  // Resync only when the display mode itself changes. `text` must NOT be a
  // dependency: it grows with every streamed reasoning delta, so including it
  // slammed the panel shut on each token the moment a reader expanded it
  // mid-stream — which made "collapsed" unusable exactly while reasoning is
  // most interesting to watch.
  useEffect(() => {
    setIsExpanded(displayMode !== "collapsed");
  }, [displayMode]);

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
        {/* The whole point of the collapsed default: a turn that would
            otherwise look frozen shows live motion while the model reasons.
            The shimmer sweeps the label itself, so it carries that signal
            without adding a second element competing with the chevron. */}
        <span
          className={state === "streaming" ? "reasoning-shimmer-text" : undefined}
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
