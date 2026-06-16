import type { AnyPart } from "../internal/thread-helpers";
import { JsonView } from "./json-view";

export function SourceDocumentPart({
  part,
}: {
  part: Extract<AnyPart, { type: "source-document" }>;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">📄 {part.title}</div>
      <JsonView
        value={{
          sourceId: part.sourceId,
          mediaType: part.mediaType,
          filename: part.filename,
        }}
      />
    </div>
  );
}
