/**
 * Raw trace panel — single JsonEditor with bordered chrome around the tree.
 *
 * With `requestPayloadHistory` (live chat, a reopened session, or a saved
 * session's persisted requests) Raw shows the resolved model request
 * (`system`, `tools`, `messages`) from the last entry, with `messages` merged
 * from the trace envelope when it is ahead of that request — so the reply to
 * the last request is visible, exactly as in the Playground. Otherwise it
 * shows the stored trace blob.
 */

import { Copy, Loader2, ScanSearch } from "lucide-react";
import type { ModelMessage } from "ai";
import { toast } from "@/lib/toast";
import { track } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { JsonEditor } from "@/components/ui/json-editor";
import { Button } from "@mcpjam/design-system/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";
import type { ResolvedModelRequestPayload } from "@/shared/model-request-payload";
import type { HarnessBuiltinToolInfo } from "@/hooks/useHarnessBuiltinTools";
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
 * A saved session's envelope is its full transcript, so the same merge shows the final reply there too.
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
  harnessBuiltinTools,
  fadeScrollEdges = false,
}: {
  trace: TraceEnvelope | TraceMessage | TraceMessage[] | null;
  requestPayloadHistory?: TraceRawRequestPayloadHistory | null;
  /** Parent owns scroll (e.g. StickToBottom); JSON height grows with payload. */
  growWithContent?: boolean;
  /**
   * Soften this view's top and bottom edges as it scrolls (`scroll-fade-y`),
   * so a cut-off line reads as "there is more" rather than as a pane that
   * stops mid-token.
   *
   * OPT-IN. Raw is rendered on every surface that shows a trace — eval runs,
   * the Playground's trace pane, a swarm session — and the surface that asked
   * for this is the session detail. Turning it on everywhere else is a call
   * their owners should make.
   *
   * Applies to the SCROLLING element, not the wrapper around it: the fade is a
   * scroll-driven animation reading `scroll(self y)`, so on a container that
   * never scrolls it would simply never animate.
   *
   * `growWithContent` branches take no fade — they have no scrollport of their
   * own, the page around them scrolls instead.
   */
  fadeScrollEdges?: boolean;
  /**
   * Harness native built-in tools. When set (a harness host), Raw annotates the
   * request: the harness builds its OWN model request inside the sandbox, so the
   * shown `tools` are empty — these run there instead. Only the playground Raw
   * surface (which knows the previewed host) passes this; it stays undefined for
   * chat / multi-model / eval-trace reuse.
   */
  harnessBuiltinTools?: HarnessBuiltinToolInfo[];
}) {
  const jsonHeight = growWithContent ? "auto" : "100%";
  const scrollerClass = cn(
    "flex-1 min-h-0 overflow-auto",
    fadeScrollEdges && "scroll-fade-y",
  );
  const requestPayloadEntries = requestPayloadHistory?.entries ?? [];
  const hasUiMessages = requestPayloadHistory?.hasUiMessages ?? false;
  const orderedEntries = requestPayloadEntries;
  const latestEntry = orderedEntries.at(-1) ?? null;

  // Compact, display-only note shown under the request JSON for harness hosts.
  // These execute inside the sandbox — schemas live in the Tools panel.
  const harnessAnnotation =
    harnessBuiltinTools && harnessBuiltinTools.length > 0 ? (
      <div className="mt-2 rounded-lg border border-border bg-muted/20 p-3">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          The harness builds its model request{" "}
          <span className="font-medium text-foreground">
            inside the sandbox
          </span>
          , so the <code className="font-mono">tools</code> above are empty
          here. Its native built-in tools (see the Trace tab for live calls):
        </p>
        <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1">
          {harnessBuiltinTools.map((t) => (
            <li key={t.key} className="text-[11px] leading-snug">
              <code className="font-mono text-foreground">{t.name}</code>
              {t.description ? (
                <span className="text-muted-foreground">
                  {" "}
                  — {t.description}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  if (requestPayloadHistory) {
    const hasLiveRequestLine = orderedEntries.length > 0 && latestEntry != null;

    if (hasLiveRequestLine && latestEntry) {
      const merged = mergeLiveRequestPayloadWithTraceSnapshot(
        latestEntry.payload,
        trace,
      );
      // A capped saved request lost its own copy of `messages`. When the
      // transcript stood in for it, the conversation shown is complete; when
      // it did not, say how many there were rather than show an empty list.
      const messagesDropped =
        latestEntry.messageCount !== undefined &&
        merged.messages === latestEntry.payload.messages;
      const { messages, ...requestConfig } = merged;
      const displayPayload = {
        ...requestConfig,
        ...(messagesDropped ? {} : { messages }),
        ...(orderedEntries.some((entry) => entry.truncated)
          ? { truncated: true }
          : {}),
        ...(messagesDropped ? { messageCount: latestEntry.messageCount } : {}),
      };

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
            {harnessAnnotation}
          </div>
        );
      }

      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <div className={scrollerClass}>
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
            {harnessAnnotation}
          </div>
        </div>
      );
    }

    if (!hasUiMessages) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <RawViewTraceStyleLoading />
        </div>
      );
    }

    // Rehydrated session: no `request_payload` replay, but we have thread messages — use `trace` below.
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
              track("trace_raw_copied", { location: "trace_raw_view" });
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

  // What this fallback can honestly say about the requests it is NOT showing.
  // A failed read is not "none were saved", and a read still in flight is
  // neither — so loading says nothing, and failure says it failed.
  const envelope =
    !Array.isArray(trace) && typeof trace === "object"
      ? (trace as TraceEnvelope)
      : null;
  const recordedContextNote = envelope?.requestPayloadsError ? (
    <p
      className="px-3 py-2 text-xs text-warning-foreground"
      data-testid="trace-raw-request-error"
    >
      {envelope.requestPayloadsError}; showing saved session evidence.
    </p>
  ) : envelope?.recordedContext && !envelope.requestPayloadsPending ? (
    <p
      className="px-3 py-2 text-xs text-muted-foreground"
      data-testid="trace-raw-recorded-context"
    >
      Saved session evidence; exact model requests are unavailable.
    </p>
  ) : null;

  if (growWithContent) {
    return (
      <div
        className="relative min-h-0 w-full min-w-0 flex-1"
        data-testid="trace-raw-view"
      >
        {recordedContextNote}
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
      {recordedContextNote}
      <div className={scrollerClass}>
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
