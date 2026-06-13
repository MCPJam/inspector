import { cn } from "../internal/cn";

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
    try {
      text = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return (
    <pre
      className={cn(
        "mcpjam-chat-json overflow-auto rounded-md border border-border bg-muted/30 p-3 text-xs leading-relaxed text-foreground",
        className,
      )}
    >
      {text}
    </pre>
  );
}
