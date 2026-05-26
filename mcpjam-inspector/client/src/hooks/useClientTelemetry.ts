import { useCallback, useRef } from "react";
import { useMutation } from "convex/react";

interface EmbeddedBlobReadEvent {
  projectId: string;
  serverCount: number;
}

/**
 * Fire-and-forget telemetry emit for reads of the in-record `servers` map on
 * a `RemoteProject`. Each `projectId` is reported at most once per browser
 * session, so the volume is bounded by the user's distinct non-active
 * project count. Failures are swallowed — a busted telemetry pipe must
 * never affect the picker.
 */
export function useEmbeddedBlobReadTelemetry() {
  const recordClientEvent = useMutation(
    "telemetry:recordClientEvent" as any
  );
  const seenRef = useRef<Set<string>>(new Set());

  return useCallback(
    (event: EmbeddedBlobReadEvent) => {
      if (seenRef.current.has(event.projectId)) return;
      seenRef.current.add(event.projectId);
      void recordClientEvent({
        event: "embedded_servers_blob_read",
        properties: {
          project_id: event.projectId,
          server_count: event.serverCount,
          location: "project_picker",
        },
      } as any).catch(() => {
        // Fire-and-forget: telemetry failure must never affect the picker.
      });
    },
    [recordClientEvent]
  );
}
