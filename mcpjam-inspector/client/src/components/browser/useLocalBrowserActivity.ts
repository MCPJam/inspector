import { useCallback, useEffect, useRef, useState } from "react";
import {
  listLocalBrowserSessions,
  readLocalBrowserTrace,
  type LocalBrowserTraceEntry,
} from "@/lib/local-browser/client";

/**
 * What drove the browser, as a log source.
 *
 * POLLED, not streamed. The frames socket carries pixels and would have to grow
 * a second record kind to carry these; polling with the last `seq` seen is one
 * small request per tick, costs nothing while nothing is happening, and cannot
 * lag a slow client out of a broadcast the way the frame stream can.
 */
const POLL_INTERVAL_MS = 2_000;
/**
 * How many quiet ticks before the pane asks which session it should be reading.
 *
 * It resolves a session once and then follows it, which is right while that
 * session is the live one and wrong the moment it ends: a closed session's
 * trace still reads perfectly, so an agent that closed one and opened another
 * left the pane showing a history that had stopped moving, with nothing on
 * screen to say it was watching the wrong browser. Asking again is one small
 * request, and only when nothing is arriving — a session that is producing
 * rows is self-evidently the one to read.
 */
const REDISCOVER_AFTER_QUIET_TICKS = 15;
/**
 * The session this pane may follow: an OPEN, PERSISTENT one.
 *
 * The Browser tab's frames come from the project's persistent browser, so that
 * is the browser a reader is watching. Taking the newest open session of any
 * profile let a throwaway agent run steal the list — the history on screen
 * then belonged to a browser nobody could see, and the model's and the
 * person's own commands vanished from the rail.
 */
const watchable = (session: { closedAt?: number; profile?: string }) =>
  !session.closedAt && session.profile !== "ephemeral";
/** How many rows the pane keeps. Older ones stay in the trace on disk. */
const MAX_ROWS = 200;

