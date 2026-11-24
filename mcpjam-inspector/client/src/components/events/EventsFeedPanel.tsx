import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@mcpjam/design-system/collapsible";
import { cn } from "@mcpjam/design-system/cn";
import { ChevronRight } from "lucide-react";
import type {
  EventsFeedEntryView,
  EventsRejectionView,
} from "@/shared/events-api";
import type { EventsFeedStatus } from "./use-events-feed";
import { describeTermination, formatTime, safeJson } from "./event-utils";

const STATUS_LABELS: Record<EventsFeedStatus, string> = {
  idle: "Idle",
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  polling: "Polling",
  error: "Disconnected",
};

export function FeedStatusBadge({ status }: { status: EventsFeedStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
        status === "live"
          ? "border-success/40 bg-success/10 text-foreground"
          : status === "error"
            ? "border-destructive/40 bg-destructive/10 text-destructive"
            : "border-pending/40 bg-pending/10 text-foreground",
      )}
      data-testid="feed-status"
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Event data is untrusted: it is rendered as escaped TEXT (React text node in
 * a `<pre>`), never parsed as markdown or HTML.
 */
export function EventDataView({ data }: { data: unknown }) {
  if (data === undefined) return null;
  return (
    <pre
      className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-[11px] text-foreground"
      data-testid="event-data"
    >
      {safeJson(data)}
    </pre>
  );
}

function Flag({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <span
      className="rounded-sm border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
      title={title}
    >
      {children}
    </span>
  );
}

export function EventOccurrenceDetails({
  entry,
  subscriptionLabel,
}: {
  entry: EventsFeedEntryView;
  subscriptionLabel?: string;
}) {
  return (
    <Collapsible asChild defaultOpen>
    <li className="border-b border-border last:border-b-0" data-testid="feed-entry">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 py-3 text-left text-xs">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="min-w-0 flex-1 break-all font-mono font-medium">{entry.name ?? entry.kind}</span>
        {entry.namespace !== "live" ? (
          <span className="text-[10px] text-muted-foreground" data-testid="namespace-badge">Test</span>
        ) : null}
        {entry.idConflict ? <Flag title="The server sent a different subscription ID. The event was still recorded.">Subscription mismatch</Flag> : null}
        {entry.quarantined || entry.kind === "quarantined" ? <Flag title="The payload did not match the event schema; nothing was run.">Quarantined</Flag> : null}
        <span className="shrink-0 text-[10px] text-muted-foreground">{formatTime(entry.receivedAt)}</span>
      </CollapsibleTrigger>
      {entry.kind === "terminated" ? <TerminationLine error={entry.error} /> : entry.error ? (
        <p className="pb-2 text-[11px] text-destructive">{entry.error.code}: {entry.error.message}</p>
      ) : null}
      <CollapsibleContent className="space-y-3 pb-3 pl-5">
        <EventDataView data={entry.data} />
      <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-[10px] text-muted-foreground">
        {entry.eventId ? (
          <div>
            <dt className="inline">eventId </dt>
            <dd className="inline font-mono text-foreground">
              {entry.eventId}
            </dd>
          </div>
        ) : null}
        {entry.timestamp ? (
          <div>
            <dt className="inline">timestamp </dt>
            <dd className="inline font-mono">{entry.timestamp}</dd>
          </div>
        ) : null}
        {entry.cursor ? (
          <div>
            <dt className="inline">cursor </dt>
            <dd className="inline font-mono">{entry.cursor}</dd>
          </div>
        ) : null}
        {entry.dispatch ? (
          <div>
            <dt className="inline">dispatch </dt>
            <dd className="inline font-mono">
              {entry.dispatch}
              {entry.dispatchOutcome ? ` (${entry.dispatchOutcome})` : ""}
            </dd>
          </div>
        ) : null}
        {subscriptionLabel ? (
          <div>
            <dt className="inline">subscription </dt>
            <dd className="inline font-mono">{subscriptionLabel}</dd>
          </div>
        ) : null}
      </dl>
      </CollapsibleContent>
    </li>
    </Collapsible>
  );
}

function TerminationLine({ error }: { error: EventsFeedEntryView["error"] }) {
  const reason = describeTermination(error);
  return (
    <p className="text-[11px] text-foreground" data-testid="termination-reason">
      <span className="font-medium">{reason.label}</span>
      {reason.hint ? ` · ${reason.hint}` : ""}
      {error ? (
        <span className="font-mono text-muted-foreground"> ({error.code})</span>
      ) : null}
    </p>
  );
}

export function RejectionsPanel({
  rejections,
}: {
  rejections: EventsRejectionView[];
}) {
  if (rejections.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No rejected deliveries. Deliveries with a bad signature, a stale
        timestamp, or an unknown or expired subscription appear here.
      </p>
    );
  }
  return (
    <ul className="space-y-1" data-testid="rejections">
      {rejections.map((rejection, index) => (
        <li
          key={`${rejection.at}-${index}`}
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border py-1.5 text-[11px] last:border-b-0"
        >
          <span className="font-mono font-medium text-destructive">
            {rejection.reason}
          </span>
          {rejection.slotId ? (
            <span className="font-mono text-muted-foreground">
              slot {rejection.slotId}
            </span>
          ) : null}
          <span className="text-muted-foreground">
            {rejection.bodyBytes} bytes
          </span>
          {rejection.headerNames.length > 0 ? (
            <span className="font-mono text-muted-foreground">
              headers: {rejection.headerNames.join(", ")}
            </span>
          ) : null}
          <span className="ml-auto text-[10px] text-muted-foreground">
            {formatTime(rejection.at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
