import { useCallback, useEffect, useRef, useState } from "react";
import type {
  EventsFeedEntryView,
  EventsRejectionView,
  EventsStreamFrame,
  EventsSubscriptionView,
  EventsViewerTokenResponse,
} from "@/shared/events-api";
import {
  eventsErrorCode,
  fetchEventsViewerToken,
  fetchHostedEventsFeed,
  fetchLocalEventsFeed,
  hostedEventsStreamUrl,
  localEventsStreamUrl,
  normalizeFeedEntry,
  parseGap,
} from "@/lib/apis/mcp-events-api";

/** Entries kept in memory for the feed view (newest win). */
export const MAX_FEED_ENTRIES = 500;
const MAX_REJECTIONS = 100;
/** Stream attempts that never open before falling back to JSON polling. */
const MAX_STREAM_FAILURES_BEFORE_POLLING = 3;
const POLL_INTERVAL_MS = 3000;
/** Reconnect with a fresh viewer token this long before the old one expires. */
const TOKEN_REFRESH_LEAD_MS = 30_000;
const MIN_TOKEN_REFRESH_DELAY_MS = 5_000;

export type EventsFeedStatus =
  "idle" | "connecting" | "live" | "reconnecting" | "polling" | "error";

export interface EventsFeedGap {
  fromSeq: number;
  toSeq: number;
  at: number;
}

export interface UseEventsFeedOptions {
  hosted: boolean;
  projectId: string | null;
  enabled: boolean;
  /** Called once per entry the first time it is seen. */
  onNewEntries?: (entries: EventsFeedEntryView[]) => void;
  /** Local stream: the full subscription list (all servers) on (re)connect. */
  onSubscriptionsSnapshot?: (subscriptions: EventsSubscriptionView[]) => void;
  /** Local stream: one subscription changed. */
  onSubscription?: (subscription: EventsSubscriptionView) => void;
}

