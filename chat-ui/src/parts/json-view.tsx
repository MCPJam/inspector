import { cn } from "../internal/cn";

/**
 * Stable JSON stringify that survives circular references (tool outputs can
 * contain cycles) instead of collapsing to "[object Object]".
 */
function stringifyJson(value: unknown): string {
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
        2,
      ) ?? String(value)
    );
  } catch {
    return String(value);
  }
}

/**
 * Minimal read-only JSON display. Replaces the inspector's heavyweight
 * `@/components/ui/json-editor` (CodeMirror-based, editable) with a plain
 * pre block — Tier A only needs to *show* tool input/output, not edit it.
 */
export function JsonView({
  value,
  className,
}: {
  value: unknown;
  className?: string;
}) {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    text = stringifyJson(value);
  }
  return (
    <pre
      className={cn(
        "mcpjam-chat-json overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground",
        className,
      )}
    >
      {text}
    </pre>
  );
}
