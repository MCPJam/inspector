/**
 * The Event section of the trace timeline's detail pane, shown on the prompt
 * row of a turn an MCP event started: the event's name, when it occurred, when
 * MCPJam received it and when the turn started, with the wait between each,
 * then its identifiers with a copy button for each. The rules behind every
 * value are in `trace-turn-event.ts`.
 */
import type { ReactNode } from "react";
import { Radio } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { CopyValueButton } from "@/components/connection/shared/CopyValueButton";
import type { EventAtTurn } from "@/shared/event-at-turn";
import {
  eventIdentifierRows,
  eventTimingView,
  isTestEvent,
  type LiveChatTraceTurnEvent,
} from "./trace-turn-event";

/** `Test` beside a test event's name; nothing for an event the server sent. */
export function TraceEventTestBadge({ event }: { event?: EventAtTurn }) {
  if (!event || !isTestEvent(event)) return null;
  return (
    <Badge
      variant="outline"
      data-testid="trace-event-test-badge"
      className="border-border/60 bg-muted/30 px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
      title="A test event, sent from MCPJam"
    >
      Test
    </Badge>
  );
}

export function TraceEventSection({
  turnEvent,
}: {
  turnEvent: LiveChatTraceTurnEvent;
}) {
  const { event } = turnEvent;
  const timing = eventTimingView(event, turnEvent.turnStartedAtMs);
  const identifiers = eventIdentifierRows(event);
  return (
    <section
      data-testid="trace-event-section"
      aria-label="Event"
      className="space-y-3 rounded-md border border-border/50 px-3 py-3 text-xs"
    >
      <div className="flex min-w-0 items-center gap-2">
        <Radio className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          Event
        </span>
        <span
          className="min-w-0 truncate font-mono text-xs font-medium text-foreground"
          title={event.name}
        >
          {event.name}
        </span>
        <TraceEventTestBadge event={event} />
      </div>

      <div data-testid="trace-event-timing">
        {timing.stops.map((stop, index) => (
          <div key={stop.key}>
            {index > 0 ? (
              <div
                className="flex min-h-4 items-stretch gap-3 text-[11px] tabular-nums text-muted-foreground"
                data-testid={`trace-event-wait-${stop.key}`}
              >
                <span className="flex w-[11px] shrink-0 justify-center" aria-hidden>
                  <span className="w-px bg-border" />
                </span>
                <span className="w-24 shrink-0" aria-hidden />
                <span className="self-center">
                  {stop.waitSincePrevious ? `+${stop.waitSincePrevious}` : null}
                </span>
              </div>
            ) : null}
            <EventRow
              marker={
                <span className="block size-[11px] rounded-full border border-border bg-background" />
              }
              label={stop.label}
            >
              <span
                data-testid={`trace-event-time-${stop.key}`}
                className={
                  stop.asSent
                    ? "break-all font-mono text-foreground"
                    : "tabular-nums text-foreground"
                }
              >
                {stop.value}
              </span>
            </EventRow>
          </div>
        ))}
        {timing.totalWait ? (
          <div className="pt-2">
            <EventRow label="Total wait">
              <span
                data-testid="trace-event-total-wait"
                className="font-medium tabular-nums text-foreground"
              >
                {timing.totalWait}
              </span>
            </EventRow>
          </div>
        ) : null}
      </div>

      {identifiers.length > 0 ? (
        <div
          data-testid="trace-event-identifiers"
          className="space-y-1 border-t border-border/40 pt-3"
        >
          {identifiers.map((row) => (
            <EventRow key={row.label} label={row.label}>
              <span className="flex min-w-0 items-center gap-1">
                <span
                  className={
                    row.copySubject
                      ? "min-w-0 truncate font-mono text-foreground"
                      : "min-w-0 truncate text-foreground"
                  }
                  title={row.value}
                >
                  {row.value}
                </span>
                {row.copySubject ? (
                  <CopyValueButton
                    value={row.value}
                    subject={row.copySubject}
                    size="inline"
                  />
                ) : null}
              </span>
            </EventRow>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** A label and its value, after the timing column's marker (or its width). */
function EventRow({
  marker,
  label,
  children,
}: {
  marker?: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex w-[11px] shrink-0 justify-center" aria-hidden>
        {marker}
      </span>
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}
