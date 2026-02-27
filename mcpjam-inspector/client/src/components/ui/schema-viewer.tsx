import { JsonHighlighter } from "@/components/ui/json-editor/json-highlighter";

interface SchemaViewerProps {
  schema: object;
}

export function SchemaViewer({ schema }: SchemaViewerProps) {
  return (
    <div className="w-0 min-w-full overflow-x-auto rounded-md bg-muted/30">
      <pre
        className="p-3 text-xs leading-5 whitespace-pre m-0 w-fit"
        style={{ fontFamily: "var(--font-code)" }}
      >
        <JsonHighlighter content={JSON.stringify(schema, null, 2)} />
      </pre>
    </div>
  );
}
