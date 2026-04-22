/**
 * Raw trace panel — single JsonEditor with bordered chrome around the tree.
 * When `requestPayloadHistory` is provided (live chat), Raw shows the resolved model request payload
 * (`system`, `tools`, `messages`). `messages` are merged with `trace.messages` from the live envelope
 * when the snapshot (post-turn) is ahead of the last captured request, so the panel matches Chat/Trace
 * as soon as the assistant finishes — not only after the next user message. Otherwise shows the stored
 * trace blob (evals / offline).
 */

import { Copy, Loader2, ScanSearch } from "lucide-react";
import type { ModelMessage } from "ai";
import { toast } from "sonner";
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
import { JsonEditor } from "@/components/ui/json-editor";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";
import type { ResolvedModelRequestPayload } from "@/shared/model-request-payload";
import type { TraceEnvelope, TraceMessage } from "./trace-viewer-adapter";

export interface TraceRawRequestPayloadHistory {
  entries: LiveChatTraceRequestPayloadEntry[];
  hasUiMessages: boolean;
}

function getTraceEnvelopeMessages(
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
): ModelMessage[] | null {
  if (!trace || Array.isArray(trace)) {
    return null;
  }
  if (
    typeof trace === "object" &&
    "messages" in trace &&
    Array.isArray((trace as { messages: unknown }).messages)
  ) {
    return (trace as { messages: ModelMessage[] }).messages;
  }
  return null;
}

/**
 * Last `request_payload` reflects the outgoing API call (no assistant text for the current turn yet).
 * `trace_snapshot` appends the assistant to the live envelope — merge so Raw stays in sync with Chat/Trace.
 */
function mergeLiveRequestPayloadWithTraceSnapshot(
  payload: ResolvedModelRequestPayload,
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null,
): ResolvedModelRequestPayload {
  const traceMessages = getTraceEnvelopeMessages(trace);
  if (!traceMessages || traceMessages.length === 0) {
    return payload;
  }

  if (traceMessages.length > payload.messages.length) {
    return { ...payload, messages: traceMessages };
  }
  if (traceMessages.length < payload.messages.length) {
    // New user turn: request line already has the new prompt; snapshot not updated yet.
    return payload;
  }

  return { ...payload, messages: traceMessages };
}

/** Same centered spinner as the trace timeline `TraceViewer` Suspense fallback. */
function RawViewTraceStyleLoading() {
  return (
    <div className="flex flex-1 justify-center py-8">
      <Loader2
        className="h-5 w-5 animate-spin text-muted-foreground"
        aria-hidden
      />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function copyToClipboard(data: unknown, label: string, onCopied?: () => void) {
  navigator.clipboard
    .writeText(typeof data === "string" ? data : JSON.stringify(data, null, 2))
    .then(() => {
      onCopied?.();
      toast.success(`${label} copied to clipboard`);
    })
    .catch(() => toast.error(`Failed to copy ${label}`));
}

export function TraceRawView({
  trace,
  requestPayloadHistory,
  growWithContent = false,
}: {
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null;
  requestPayloadHistory?: TraceRawRequestPayloadHistory | null;
  /** Parent owns scroll (e.g. StickToBottom); JSON height grows with payload. */
  growWithContent?: boolean;
}) {
  const posthog = usePostHog();
  const jsonHeight = growWithContent ? "auto" : "100%";
  const requestPayloadEntries = requestPayloadHistory?.entries ?? [];
  const hasUiMessages = requestPayloadHistory?.hasUiMessages ?? false;
  const orderedEntries = requestPayloadEntries;
  const latestEntry = orderedEntries.at(-1) ?? null;

  if (requestPayloadHistory) {
    if (!hasUiMessages || orderedEntries.length === 0 || !latestEntry) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <RawViewTraceStyleLoading />
        </div>
      );
    }

    const displayPayload = mergeLiveRequestPayloadWithTraceSnapshot(
      latestEntry.payload,
      trace,
    );

    if (growWithContent) {
      return (
        <div
          className="flex min-h-0 w-full min-w-0 flex-1 flex-col"
          data-testid="trace-raw-view"
        >
          <div className="min-h-0 flex-1">
            <JsonEditor
              height={jsonHeight}
              value={displayPayload}
              viewOnly
              collapsible
              collapseStringsAfterLength={100}
            />
          </div>
        </div>
      );
    }

    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
        data-testid="trace-raw-view"
      >
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="min-h-0 rounded-lg border border-border bg-muted/20">
            <JsonEditor
              height={jsonHeight}
              value={displayPayload}
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
            onClick={() => {
              posthog.capture(
                "trace_raw_copied",
                standardEventProps("trace_raw_view"),
              );
              copyToClipboard(trace, "Trace");
            }}
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
