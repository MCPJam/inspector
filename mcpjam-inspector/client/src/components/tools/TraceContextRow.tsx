import { useState } from "react";
import { ChevronDown, Waypoints } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { parseTraceparent, type TraceContext } from "@mcpjam/sdk/browser";
import { cn } from "@/lib/utils";

/**
 * The read half of OpenTelemetry trace-context propagation: when a
 * 2026-07-28 server puts `traceparent` (and optionally `tracestate` /
 * `baggage`) in a result's `_meta`, show the user which trace their call
 * belongs to so they can find it in their own tracing backend.
 *
 * Collapsed by default and reduced to the one field anybody pastes into a
 * trace search — the trace id. Span id, sampling, and the vendor lists sit
 * behind the expand.
 *
 * `baggage` is arbitrary server-authored key/value data. It is rendered
 * verbatim for debugging and goes NOWHERE else: it must never be attached to
 * a PostHog or Axiom payload.
 */
export function TraceContextRow({ context }: { context: TraceContext }) {
  const [open, setOpen] = useState(false);
  const parsed = parseTraceparent(context.traceparent);
  if (!parsed) {
    return null;
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex-shrink-0 rounded border border-border bg-muted/50"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 p-2 text-left">
        <Waypoints className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Trace</span>
        <span className="truncate font-mono text-xs text-foreground">
          {parsed.traceId}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border p-2 text-xs">
          <dt className="text-muted-foreground">Span</dt>
          <dd className="break-all font-mono">{parsed.spanId}</dd>
          <dt className="text-muted-foreground">Sampled</dt>
          <dd className="font-mono">{parsed.sampled ? "yes" : "no"}</dd>
          <dt className="text-muted-foreground">traceparent</dt>
          <dd className="break-all font-mono">{context.traceparent}</dd>
          {context.tracestate && (
            <>
              <dt className="text-muted-foreground">tracestate</dt>
              <dd className="break-all font-mono">{context.tracestate}</dd>
            </>
          )}
          {context.baggage && (
            <>
              <dt className="text-muted-foreground">baggage</dt>
              <dd className="break-all font-mono">{context.baggage}</dd>
            </>
          )}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
