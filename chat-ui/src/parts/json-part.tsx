import { JsonView } from "./json-view";

export function JsonPart({
  label,
  value,
}: {
  label: string;
  value: unknown;
  /** Accepted for API parity with the inspector; the read-only view always
   * sizes to content. */
  autoHeight?: boolean;
}) {
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">{label}</div>
      <JsonView value={value} />
    </div>
  );
}
