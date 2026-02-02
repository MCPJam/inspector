/**
 * X-Ray Snapshot View Component
 *
 * Shows the actual payload sent to the AI model's generateText() call.
 * Fetches the real enhanced payload from the server to ensure accuracy.
 */

import { useEffect, useState } from "react";
import { Copy, X, RefreshCw, AlertCircle, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import type { UIMessage } from "ai";
import { JsonEditor } from "@/components/ui/json-editor";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
      setError(null);
    } catch (err) {
      // Only set error if we don't have existing payload to show
      if (!payload) {
        setError(
          err instanceof Error ? err.message : "Failed to fetch payload",
        );
      }
    } finally {
      setLoading(false);
    }
  };

  const hasMessages = messages.length > 0;

  useEffect(() => {
    if (hasMessages) {
      fetchPayload();
    } else {
      setLoading(false);
      setPayload(null);
    }
  }, [messages, systemPrompt, selectedServers, hasMessages]);

  // Shared header component
  const Header = ({
    showCopy = false,
    showLoading = false,
  }: {
    showCopy?: boolean;
    showLoading?: boolean;
  }) => (
    <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0 bg-muted/30">
      <div className="flex items-center gap-2">
        <ScanSearch className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-medium text-foreground">X-Ray View</h2>
        {showLoading && (
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex items-center gap-1">
        {showCopy && payload && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => copyToClipboard(payload, "Model payload")}
                className="h-7 w-7"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy payload</TooltipContent>
          </Tooltip>
        )}
        {onClose && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClose}
                className="h-7 w-7"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  );

  // Empty state - no messages yet
  if (!hasMessages) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <Header />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <ScanSearch className="h-7 w-7 text-primary/70" />
            </div>
            <div className="text-sm font-medium text-foreground mb-1">
              No messages yet
            </div>
            <div className="text-xs text-muted-foreground max-w-[220px]">
              Send a message to inspect the raw payload sent to the model
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Loading state - only show full-screen loading if no payload exists yet
  if (loading && !payload) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <Header showLoading />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-muted/50 flex items-center justify-center mb-4">
              <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
            <div className="text-sm text-muted-foreground">
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
        <Header />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
              <AlertCircle className="h-6 w-6 text-destructive" />
            </div>
            <div className="text-sm font-medium text-foreground mb-1">
              Failed to load
            </div>
            <div className="text-xs text-muted-foreground mb-3">{error}</div>
            <Button variant="outline" size="sm" onClick={fetchPayload}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Empty payload state
  if (!payload) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <Header />
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <ScanSearch className="h-7 w-7 text-primary/70" />
            </div>
            <div className="text-sm font-medium text-foreground mb-1">
              No payload data
            </div>
            <div className="text-xs text-muted-foreground">
              Send a message to see the AI request payload
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <Header showCopy showLoading={loading} />

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="p-4">
          <div className="rounded-lg border border-border bg-muted/20">
            <JsonEditor
              value={payload as object}
              viewOnly
              collapsible
              collapseStringsAfterLength={100}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
