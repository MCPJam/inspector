import { AnyPart, safeStringify } from "../thread-helpers";

export function FilePart({
  part,
}: {
  part: Extract<AnyPart, { type: "file" }>;
}) {
  const name = part.filename ?? part.url ?? "file";
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">📎 {name}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify({
          mediaType: part.mediaType,
          filename: part.filename,
          url: part.url,
        })}
      </pre>
    </div>
  );
}
