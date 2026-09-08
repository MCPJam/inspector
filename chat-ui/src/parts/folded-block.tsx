import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../internal/cn";

/**
 * Past this many lines a payload stops being something you read and becomes
 * something you scroll past. Tool results routinely run to hundreds of lines,
 * and a transcript that inlines them all is the "bunch of JSON" a PM reported
 * instead of a conversation (BB-198).
 *
 * Twelve is roughly a screenful of a small monospace block inside a chat row —
 * enough that short results (a status, a couple of fields, one row) never gain
 * a control they do not need.
 */
export const FOLD_LINE_LIMIT = 12;

/** Same idea for one very long line, which a line count cannot see. */
export const FOLD_CHAR_LIMIT = 800;

export function shouldFold(text: string): boolean {
  if (text.length > FOLD_CHAR_LIMIT) return true;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
      if (lines > FOLD_LINE_LIMIT) return true;
    }
  }
  return false;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

/**
 * A labelled payload block that folds when it is big enough to bury the
 * conversation around it.
 *
 * COLLAPSED BY CLIPPING, not by slicing the text: the body may be markdown, a
 * code fence, or a JSON dump, and re-serialising a truncated version of any of
 * those produces something that is not valid in its own syntax — a half-open
 * fence swallows the rest of the transcript. A `max-h` window with the real
 * content inside it is honest about being partial and costs no parsing. The
 * cost is that the hidden remainder is still in the DOM, so the clipped
 * wrapper is `aria-hidden` and `inert` — a visual-only collapse would read the
 * whole payload to a screen reader while the toggle beside it says collapsed.
 *
 * The toggle is the LABEL, so the whole header row is the target rather than a
 * chevron a few pixels wide. A block small enough not to fold renders no
 * control at all — a disclosure that only ever reveals what is already visible
 * is noise.
 */
export function FoldedBlock({
  label,
  text,
  children,
  className,
}: {
  label: string;
  /** The payload as text — used ONLY to decide whether to fold and to size it. */
  text: string;
  children: ReactNode;
  className?: string;
}) {
  const folds = shouldFold(text);
  // Big blocks start closed. The transcript is the thing being read; a tool
  // result is evidence you open when the conversation makes you curious.
  const [open, setOpen] = useState(false);

  if (!folds) {
    return (
      <div className={cn("space-y-1", className)}>
        <div className="font-medium text-muted-foreground">{label}</div>
        {children}
      </div>
    );
  }

  const lines = countLines(text);

  return (
    <div className={cn("space-y-1", className)}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className={cn(
          "mcpjam-chat-fold-toggle flex w-full items-center gap-1 rounded-sm text-left",
          "font-medium text-muted-foreground hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        )}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <span>{label}</span>
        {/* The size, so the reader can tell "two lines I skipped" from "four
            hundred" before deciding to open it. */}
        <span className="font-normal text-muted-foreground/70">
          {lines} lines
        </span>
      </button>
      {open ? (
        children
      ) : (
        <div
          className="relative max-h-24 overflow-hidden"
          data-testid="folded-block-preview"
          // The clip is VISUAL only, so unmarked this subtree is still in the
          // a11y tree: a screen reader reads four hundred lines while the
          // button beside it reports `aria-expanded="false"`, which is both a
          // contradiction and the dump the fold exists to spare them.
          //
          // `aria-hidden` is the part that fixes a reachable problem. `inert`
          // is the correct primitive for a clipped subtree and costs nothing,
          // but no payload renderer emits a focusable node today — it guards
          // the next one (a readable result that renders real markdown links)
          // rather than a live tab-order leak.
          aria-hidden
          inert
        >
          {children}
          {/* Fades the cut rather than ending it on a hard edge, which reads
              as a rendering glitch instead of "there is more". */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-card to-transparent"
          />
        </div>
      )}
    </div>
  );
}
