import { AnyPart, safeStringify } from "../thread-helpers";

export function SourceUrlPart({
  part,
}: {
  part: Extract<AnyPart, { type: "source-url" }>;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">🔗 {part.title ?? part.url}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify({ sourceId: part.sourceId, url: part.url })}
      </pre>
    </div>
  );
}
