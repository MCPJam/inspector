export function ReasoningPart({
  text,
}: {
  text: string;
  state?: "streaming" | "done";
}) {
  if (!text || text.trim() === "[REDACTED]") return null;
  return (
    <div className="rounded-lg border border-border/30 bg-muted/10 p-3 text-xs text-muted-foreground">
      <pre className="whitespace-pre-wrap break-words">{text}</pre>
    </div>
  );
}
