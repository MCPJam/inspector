/**
 * X-Ray Snapshot View Component
 *
 * Shows the actual payload sent to the AI model's generateText() call.
 * Fetches the real enhanced payload from the server to ensure accuracy.
 */

import { useEffect, useState } from "react";
import { Copy, X, RefreshCw, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import type { UIMessage } from "ai";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  getXRayPayload,
  type XRayPayloadResponse,
} from "@/lib/apis/mcp-xray-api";

interface XRaySnapshotViewProps {
  systemPrompt: string | undefined;
  messages: UIMessage[];
  selectedServers: string[];
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
  selectedServers,
  onClose,
}: XRaySnapshotViewProps) {
  const [payload, setPayload] = useState<XRayPayloadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchPayload = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await getXRayPayload({
        messages,
        systemPrompt,
        selectedServers,
      });
      setPayload(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch payload");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPayload();
  }, [messages, systemPrompt, selectedServers]);

  // Loading state
  if (loading) {
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
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <RefreshCw className="h-5 w-5 animate-spin mx-auto text-muted-foreground" />
            <div className="text-sm text-muted-foreground mt-2">
              Loading payload...
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b border-border flex-shrink-0">
          <h2 className="text-xs font-semibold text-foreground">X-Ray</h2>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={fetchPayload}
              className="h-7 w-7"
              title="Retry"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
            {onClose && (
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7"
                title="Close X-Ray panel"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <AlertCircle className="h-5 w-5 mx-auto text-destructive" />
            <div className="text-sm text-destructive mt-2">{error}</div>
            <Button
              variant="outline"
              size="sm"
              onClick={fetchPayload}
              className="mt-3"
            >
              Retry
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (!payload) {
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
                <X className="h-3.5 w-3.5" />
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
          {/* Refresh button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchPayload}
            className="h-7 w-7"
            title="Refresh payload"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>

          {/* Copy button */}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => copyToClipboard(payload, "Model payload")}
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
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3">
          <pre className="overflow-auto whitespace-pre-wrap break-words text-xs bg-muted/20 p-3 font-mono">
            {JSON.stringify(payload, null, 2)}
          </pre>
        </div>
      </ScrollArea>
    </div>
  );
}
