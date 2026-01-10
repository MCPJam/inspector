import { safeStringify } from "../thread-helpers";

export function JsonPart({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-muted-foreground">
        {safeStringify(value)}
      </pre>
    </div>
  );
}