export function useLocalBrowserActivity({
  projectId,
  consentToken,
  active,
}: {
  projectId: string | null;
  consentToken: string | null;
  /** False while the tab is hidden: a pane nobody is looking at polls nothing. */
  active: boolean;
}): {
  entries: LocalBrowserTraceEntry[];
  warning: string | null;
} {
  const [entries, setEntries] = useState<LocalBrowserTraceEntry[]>([]);
  /**
   * The session being read, WITH the project it belongs to.
   *
   * Stored as one value rather than two pieces of state so a stale pairing is
   * impossible by construction: holding a bare `sessionId` meant a project
   * switch left the previous project's session in place for at least one poll,
   * which asked the new project for the old project's history. Two fields that
   * must agree are two fields that eventually will not.
   */
  const [reading, setReading] = useState<
    { projectId: string; sessionId: string } | null
  >(null);
  const sessionId = reading?.projectId === projectId ? reading.sessionId : null;
  const [warning, setWarning] = useState<string | null>(null);
  const cursor = useRef(0);
  /**
   * One poll at a time, and only the current generation's answer is applied.
   *
   * A slow trace request that overlaps the next tick would otherwise have both
   * polls read the same cursor and append the same rows, so one click appears
   * in the list twice — the same duplication the server-side mirror lock
   * prevents, arriving from the other end.
   */
  const inFlight = useRef(false);
  const generation = useRef(0);
  /** Consecutive polls that brought nothing. @see REDISCOVER_AFTER_QUIET_TICKS */
  const quietTicks = useRef(0);

  /**
   * Start a fresh list whenever the thing being read changes.
   *
   * Keyed on the pair, so it covers both a project switch and an agent opening
   * a new session in the same project. The FIRST resolution — null to a
   * session — is deliberately not a reset: that is this pane learning what it
   * was already reading, and resetting there would wipe the page the same poll
   * had just appended while leaving the cursor past it.
   */
  const readingKey = sessionId ? `${projectId}:${sessionId}` : null;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastKey.current;
    lastKey.current = readingKey;
    if (previous === null || previous === readingKey) return;
    // An in-flight poll belongs to what we just left, so its answer is already
    // discarded by the generation check; releasing the latch lets the new one
    // start at once rather than waiting out a worthless request.
    generation.current += 1;
    inFlight.current = false;
    cursor.current = 0;
    quietTicks.current = 0;
    setEntries([]);
    setWarning(null);
  }, [readingKey]);

  const poll = useCallback(async () => {
    if (!projectId || inFlight.current) return;
    inFlight.current = true;
    const mine = generation.current;
    try {
      let currentSession = sessionId;
      // A session that has gone quiet may have ended. Ask before assuming it is
      // simply idle; switching resets the list through `readingKey`.
      //
      // ONLY WHEN THIS ONE HAS CLOSED, though — not merely because a newer one
      // exists. A project can have a person's persistent session and several
      // ephemeral runs open at once, so "switch to the newest" handed the pane
      // to whichever run started last and wiped the history somebody was
      // reading, for a session that had never closed.
      if (currentSession && quietTicks.current >= REDISCOVER_AFTER_QUIET_TICKS) {
        quietTicks.current = 0;
        const sessions = await listLocalBrowserSessions(projectId, consentToken)
          .then((r) => r.sessions)
          .catch(() => null);
        if (generation.current !== mine) return;
        const mineStillOpen = sessions?.some(
          (s) => s.sessionId === currentSession && !s.closedAt,
        );
        // A lookup that failed says nothing about whether this session closed,
        // so it is not a reason to leave it.
        if (sessions && !mineStillOpen) {
          const next = sessions.find(watchable)?.sessionId ?? null;
          if (next) {
            setReading({ projectId, sessionId: next });
            return;
          }
        }
      }
      if (!currentSession) {
        let lookupFailed = false;
        const found = await listLocalBrowserSessions(projectId, consentToken)
          .then((r) => r.sessions.find(watchable)?.sessionId ?? null)
          .catch(() => {
            // A failure to LOOK is not an absence of history, and a pane that
            // showed "nothing has driven this browser" either way would be
            // telling a reader something it does not know.
            lookupFailed = true;
            return null;
          });
        // Applied only if we are still the current reader — this is the same
        // late answer the rows below are dropped for, and a warning is no more
        // this pane's to show for a project it has left than a row is.
        if (generation.current !== mine) return;
        if (!found) {
          // A LOOK THAT SUCCEEDED AND FOUND NOTHING CLEARS THE WARNING. Only
          // setting it on failure left "history unavailable" on screen for as
          // long as the project had no open session, long after the lookup had
          // started working again.
          setWarning(
            lookupFailed
              ? "this session's history could not be read just now; retrying"
              : null,
          );
          return;
        }
        currentSession = found;
        setReading({ projectId, sessionId: found });
      }
      const page = await readLocalBrowserTrace(
        {
          projectId,
          sessionId: currentSession,
          afterSeq: cursor.current,
          limit: 100,
        },
        consentToken,
      ).catch(() => null);
      // A late answer from a session or project we have since left is dropped:
      // applying it would file one project's rows under another's name.
      if (generation.current !== mine) return;
      if (!page) {
        setWarning("this session's history could not be read just now; retrying");
        return;
      }
      // Never silent: a hole in the history is the pane's to report, not
      // something a reader should have to notice for themselves.
      setWarning(page.historyWarning ?? null);
      if (page.entries.length === 0) {
        quietTicks.current += 1;
        return;
      }
      quietTicks.current = 0;
      cursor.current = Math.max(
        cursor.current,
        ...page.entries.map((entry) => entry.seq),
      );
      setEntries((previous) => [...previous, ...page.entries].slice(-MAX_ROWS));
    } finally {
      // ONLY THIS GENERATION'S LATCH. A poll left over from a project we have
      // since switched away from would otherwise clear the latch that the
      // CURRENT poll is holding, and the next tick would start a second poll
      // beside it — both reading the same cursor and appending the same rows,
      // which is precisely the duplication this latch exists to prevent.
      if (generation.current === mine) inFlight.current = false;
    }
  }, [projectId, sessionId, consentToken]);

  useEffect(() => {
    if (!active || !projectId) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      void poll();
    };
    tick();
    const timer = window.setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, projectId, poll]);

  return { entries, warning };
}
