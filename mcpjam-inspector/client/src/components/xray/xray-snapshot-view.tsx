/**
 * X-Ray Snapshot View Component
 *
 * Shows the raw payload sent to the AI model's generateText() call.
 * Displays only the latest snapshot (no history).
 */

import { Copy, Trash2, PanelRightClose } from "lucide-react";
import { toast } from "sonner";
import type { XRayLogEvent } from "@shared/xray-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface XRaySnapshotViewProps {
  event: XRayLogEvent | null;
  onClear: () => void;
  onClose?: () => void;
}

function copyToClipboard(data: unknown, label: string) {
  navigator.clipboard
    .writeText(typeof data === "string" ? data : JSON.stringify(data, null, 2))
    .then(() => toast.success(`${label} copied to clipboard`))
    .catch(() => toast.error(`Failed to copy ${label}`));
}

export function XRaySnapshotView({
  event,
  onClear,
  onClose,
}: XRaySnapshotViewProps) {
  // Empty state
  if (!event) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-border flex-shrink-0">
          <h2 className="text-xs font-semibold text-foreground">X-Ray</h2>
          <div className="flex items-center gap-1">
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7"
                title="Close X-Ray panel"
              >
                <PanelRightClose className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        {/* Empty state content */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-sm text-muted-foreground">No X-Ray data</div>
            <div className="text-xs text-muted-foreground mt-1">
              AI request payload will appear here when you send messages
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Extract just the model payload from the event
  // This is exactly what gets sent to generateText()
  // Order: system (instructions), tools (capabilities), messages (conversation)
  const modelPayload = {
    system: event.systemPrompt,
    tools: event.tools,
    messages: event.messages,
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold text-foreground">X-Ray</h2>
          <Badge
            variant="outline"
            className={cn(
              "text-[9px] px-1.5 py-0",
              event.path === "mcpjam-backend"
                ? "border-purple-500/50 text-purple-500"
                : "border-blue-500/50 text-blue-500"
            )}
          >
            {event.path === "mcpjam-backend" ? "MCPJam" : "External"}
          </Badge>
        </div>

        <div className="flex items-center gap-1">
          {/* Timestamp display */}
          <span className="text-xs font-mono text-muted-foreground">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>

          {/* Copy button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => copyToClipboard(modelPayload, "Model payload")}
            className="h-7 w-7"
            title="Copy payload"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>

          {/* Clear button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={onClear}
            className="h-7 w-7"
            title="Clear"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>

          {/* Close button */}
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="h-7 w-7"
              title="Close"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3">
          <pre className="overflow-auto whitespace-pre-wrap break-words text-xs bg-muted/20 p-3 font-mono">
            {JSON.stringify(modelPayload, null, 2)}
          </pre>
        </div>
      </ScrollArea>
    </div>
  );
}
