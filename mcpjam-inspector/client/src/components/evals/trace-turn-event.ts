/**
 * What the trace timeline shows about the MCP event that started a turn: the
 * prompt row's label and the detail pane's Event section
 * (`trace-event-section.tsx`). Pure, so every rule here is tested without a
 * render.
 *
 * The event reaches a trace envelope as `turnEvents`, one entry per turn an
 * event started: from the live `turn_start` and the persisted turn traces in
 * the Playground (`useChatSession`), and from the turn rows in Sessions detail
 * (`turnEventsFromTurnTraces`).
 */
import {
  readEventAtTurn,
  type EventAtTurn,
  type EventDeliveryMode,
} from "@/shared/event-at-turn";
import {
  liveChatTraceTurnEvents,
  type LiveChatTraceTurnEvent,
} from "@/shared/live-chat-trace";
import { formatDuration } from "./helpers";
import { formatDurationMs } from "./metric-strip-data";

export type { LiveChatTraceTurnEvent };

/**
 * The envelope's `turnEvents`, keyed by prompt index. Each entry is read like
 * any other wire value: one that is not a valid event record is left out
 * rather than shown half-read.
 */
export function traceTurnEventsByPromptIndex(
  trace: unknown,
): Map<number, LiveChatTraceTurnEvent> | undefined {
  if (!trace || typeof trace !== "object" || Array.isArray(trace)) {
    return undefined;
  }
  const raw = (trace as { turnEvents?: unknown }).turnEvents;
  if (!Array.isArray(raw)) return undefined;
  const byPromptIndex = new Map<number, LiveChatTraceTurnEvent>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { promptIndex, turnStartedAtMs, event } = entry as Record<
      string,
      unknown
    >;
    const record = readEventAtTurn(event);
    if (typeof promptIndex !== "number" || !record) continue;
    byPromptIndex.set(promptIndex, {
      promptIndex,
      ...(isFiniteNumber(turnStartedAtMs) ? { turnStartedAtMs } : {}),
      event: record,
    });
  }
  return byPromptIndex.size > 0 ? byPromptIndex : undefined;
}

/** `turnEvents` for an envelope built from the backend's turn-trace rows. */
export function turnEventsFromTurnTraces(
  rows:
    | ReadonlyArray<{
        promptIndex: number;
        startedAt: number;
        eventAtTurn?: unknown;
      }>
    | undefined,
): LiveChatTraceTurnEvent[] {
  return liveChatTraceTurnEvents(
    (rows ?? []).map((row) => ({
      promptIndex: row.promptIndex,
      startedAtMs: row.startedAt,
      event: readEventAtTurn(row.eventAtTurn),
    })),
  );
}

/** The prompt row's label for a turn an event started. */
export function eventPromptLabel(event: EventAtTurn): string {
  return `Event: ${event.name}`;
}

/** A test event carries a `Test` badge. `replay` is reserved and has none yet. */
export function isTestEvent(event: EventAtTurn): boolean {
  return event.origin === "simulation";
}

/** One point on the way from the event to its turn. */
export type EventTimingStop = {
  key: "occurred" | "received" | "turn-started";
  label: string;
  /** A local clock time, or the server's `timestamp` as sent when it is not one. */
  value: string;
  /** The value is the server's text, shown as sent because it is not a time. */
  asSent?: true;
  /**
   * The wait since the stop before. Absent for the first stop, and whenever
   * either end has no time or the clocks disagree (a negative wait): the
   * three times come from three clocks, so a wait below zero says nothing.
   */
  waitSincePrevious?: string;
};

export type EventTimingView = {
  stops: EventTimingStop[];
  /** Occurred to Turn started, only when both waits along the way were shown. */
  totalWait?: string;
};

/**
 * Occurred (the server's `timestamp`), Received (MCPJam's clock, or the
 * browser's for a Playground test event) and Turn started (the Inspector
 * server's), with the wait between each.
 */
