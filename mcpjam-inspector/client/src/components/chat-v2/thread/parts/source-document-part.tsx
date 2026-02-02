import { AnyPart } from "../thread-helpers";
import { JsonEditorView } from "@/components/ui/json-editor";

export function SourceDocumentPart({
  part,
}: {
  part: Extract<AnyPart, { type: "source-document" }>;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">📄 {part.title}</div>
      <JsonEditorView
        value={{
          sourceId: part.sourceId,
          mediaType: part.mediaType,
          filename: part.filename,
        }}
      />
    </div>
  );
}
