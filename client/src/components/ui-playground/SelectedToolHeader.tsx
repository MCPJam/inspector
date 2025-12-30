/**
 * SelectedToolHeader
 *
 * Compact header showing the currently selected tool with expand/clear actions
 */

import { X } from "lucide-react";
import { Button } from "../ui/button";

interface SelectedToolHeaderProps {
  toolName: string;
  onExpand: () => void;
  onClear: () => void;
}

export function SelectedToolHeader({
  toolName,
  onExpand,
  onClear,
}: SelectedToolHeaderProps) {
  return (
    <div className="border-b border-border bg-muted/30 flex-shrink-0 px-3 py-2 flex items-center gap-2">
      <button
        onClick={onExpand}
        className="flex-1 min-w-0 hover:bg-muted/50 rounded px-1.5 py-0.5 -mx-1.5 transition-colors text-left"
        title="Click to change tool"
      >
        <code className="text-xs font-mono font-medium text-foreground truncate block">
          {toolName}
        </code>
      </button>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground flex-shrink-0"
        onClick={onClear}
        title="Clear selection"
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}
