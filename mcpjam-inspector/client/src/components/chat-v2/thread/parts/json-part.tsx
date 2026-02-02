import { JsonEditor } from "@/components/ui/json-editor";

export function JsonPart({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">{label}</div>
      <JsonEditor value={value} viewOnly />
    </div>
  );
}