export function eventTimingView(
  event: EventAtTurn,
  turnStartedAtMs?: number,
  formatTime: (ms: number) => string = formatClockTime,
): EventTimingView {
  type Point = Pick<EventTimingStop, "key" | "label"> &
    ({ ms: number } | { asSent: string });
  const points: Point[] = [];
  if (event.timestamp !== undefined) {
    const occurredMs = parseEventTimestamp(event.timestamp);
    points.push(
      occurredMs === undefined
        ? { key: "occurred", label: "Occurred", asSent: event.timestamp }
        : { key: "occurred", label: "Occurred", ms: occurredMs },
    );
  }
  points.push({ key: "received", label: "Received", ms: event.receivedAt });
  if (isFiniteNumber(turnStartedAtMs)) {
    points.push({ key: "turn-started", label: "Turn started", ms: turnStartedAtMs });
  }

  const waits = points.map((point, index): number | undefined => {
    const previous = points[index - 1];
    if (!previous || !("ms" in previous) || !("ms" in point)) return undefined;
    const wait = point.ms - previous.ms;
    return wait >= 0 ? wait : undefined;
  });
  const stops = points.map((point, index): EventTimingStop => {
    const wait = waits[index];
    return {
      key: point.key,
      label: point.label,
      ...("ms" in point
        ? { value: formatTime(point.ms) }
        : { value: point.asSent, asSent: true as const }),
      ...(wait !== undefined ? { waitSincePrevious: formatWait(wait) } : {}),
    };
  });
  // A total only over all three stops, and only when both waits were shown.
  const [, firstWait, secondWait] = waits;
  return {
    stops,
    ...(points.length === 3 && firstWait !== undefined && secondWait !== undefined
      ? { totalWait: formatWait(firstWait + secondWait) }
      : {}),
  };
}

/** One identifier in the Event section; `copySubject` names it for its copy button. */
export type EventIdentifierRow = {
  label: string;
  value: string;
  copySubject?: string;
};

const DELIVERY_LABELS: Record<EventDeliveryMode, string> = {
  poll: "Poll",
  push: "Push",
  webhook: "Webhook",
};

export function eventIdentifierRows(event: EventAtTurn): EventIdentifierRow[] {
  const rows: EventIdentifierRow[] = [];
  if (event.eventId) {
    rows.push({ label: "Event ID", value: event.eventId, copySubject: "event ID" });
  }
  if (event.subscriptionId) {
    rows.push({
      label: "Subscription",
      value: event.subscriptionId,
      copySubject: "subscription ID",
    });
  }
  if (event.triggerId) {
    rows.push({ label: "Trigger", value: event.triggerId, copySubject: "trigger ID" });
  }
  if (event.delivery) {
    rows.push({ label: "Delivery", value: DELIVERY_LABELS[event.delivery] });
  }
  return rows;
}

/**
 * The server's `timestamp` in epoch ms, or `undefined` when it is not a date
 * and time `Date.parse` can read. A bare date or a bare time is not read as
 * one: either would place the event at a moment the server never said. Nor is
 * a day the month does not have, which `Date.parse` rolls over (February 30
 * would read as March 2).
 */
export function parseEventTimestamp(timestamp: string): number | undefined {
  const date = /(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}/.exec(timestamp);
  if (!date || !isCalendarDate(Number(date[1]), Number(date[2]), Number(date[3]))) {
    return undefined;
  }
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Whether the date as written exists. Checked on the written fields, not on
 * the parsed instant, which an offset can move into another day.
 */
function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(0);
  // `setUTCFullYear`, not `Date.UTC`, which reads years 0 to 99 as 1900s.
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatClockTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

/** Under a minute, the timeline's own latency format; above it, minutes and seconds. */
function formatWait(ms: number): string {
  const rounded = Math.round(ms);
  return rounded < 60_000 ? formatDurationMs(rounded) : formatDuration(rounded);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
