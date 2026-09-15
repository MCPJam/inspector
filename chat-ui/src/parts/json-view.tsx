import { Fragment, useMemo, type ReactNode } from "react";
import { cn } from "../internal/cn";
import { tokenizeJson } from "../internal/json-tokens";

/**
 * Stable JSON stringify that survives circular references (tool outputs can
 * contain cycles) instead of collapsing to "[object Object]".
 *
 * Callers that need the payload as text before rendering it (`ToolCallPart`,
 * which hands the same string to the `renderJson` seam) should use
 * `renderJsonText` below and pass the result back in as `JsonView`'s `text`,
 * so it is produced once rather than once per consumer.
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
 * payload before rendering it has what will actually be on screen.
 */
export function renderJsonText(value: unknown): string {
  return typeof value === "string" ? value : stringifyJson(value);
}

/**
 * Past this many characters, colouring costs more than it returns: one React
 * element per token, against a payload nobody reads line by line. Beyond it
 * the same text renders as plain monospace — complete, just uncoloured.
 */
export const HIGHLIGHT_CHAR_LIMIT = 100_000;

/** Index of the first non-whitespace character, or -1. */
function firstNonSpace(text: string): number {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 32 && (code < 9 || code > 13)) return i;
  }
  return -1;
}

/**
 * Whether `text` is JSON worth colouring.
 *
 * NOT a losslessness guard. Rendering is lossless for any input — the loop
 * below emits every character the tokenizer did not claim, and every token's
 * value is a raw slice — so a payload that slips past this gate is miscoloured
 * at worst, never truncated. Do not "simplify" that loop to emit only token
 * spans on the strength of this check.
 *
 * What it buys: `renderJsonText` passes STRING payloads through verbatim, so a
 * lot of what arrives here is prose or a stack trace. The tokenizer ignores
 * characters it does not recognise, so `{connection failed}` would come back
 * with coloured braces and `Error: expected null` with a coloured `null`. The
 * parse is what separates real JSON from text that merely looks structural;
 * the opener check in front of it keeps prose from paying for a parse at all.
 */
function shouldHighlight(text: string): boolean {
  if (text.length > HIGHLIGHT_CHAR_LIMIT) return false;
  const head = firstNonSpace(text);
  if (head === -1) return false;
  const opener = text[head];
  if (opener !== "{" && opener !== "[") return false;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Read-only JSON display: the payload as monospace text, coloured by the same
 * tokenizer the Playground's `JsonEditor` uses (`internal/json-tokens`).
 * Sharing the tokenizer rather than the component is what gives Sessions the
 * Playground's colours without pulling CodeMirror into a read-only package
 * (BB-239). Anything that is not JSON renders plain; see `shouldHighlight`.
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
   * `ToolCallPart` serialises to hand the same string to the renderer seam and
   * the view, so passing it back in is not an optimisation of a cheap call:
   * without it a large tool result is stringified twice on every render. It
   * also makes the guarantee real rather than coincidental — the text that was
   * computed is the text displayed, instead of two call sites duplicating the
   * string/object branch below and being trusted to keep agreeing.
   */
  text?: string;
  className?: string;
}) {
  const text = preRendered ?? renderJsonText(value);

  /**
   * Tokens, or `null` for "render this as plain text".
   *
   * Memoised on the text: the tokenizer is a full scan of the payload, and a
   * transcript re-renders on every hover and score that lands in it.
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
    // between tokens, so the block is character-for-character the string it
    // was given — indentation included.
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
