import { Fragment, useMemo, type ReactNode } from "react";
import { cn } from "../internal/cn";
import { tokenizeJson } from "../internal/json-tokens";

/**
 * Stable JSON stringify that survives circular references (tool outputs can
 * contain cycles) instead of collapsing to "[object Object]".
 *
 * Callers that need to measure a payload before rendering it (see
 * `FoldedBlock`) should use `renderJsonText` below and pass the result back in
 * as `JsonView`'s `text`, so the string that was sized is the string that is
 * shown — and is produced once rather than once per consumer.
 */
export function stringifyJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(
        value,
        (_key, val) => {
          if (typeof val === "object" && val !== null) {
            if (seen.has(val)) return "[Circular]";
            seen.add(val);
          }
          return val as unknown;
        },
        2
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/**
 * The exact text `JsonView` shows for a value: a string payload verbatim, and
 * anything else through `stringifyJson`. Exported so a caller that must size a
 * payload before rendering it measures what will actually be on screen.
 */
export function renderJsonText(value: unknown): string {
  return typeof value === "string" ? value : stringifyJson(value);
}

/**
 * Past this many characters a payload stops being read and starts being
 * scrolled, and tokenising it on every render costs more than the colour is
 * worth. Beyond the cap the same text renders as plain monospace — still
 * complete, still foldable, just uncoloured.
 *
 * Generous on purpose: a tool result big enough to trip this is already behind
 * a closed `FoldedBlock`, so the uncoloured case is one a reader has to go
 * looking for.
 */
export const HIGHLIGHT_CHAR_LIMIT = 100_000;

/**
 * Whether `text` is worth handing to the tokenizer.
 *
 * `renderJsonText` passes STRING payloads through verbatim, so plenty of what
 * reaches this view is prose, a stack trace, or a bare log line rather than
 * JSON. The tokenizer skips characters it does not recognise, so feeding it
 * prose does not throw — it silently drops most of the text, which would
 * render a *truncated* payload. Gating on a structural opener is what keeps
 * the uncoloured path lossless.
 */
function shouldHighlight(text: string): boolean {
  if (text.length > HIGHLIGHT_CHAR_LIMIT) return false;
  const head = text.trimStart()[0];
  return head === "{" || head === "[";
}

/**
 * Read-only JSON display: the payload as monospace text, coloured by the same
 * tokenizer the Playground's `JsonEditor` uses (`internal/json-tokens`).
 *
 * Deliberately NOT the inspector's `@/components/ui/json-editor` — that is
 * CodeMirror-based and editable, and Tier A only needs to *show* a payload.
 * Sharing the tokenizer instead of the component is what gives Sessions the
 * Playground's colours without dragging an editor into a read-only package
 * (BB-239).
 *
 * Anything that is not a JSON object or array — a string payload, a stack
 * trace — renders as plain text rather than being forced through the
 * tokenizer; see `shouldHighlight`.
 */
export function JsonView({
  value,
  text: preRendered,
  className,
}: {
  value: unknown;
  /**
   * The already-serialised payload, when the caller had to produce it anyway.
   *
   * `FoldedBlock` has to MEASURE a payload to decide whether to fold it, and
   * measuring means serialising. Passing that string back in is not an
   * optimisation of a cheap call: without it a large tool result is stringified
   * twice on every render, once to size it and once to show it. It also makes
   * the guarantee real rather than coincidental — the text that was measured is
   * the text that is displayed, instead of two call sites duplicating the
   * string/object branch below and being trusted to keep agreeing.
   */
  text?: string;
  className?: string;
}) {
  const text = preRendered ?? renderJsonText(value);

  /**
   * Tokens, or `null` for "render this as plain text".
   *
   * Memoised on the text alone: the tokenizer is a full scan of the payload,
   * and a transcript re-renders on every hover, fold and score that lands
   * anywhere in it.
   */
  const tokens = useMemo(
    () => (shouldHighlight(text) ? tokenizeJson(text) : null),
    [text]
  );

  const body = useMemo(() => {
    if (!tokens) return text;

    const nodes: ReactNode[] = [];
    let lastIndex = 0;

    // Whitespace and anything the tokenizer did not claim is emitted verbatim
    // between tokens, so the block is character-for-character the string that
    // `FoldedBlock` measured — indentation included.
    for (const [i, token] of tokens.entries()) {
      if (token.start > lastIndex) {
        nodes.push(
          <Fragment key={`gap-${lastIndex}`}>
            {text.slice(lastIndex, token.start)}
          </Fragment>
        );
      }
      nodes.push(
        <span key={`t-${i}`} className={`json-${token.type}`}>
          {token.value}
        </span>
      );
      lastIndex = token.end;
    }

    if (lastIndex < text.length) {
      nodes.push(<Fragment key="gap-end">{text.slice(lastIndex)}</Fragment>);
    }

    return nodes;
  }, [tokens, text]);

  return (
    <pre
      className={cn(
        "mcpjam-chat-json overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground",
        className
      )}
    >
      {body}
    </pre>
  );
}
