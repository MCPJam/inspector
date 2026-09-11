import { cn } from "../internal/cn";

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
 * Minimal read-only JSON display. Replaces the inspector's heavyweight
 * `@/components/ui/json-editor` (CodeMirror-based, editable) with a plain
 * pre block — Tier A only needs to *show* tool input/output, not edit it.
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
  return (
    <pre
      className={cn(
        "mcpjam-chat-json overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground",
        className
      )}
    >
      {text}
    </pre>
  );
}
