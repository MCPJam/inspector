import { Badge } from "@mcpjam/design-system/badge";
import { cn } from "@mcpjam/design-system/cn";
import { AlertTriangle, Inbox } from "lucide-react";
import type {
  EventsFeedEntryView,
  EventsRejectionView,
} from "@/shared/events-api";
import type { EventsFeedGap, EventsFeedStatus } from "./use-events-feed";
import { formatTime, safeJson } from "./event-utils";

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

function FeedEntryRow({
  entry,
  subscriptionLabel,
}: {
  entry: EventsFeedEntryView;
  subscriptionLabel?: string;
}) {
  const isEvent = entry.kind === "event";
  return (
    <li
      className="space-y-1.5 border-b border-border py-2 last:border-b-0"
      data-testid="feed-entry"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className="font-mono text-muted-foreground">#{entry.seq}</span>
        <Badge
          variant={isEvent ? "secondary" : "outline"}
          className="font-mono text-[10px]"
        >
          {entry.kind}
        </Badge>
        {entry.name ? (
          <span className="font-mono font-semibold text-foreground">
            {entry.name}
          </span>
        ) : null}
        <span className="text-muted-foreground">via {entry.origin}</span>
        {entry.namespace !== "live" ? (
          <span
            className="rounded-sm border border-info/40 bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
            data-testid="namespace-badge"
          >
            {entry.namespace}
          </span>
        ) : null}
        {entry.idConflict ? (
          <Flag title="Delivered under a server subscription id that differs from the reconciled one.">
            ID conflict
          </Flag>
        ) : null}
        {entry.webhookIdMismatch ? (
          <Flag title="The webhook-id header did not match the event id.">
            webhook-id mismatch
          </Flag>
        ) : null}
        {entry.quarantined || entry.kind === "quarantined" ? (
          <Flag title="The payload did not match the event's payload schema; nothing was run.">
            Quarantined
          </Flag>
        ) : null}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {formatTime(entry.receivedAt)}
        </span>
      </div>
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
      {entry.error ? (
        <p className="text-[11px] text-destructive">
          {entry.error.code}: {entry.error.message}
        </p>
      ) : null}
      {entry.data !== undefined ? (
        <details open={isEvent}>
          <summary className="cursor-pointer text-[10px] text-muted-foreground">
            Data (untrusted)
          </summary>
          <div className="mt-1">
            <EventDataView data={entry.data} />
          </div>
        </details>
      ) : null}
    </li>
  );
}

export function EventsFeedPanel({
  entries,
  gaps,
  status,
  error,
  labelFor,
}: {
  /** Oldest first; rendered newest first. */
  entries: EventsFeedEntryView[];
  gaps: EventsFeedGap[];
  status: EventsFeedStatus;
  error: string | null;
  labelFor: (entry: EventsFeedEntryView) => string | undefined;
}) {
  const newestFirst = [...entries].reverse();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <FeedStatusBadge status={status} />
        {error ? (
          <span className="text-[11px] text-destructive">{error}</span>
        ) : null}
      </div>
      {gaps.map((gap) => (
        <p
          key={`${gap.fromSeq}-${gap.toSeq}`}
          className="flex items-center gap-1.5 rounded-md border border-warning/40 bg-warning/10 p-2 text-[11px] text-foreground"
        >
          <AlertTriangle className="h-3.5 w-3.5 text-warning" />
          Entries #{gap.fromSeq} to #{gap.toSeq} are no longer in the inbox's
          history.
        </p>
      ))}
      {newestFirst.length === 0 ? (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Inbox className="h-4 w-4" />
          No deliveries yet. Events appear here as the inbox journals them.
        </div>
      ) : (
        <ul>
          {newestFirst.map((entry) => (
            <FeedEntryRow
              key={entry.seq}
              entry={entry}
              subscriptionLabel={labelFor(entry)}
            />
          ))}
        </ul>
      )}
    </div>
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
        No rejected deliveries. A delivery with a bad signature, a stale
        timestamp, or an unknown or expired slot shows up here.
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
