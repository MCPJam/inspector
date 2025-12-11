import { AnyPart, safeStringify } from "../thread-helpers";

export function SourceDocumentPart({
  part,
}: {
  part: Extract<AnyPart, { type: "source-document" }>;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">📄 {part.title}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify({
          sourceId: part.sourceId,
          mediaType: part.mediaType,
          filename: part.filename,
        })}
      </pre>
    </div>
  );
}
