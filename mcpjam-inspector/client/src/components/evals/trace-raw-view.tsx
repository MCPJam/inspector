/**
 * Raw trace panel — single JsonEditor with bordered chrome around the tree.
 * When `xRayMirror` is provided (live chat), Raw shows the resolved model request payload
 * (`system`, `tools`, `messages`). Otherwise shows the stored trace blob (evals / offline).
 */

import { AlertCircle, Copy, RefreshCw, ScanSearch } from "lucide-react";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";
import { JsonEditor } from "@/components/ui/json-editor";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { XRayPayloadResponse } from "@/lib/apis/mcp-xray-api";
import type { TraceEnvelope, TraceMessage } from "./trace-viewer-adapter";

export interface TraceRawXRayMirror {
  payload: XRayPayloadResponse | null;
  loading: boolean;
  error: string | null;
  refetch: () => void | Promise<void>;
  hasUiMessages: boolean;
}

function copyToClipboard(
  data: unknown,
  label: string,
  onCopied?: () => void,
) {
  navigator.clipboard
    .writeText(
      typeof data === "string" ? data : JSON.stringify(data, null, 2),
    )
    .then(() => {
      onCopied?.();
      toast.success(`${label} copied to clipboard`);
    })
    .catch(() => toast.error(`Failed to copy ${label}`));
}

export function TraceRawView({
  trace,
  xRayMirror,
  growWithContent = false,
}: {
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null;
  xRayMirror?: TraceRawXRayMirror | null;
  /** Parent owns scroll (e.g. StickToBottom); JSON height grows with payload. */
  growWithContent?: boolean;
}) {
  const posthog = usePostHog();
  const jsonHeight = growWithContent ? "auto" : "100%";

  if (xRayMirror) {
    const {
      payload,
      loading,
      error,
      refetch,
      hasUiMessages: hasUi,
    } = xRayMirror;

    if (!hasUi) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <ScanSearch className="h-7 w-7 text-primary/70" />
              </div>
              <div className="text-sm font-medium text-foreground mb-1">
                Nothing to inspect yet
              </div>
              <div className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                Start the conversation to see the exact JSON we send to the
                model—system prompt, tools, and messages.
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (loading && !payload) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
              <div className="text-sm text-muted-foreground">
                Building request snapshot…
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (error && !payload) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
                <AlertCircle className="h-6 w-6 text-destructive" />
              </div>
              <div className="text-sm font-medium text-foreground mb-1">
                Couldn&apos;t load the request payload
              </div>
              <div className="text-xs text-muted-foreground mb-3 max-w-sm mx-auto leading-relaxed">
                {error}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refetch()}
              >
                Try again
              </Button>
            </div>
          </div>
        </div>
      );
    }

    if (!payload) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center">
              <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <ScanSearch className="h-7 w-7 text-primary/70" />
              </div>
              <div className="text-sm font-medium text-foreground mb-1">
                Snapshot not ready
              </div>
              <div className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                Raw shows the live request body—system, tools, and messages. It
                updates a moment after you send; if you just messaged, wait a
                second or keep typing.
              </div>
            </div>
          </div>
        </div>
      );
    }

    const copyRow = (
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
        {loading && (
          <RefreshCw
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-hidden
          />
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                copyToClipboard(payload, "Model payload", () => {
                  posthog?.capture("xray_payload_copied", {
                    tool_count: Object.keys(payload.tools).length,
                    message_count: payload.messages.length,
                  });
                })
              }
              className="h-7 w-7"
              aria-label="Copy model payload"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy payload</TooltipContent>
        </Tooltip>
      </div>
    );

    if (growWithContent) {
      return (
        <div
          className="relative min-h-0 w-full min-w-0 flex-1"
          data-testid="trace-raw-view"
        >
          {copyRow}
          <JsonEditor
            height={jsonHeight}
            value={payload as object}
            viewOnly
            collapsible
            collapseStringsAfterLength={100}
          />
        </div>
      );
    }

    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
        data-testid="trace-raw-view"
      >
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="relative min-h-0 rounded-lg border border-border bg-muted/20">
            {copyRow}
            <JsonEditor
              height={jsonHeight}
              value={payload as object}
              viewOnly
              collapsible
              collapseStringsAfterLength={100}
              className="min-h-0"
            />
          </div>
        </div>
      </div>
    );
  }

  if (trace == null) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
        data-testid="trace-raw-view"
      >
        <div className="flex-1 flex items-center justify-center p-6">
          <div className="text-center">
            <div className="mx-auto w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mb-4">
              <ScanSearch className="h-7 w-7 text-primary/70" />
            </div>
            <div className="text-sm font-medium text-foreground mb-1">
              No trace JSON yet
            </div>
            <div className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
              Choose a run with recorded trace data, or finish this run to
              inspect the blob here.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const copyTraceBtn = (
    <div className="absolute top-2 right-2 z-10">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => copyToClipboard(trace, "Trace")}
            className="h-7 w-7"
            aria-label="Copy trace"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy trace</TooltipContent>
      </Tooltip>
    </div>
  );

  if (growWithContent) {
    return (
      <div
        className="relative min-h-0 w-full min-w-0 flex-1"
        data-testid="trace-raw-view"
      >
        {copyTraceBtn}
        <JsonEditor
          height={jsonHeight}
          value={trace}
          viewOnly
          collapsible
          collapseStringsAfterLength={100}
        />
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
      data-testid="trace-raw-view"
    >
      <div className="flex-1 min-h-0 overflow-auto">
        <div className="relative min-h-0 rounded-lg border border-border bg-muted/20">
          {copyTraceBtn}
          <JsonEditor
            height={jsonHeight}
            value={trace}
            viewOnly
            collapsible
            collapseStringsAfterLength={100}
            className="min-h-0"
          />
        </div>
      </div>
    </div>
  );
}
