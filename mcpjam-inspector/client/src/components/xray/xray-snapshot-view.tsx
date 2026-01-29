/**
 * X-Ray Snapshot View Component
 *
 * Shows the raw payload sent to the AI model's generateText() call.
 * Uses existing client state directly - no server-side storage needed.
 */

import { Copy, PanelRightClose } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

interface XRaySnapshotViewProps {
  systemPrompt: string | undefined;
  messages: unknown[];
  tools: unknown[];
  onClose?: () => void;
}

function copyToClipboard(data: unknown, label: string) {
  navigator.clipboard
    .writeText(typeof data === "string" ? data : JSON.stringify(data, null, 2))
    .then(() => toast.success(`${label} copied to clipboard`))
    .catch(() => toast.error(`Failed to copy ${label}`));
}

export function XRaySnapshotView({
  systemPrompt,
  messages,
  tools,
  onClose,
}: XRaySnapshotViewProps) {
  const hasData = systemPrompt || messages.length > 0 || tools.length > 0;

  // Build the payload object
  const modelPayload = {
    system: systemPrompt,
    tools,
    messages,
  };

  // Empty state
  if (!hasData) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
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

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-sm text-muted-foreground">No X-Ray data</div>
            <div className="text-xs text-muted-foreground mt-1">
              Send a message to see the AI request payload
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
        <h2 className="text-xs font-semibold text-foreground">X-Ray</h2>

        <div className="flex items-center gap-1">
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
