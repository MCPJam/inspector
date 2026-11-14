/**
 * What happened to a submission in the directory, as people and agents
 * recorded it: its status changes and what the directory said. Events are
 * append-only, so the page only adds to them. A retry sends the same
 * idempotency key, and the server answers it from the first write.
 */
import { useCallback, useEffect, useState } from "react";
import {
  listSubmissionEvents,
  recordSubmissionEvent,
  type SubmissionEvent,
  type SubmissionEventBody,
  type SubmissionScope,
} from "@/lib/apis/directory-submissions-api";

/** As often as the submission itself is read. */
const REFRESH_MS = 15_000;

interface Events {
  status: SubmissionEvent[];
  /** The directory's own words, never merged with MCPJam's results. */
  findings: SubmissionEvent[];
}

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Newest first, and a replayed write in once. */
function withEvent(events: Events, event: SubmissionEvent): Events {
  const key = event.kind === "status" ? "status" : "findings";
  if (events[key].some((entry) => entry.id === event.id)) return events;
  const list = [event, ...events[key]].sort(
    (a, b) => b.createdAt - a.createdAt,
  );
  return { ...events, [key]: list };
}

/**
 * Events are never removed, so a read that left before a write landed adds
 * to what is shown instead of replacing it.
 */
const merge = (current: Events | null, more: readonly SubmissionEvent[]) =>
  more.reduce(withEvent, current ?? { status: [], findings: [] });

/** `enabled`: read and poll only while a page shows the events. */
export function useSubmissionEvents(
  { projectId, submissionId }: SubmissionScope,
  enabled = true,
) {
  const [events, setEvents] = useState<Events | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: AbortSignal) => {
      const scope = { projectId, submissionId };
      try {
        // One read per kind, so many events of one kind cannot push the
        // other off its page.
        const [status, findings] = await Promise.all([
          listSubmissionEvents(scope, "status", signal),
          listSubmissionEvents(scope, "directory-finding", signal),
        ]);
        if (signal.aborted) return;
        setEvents((current) => merge(current, [...status, ...findings]));
        setError(null);
      } catch (failure) {
        if (!signal.aborted) setError(messageOf(failure));
      }
    },
    [projectId, submissionId],
  );

  // Another submission's events never show under this one.
  useEffect(() => setEvents(null), [projectId, submissionId]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void load(controller.signal);
    const refresh = () => {
      if (!document.hidden) void load(controller.signal);
    };
    const interval = setInterval(refresh, REFRESH_MS);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, enabled]);

  /** Records each body in order; a refusal stops there and is thrown. */
  const record = useCallback(
    async (bodies: readonly SubmissionEventBody[]) => {
      for (const body of bodies) {
        const event = await recordSubmissionEvent(
          { projectId, submissionId },
          body,
        );
        setEvents((current) => merge(current, [event]));
      }
    },
    [projectId, submissionId],
  );

  const status = events?.status ?? [];
  const findings = events?.findings ?? [];
  return {
    status,
    findings,
    loaded: events !== null,
    error,
    record,
    /**
     * Changes when an event is recorded or a newer one is read: the newest
     * of each kind leads its list. A view built from the events, such as
     * the handoff summary, reads again when it changes.
     */
    version: `${status[0]?.id ?? ""}:${findings[0]?.id ?? ""}`,
  };
}

export type SubmissionEvents = ReturnType<typeof useSubmissionEvents>;
