/**
 * PlaygroundRight
 *
 * Right panel showing the LoggerView for JSON-RPC logs.
 */

import { LoggerView } from "../logging/logger-view";

interface PlaygroundRightProps {
  onClose?: () => void;
}

export function PlaygroundRight({ onClose }: PlaygroundRightProps) {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <LoggerView onClose={onClose} />
    </div>
  );
}
