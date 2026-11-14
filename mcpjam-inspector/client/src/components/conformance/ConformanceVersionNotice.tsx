import type { ProtocolVersionRefusal } from "@/shared/conformance-connection";

export function ConformanceVersionNotice({
  refusal,
  serverName,
}: {
  refusal?: ProtocolVersionRefusal;
  serverName: string;
}) {
  if (!refusal) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-md border border-warning/30 bg-warning/10 p-3 text-sm"
    >
      <p>
        {serverName} doesn’t support {refusal.protocolVersion}. Checks requiring
        that version could not run.
      </p>
      {refusal.supportedVersions.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          Server offers: {refusal.supportedVersions.join(", ")}.
        </p>
      )}
    </div>
  );
}
