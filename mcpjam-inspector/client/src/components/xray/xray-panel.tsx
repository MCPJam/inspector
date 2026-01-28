/**
 * X-Ray Panel Component
 *
 * Main panel that wraps the X-Ray Snapshot View.
 * Shows a single snapshot view of AI request inspection events.
 */

import { useState } from "react";
import { useTrafficLogStore } from "@/stores/traffic-log-store";
import { XRaySnapshotView } from "./xray-snapshot-view";

interface XRayPanelProps {
  onClose?: () => void;
  isCollapsable?: boolean;
}

export function XRayPanel({ onClose, isCollapsable = true }: XRayPanelProps) {
  const xrayItems = useTrafficLogStore((s) => s.xrayItems);
  const clearXRay = useTrafficLogStore((s) => s.clearXRay);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Find selected event or default to the latest (first) one
  const selectedEvent =
    xrayItems.find((e) => e.id === selectedEventId) ?? xrayItems[0] ?? null;

  return (
    <XRaySnapshotView
      event={selectedEvent}
      allEvents={xrayItems}
      onSelectEvent={setSelectedEventId}
      onClear={clearXRay}
      onClose={isCollapsable ? onClose : undefined}
    />
  );
}

export default XRayPanel;
