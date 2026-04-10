/**
 * Raw trace panel — single JsonEditor with bordered chrome around the tree.
 * When `requestPayloadHistory` is provided (live chat), Raw shows the resolved model request payload
 * (`system`, `tools`, `messages`). Otherwise shows the stored trace blob (evals / offline).
 */

import { useEffect, useMemo, useState } from "react";
import { Copy, Loader2, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { JsonEditor } from "@/components/ui/json-editor";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { LiveChatTraceRequestPayloadEntry } from "@/shared/live-chat-trace";
import type { TraceEnvelope, TraceMessage } from "./trace-viewer-adapter";

export interface TraceRawRequestPayloadHistory {
  entries: LiveChatTraceRequestPayloadEntry[];
  hasUiMessages: boolean;
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
  const jsonHeight = growWithContent ? "auto" : "100%";
  const requestPayloadEntries = requestPayloadHistory?.entries ?? [];
  const hasUiMessages = requestPayloadHistory?.hasUiMessages ?? false;
  const orderedEntries = requestPayloadEntries;
  const entryKeysSignature = useMemo(
    () =>
      orderedEntries
        .map((entry) => `${entry.turnId}:${entry.stepIndex}`)
        .join("|"),
    [orderedEntries],
  );
  const latestEntry = orderedEntries.at(-1) ?? null;
  const latestEntryKey = latestEntry
    ? `${latestEntry.turnId}:${latestEntry.stepIndex}`
    : null;
  const [selectedEntryKey, setSelectedEntryKey] = useState<string | null>(
    latestEntryKey,
  );

  useEffect(() => {
    setSelectedEntryKey(latestEntryKey);
  }, [entryKeysSignature, latestEntryKey]);

  if (requestPayloadHistory) {
    if (!hasUiMessages || orderedEntries.length === 0 || !selectedEntryKey) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <RawViewTraceStyleLoading />
        </div>
      );
    }

    const selectedEntry =
      orderedEntries.find(
        (entry) => `${entry.turnId}:${entry.stepIndex}` === selectedEntryKey,
      ) ?? latestEntry;

    if (!selectedEntry) {
      return (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden w-full"
          data-testid="trace-raw-view"
        >
          <RawViewTraceStyleLoading />
        </div>
      );
    }

    const payloadToolbar = (
      <div className="flex items-center justify-end gap-2 px-2 pb-2">
        {orderedEntries.length > 1 ? (
          <Select
            value={selectedEntryKey}
            onValueChange={(value) => setSelectedEntryKey(value)}
          >
            <SelectTrigger
              className="h-8 w-[190px] text-xs"
              aria-label="Select request payload"
            >
              <SelectValue placeholder="Latest request" />
            </SelectTrigger>
            <SelectContent align="end">
              {orderedEntries.map((entry) => {
                const entryKey = `${entry.turnId}:${entry.stepIndex}`;
                const label = `Turn ${entry.promptIndex + 1} · Step ${
                  entry.stepIndex + 1
                }`;
                return (
                  <SelectItem
                    key={entryKey}
                    value={entryKey}
                    className="text-xs"
                  >
                    {label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={() =>
                copyToClipboard(selectedEntry.payload, "Request payload")
              }
              className="h-7 w-7"
              aria-label="Copy request payload"
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Copy request payload</TooltipContent>
        </Tooltip>
      </div>
    );

    if (growWithContent) {
      return (
        <div
          className="flex min-h-0 w-full min-w-0 flex-1 flex-col"
          data-testid="trace-raw-view"
        >
          {payloadToolbar}
          <div className="min-h-0 flex-1">
            <JsonEditor
              height={jsonHeight}
              value={selectedEntry.payload}
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
        {payloadToolbar}
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="relative min-h-0 rounded-lg border border-border bg-muted/20">
            <JsonEditor
              height={jsonHeight}
              value={selectedEntry.payload}
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
