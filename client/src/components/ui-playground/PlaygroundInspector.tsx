/**
 * PlaygroundInspector
 *
 * Right panel showing the LoggerView for JSON-RPC logs.
 */

import { LoggerView } from "../logging/logger-view";

interface PlaygroundInspectorProps {
  onClose?: () => void;
}

export function PlaygroundInspector({ onClose }: PlaygroundInspectorProps) {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <LoggerView onClose={onClose} />
    </div>
  );
}
