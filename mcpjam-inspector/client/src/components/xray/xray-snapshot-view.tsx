/**
 * X-Ray Snapshot View Component
 *
 * Shows the raw JSON payload sent to the AI model - exactly what the model sees.
 */

import { Copy, Trash2, PanelRightClose, ChevronDown } from "lucide-react";
import JsonView from "react18-json-view";
import "react18-json-view/src/style.css";
import "react18-json-view/src/dark.css";
import { toast } from "sonner";
import type { XRayLogEvent } from "@shared/xray-types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface XRaySnapshotViewProps {
  event: XRayLogEvent | null;
  allEvents: XRayLogEvent[];
  onSelectEvent: (eventId: string) => void;
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
  allEvents,
  onSelectEvent,
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
          {/* Event selector dropdown */}
          {allEvents.length > 1 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs gap-1"
                >
                  <span className="font-mono">
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </span>
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[300px] overflow-auto">
                {allEvents.map((e, idx) => (
                  <DropdownMenuItem
                    key={e.id}
                    onClick={() => onSelectEvent(e.id)}
                    className={cn(
                      "text-xs font-mono gap-2",
                      e.id === event.id && "bg-muted"
                    )}
                  >
                    <span className="text-muted-foreground w-4">
                      {allEvents.length - idx}
                    </span>
                    <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
                    <span className="text-muted-foreground">
                      {e.model.provider}/{e.model.id}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Copy button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => copyToClipboard(event, "X-Ray payload")}
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
            disabled={allEvents.length === 0}
            className="h-7 w-7"
            title="Clear all"
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

      {/* Raw JSON View */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3">
          <JsonView
            src={event}
            dark={true}
            theme="atom"
            enableClipboard={true}
            displaySize={false}
            collapsed={2}
            style={{
              fontSize: "11px",
              fontFamily: "ui-monospace, SFMono-Regular, 'SF Mono', monospace",
              backgroundColor: "transparent",
              padding: "0",
            }}
          />
        </div>
      </ScrollArea>
    </div>
  );
}