export interface EventsFeed {
  entries: EventsFeedEntryView[];
  rejections: EventsRejectionView[];
  gaps: EventsFeedGap[];
  status: EventsFeedStatus;
  error: string | null;
  /** Feed an entry the caller already has (a local simulation's response). */
  ingestEntries: (entries: EventsFeedEntryView[]) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The events feed: journal entries as they arrive, plus rejected deliveries
 * and gaps.
 *
 * LOCAL: one EventSource on `/api/mcp/events/stream`, whose frames are
 * `EventsStreamFrame`s (snapshot / entry / subscription / rejection).
 *
 * HOSTED: the public inbox, read with a viewer token of at most 10 minutes
 * (contract C7). Unnamed messages are one entry each; named events carry
 * `gap`, `dispatch` (a dispatch-state update), and `resync` / `expired` /
 * `revoked`, all three answered by reconnecting from the last seq (the last
 * two with a fresh token). The stream is also re-opened with a fresh token
 * shortly before the current one expires. If the stream keeps failing before
 * it ever opens, the hook falls back to polling the JSON backlog with
 * `Authorization: Bearer`.
 *
 * Entries are deduplicated by `seq`, so a replayed backlog after any
 * reconnect is harmless.
 */
export function useEventsFeed(options: UseEventsFeedOptions): EventsFeed {
  const { hosted, projectId, enabled } = options;
  const [entries, setEntries] = useState<EventsFeedEntryView[]>([]);
  const [rejections, setRejections] = useState<EventsRejectionView[]>([]);
  const [gaps, setGaps] = useState<EventsFeedGap[]>([]);
  const [status, setStatus] = useState<EventsFeedStatus>("idle");
  const [error, setError] = useState<string | null>(null);

  const seenRef = useRef(new Set<number>());
  const afterRef = useRef(0);
  const feedKeyRef = useRef<string | null>(null);
  const callbacksRef = useRef(options);
  callbacksRef.current = options;

  const ingestEntries = useCallback((incoming: EventsFeedEntryView[]) => {
    const fresh: EventsFeedEntryView[] = [];
    for (const entry of incoming) {
      if (seenRef.current.has(entry.seq)) continue;
      seenRef.current.add(entry.seq);
      afterRef.current = Math.max(afterRef.current, entry.seq);
      fresh.push(entry);
    }
    if (fresh.length === 0) return;
    fresh.sort((a, b) => a.seq - b.seq);
    setEntries((previous) => {
      const next = [...previous, ...fresh].sort((a, b) => a.seq - b.seq);
      return next.length > MAX_FEED_ENTRIES
        ? next.slice(next.length - MAX_FEED_ENTRIES)
        : next;
    });
    callbacksRef.current.onNewEntries?.(fresh);
  }, []);

  const addGap = useCallback((gap: { fromSeq: number; toSeq: number }) => {
    setGaps((previous) =>
      previous.some((g) => g.fromSeq === gap.fromSeq && g.toSeq === gap.toSeq)
        ? previous
        : [...previous, { ...gap, at: Date.now() }],
    );
  }, []);

  const applyDispatchUpdate = useCallback((raw: unknown) => {
    if (!isRecord(raw) || typeof raw.seq !== "number") return;
    const state =
      typeof raw.dispatchState === "string"
        ? raw.dispatchState
        : typeof raw.dispatch === "string"
          ? raw.dispatch
          : undefined;
    const outcome =
      typeof raw.dispatchOutcome === "string"
        ? raw.dispatchOutcome
        : typeof raw.outcome === "string"
          ? raw.outcome
          : undefined;
    setEntries((previous) =>
      previous.map((entry) =>
        entry.seq === raw.seq
          ? {
              ...entry,
              ...(state !== undefined ? { dispatch: state } : {}),
              ...(outcome !== undefined ? { dispatchOutcome: outcome } : {}),
            }
          : entry,
      ),
    );
  }, []);

  // A different feed (mode or project) starts from scratch.
  // The local runtime has one inbox; hosted has one per project.
  const feedKey = hosted ? `hosted:${projectId ?? ""}` : "local";
  if (feedKeyRef.current !== feedKey) {
    feedKeyRef.current = feedKey;
    seenRef.current = new Set();
    afterRef.current = 0;
  }
  useEffect(() => {
    setEntries([]);
    setRejections([]);
    setGaps([]);
    setError(null);
  }, [feedKey]);

  // ── local: EventsStreamFrame SSE ─────────────────────────────────────────
  useEffect(() => {
    if (!enabled || hosted) return;
    let disposed = false;

    const handleFrame = (raw: unknown) => {
      if (!isRecord(raw)) return;
      const frame = raw as Partial<EventsStreamFrame> & Record<string, unknown>;
      switch (frame.type) {
        case "snapshot":
          if (Array.isArray(frame.subscriptions)) {
            callbacksRef.current.onSubscriptionsSnapshot?.(
              frame.subscriptions as EventsSubscriptionView[],
            );
          }
          return;
        case "entry": {
          const entry = normalizeFeedEntry(frame.entry);
          if (entry) ingestEntries([entry]);
          return;
        }
        case "subscription":
          if (isRecord(frame.subscription)) {
            callbacksRef.current.onSubscription?.(
              frame.subscription as unknown as EventsSubscriptionView,
            );
          }
          return;
        case "rejection":
          if (isRecord(frame.rejection)) {
            const rejection = frame.rejection as unknown as EventsRejectionView;
            setRejections((previous) =>
              [rejection, ...previous].slice(0, MAX_REJECTIONS),
            );
          }
          return;
        default: {
          const entry = normalizeFeedEntry(raw);
          if (entry) ingestEntries([entry]);
        }
      }
    };

    // No EventSource (SSR, a test without a stub): poll the JSON backlog.
    if (typeof EventSource === "undefined") {
      setStatus("polling");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = async () => {
        try {
          const page = await fetchLocalEventsFeed(afterRef.current);
          if (disposed) return;
          ingestEntries(page.entries);
          afterRef.current = Math.max(afterRef.current, page.nextAfter);
          setError(null);
        } catch (err) {
          if (!disposed) setError(errorMessage(err, "Feed unavailable"));
        }
        if (!disposed) timer = setTimeout(tick, POLL_INTERVAL_MS);
      };
      void tick();
      return () => {
        disposed = true;
        if (timer) clearTimeout(timer);
      };
    }

    setStatus("connecting");
    const source = new EventSource(localEventsStreamUrl(afterRef.current));
    source.onopen = () => {
      setStatus("live");
      setError(null);
    };
    source.onmessage = (event: MessageEvent) => {
      setStatus("live");
      handleFrame(parseData(event.data));
    };
    // The browser reconnects a local stream by itself; the replayed backlog
    // is deduplicated by seq.
    source.onerror = () => {
      if (!disposed) setStatus("reconnecting");
    };
    return () => {
      disposed = true;
      source.close();
    };
  }, [enabled, hosted, ingestEntries]);

  // ── hosted: the public inbox, viewer-token authenticated ─────────────────
  useEffect(() => {
    if (!enabled || !hosted || !projectId) return;
    let disposed = false;
    let source: EventSource | null = null;
    let timers: Array<ReturnType<typeof setTimeout>> = [];
    let token: EventsViewerTokenResponse | null = null;
    let failuresWithoutOpen = 0;
    // Viewer-token failures back off on their own count: they say nothing
    // about whether a stream would open, so they must not push the feed onto
    // polling, which has no way back to the live stream.
    let tokenFailures = 0;

    const later = (fn: () => void, ms: number) => {
      timers.push(setTimeout(fn, ms));
    };
    const clearTimers = () => {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
    };
    const closeStream = () => {
      if (source) {
        source.close();
        source = null;
      }
    };
    const getToken = async (fresh: boolean) => {
      if (
        !fresh &&
        token &&
        token.expiresAt - Date.now() > MIN_TOKEN_REFRESH_DELAY_MS
      ) {
        return token;
      }
      token = await fetchEventsViewerToken(projectId);
      return token;
    };

    const startPolling = () => {
      setStatus("polling");
      const tick = async () => {
        if (disposed) return;
        try {
          const current = await getToken(false);
          const page = await fetchHostedEventsFeed({
            feedUrl: current.feedUrl,
            token: current.token,
            after: afterRef.current,
          });
          if (disposed) return;
          if (page.gap) addGap(page.gap);
          ingestEntries(page.entries);
          afterRef.current = Math.max(afterRef.current, page.nextAfter);
          setError(null);
        } catch (err) {
          if (disposed) return;
          // Expired or revoked: the next tick fetches a new token.
          if (eventsErrorCode(err) === "unauthorized") token = null;
          else setError(errorMessage(err, "Feed unavailable"));
        }
        if (!disposed) later(() => void tick(), POLL_INTERVAL_MS);
      };
      void tick();
    };

    const connect = async (freshToken: boolean) => {
      clearTimers();
      closeStream();
      if (disposed) return;
      setStatus((previous) =>
        previous === "live" ? "reconnecting" : "connecting",
      );
      let current: EventsViewerTokenResponse;
      try {
        current = await getToken(freshToken);
        tokenFailures = 0;
      } catch (err) {
        if (disposed) return;
        setStatus("error");
        setError(errorMessage(err, "Could not authorize the feed"));
        tokenFailures += 1;
        later(() => void connect(true), Math.min(30_000, 2000 * tokenFailures));
        return;
      }
      if (disposed) return;
      if (
        typeof EventSource === "undefined" ||
        failuresWithoutOpen >= MAX_STREAM_FAILURES_BEFORE_POLLING
      ) {
        startPolling();
        return;
      }

      let opened = false;
      const stream = new EventSource(
        hostedEventsStreamUrl(
          current.streamUrl,
          afterRef.current,
          current.token,
        ),
      );
      source = stream;
      const markOpen = () => {
        opened = true;
        failuresWithoutOpen = 0;
        setStatus("live");
        setError(null);
      };
      stream.onopen = markOpen;
      stream.onmessage = (event: MessageEvent) => {
        if (!opened) markOpen();
        const entry = normalizeFeedEntry(parseData(event.data));
        if (entry) ingestEntries([entry]);
      };
      const on = (name: string, handler: (data: unknown) => void) => {
        stream.addEventListener?.(name, (event: Event) => {
          if (source !== stream || disposed) return;
          handler(parseData((event as MessageEvent).data));
        });
      };
      on("gap", (data) => {
        const gap = parseGap(data);
        if (gap) addGap(gap);
      });
      on("dispatch", applyDispatchUpdate);
      // The inbox asks for a resync from our last seq; the token still holds.
      on("resync", () => void connect(false));
      // Token expired, or the viewer epoch was bumped: re-authorize (which
      // re-runs the membership check) and continue from the last seq.
      on("expired", () => void connect(true));
      on("revoked", () => void connect(true));
      stream.onerror = () => {
        if (source !== stream || disposed) return;
        closeStream();
        if (!opened) failuresWithoutOpen += 1;
        setStatus("reconnecting");
        later(
          () => void connect(true),
          opened ? 1000 : Math.min(30_000, 2000 * failuresWithoutOpen),
        );
      };
      // Tokens are short-lived; switch to a fresh one before the inbox closes
      // the stream on us.
      later(
        () => void connect(true),
        Math.max(
          MIN_TOKEN_REFRESH_DELAY_MS,
          current.expiresAt - Date.now() - TOKEN_REFRESH_LEAD_MS,
        ),
      );
    };

    void connect(true);
    return () => {
      disposed = true;
      clearTimers();
      closeStream();
    };
  }, [enabled, hosted, projectId, ingestEntries, addGap, applyDispatchUpdate]);

  return { entries, rejections, gaps, status, error, ingestEntries };
}
