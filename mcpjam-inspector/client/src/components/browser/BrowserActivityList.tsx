import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, HelpCircle, ShieldOff } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  listLocalBrowserSessions,
  readLocalBrowserTrace,
  type LocalBrowserTraceEntry,
  type LocalBrowserTraceRow,
} from "@/lib/local-browser/client";

/**
 * What the rail has been missing: what the browser was ASKED to do.
 *
 * "The panel PERSISTS NOTHING" was true of the Browser tab until now — frames,
 * a tab strip and a take-control bar, with no record of what the agent or the
 * model did to produce them. A person watching a browser drive itself can see
 * the picture move and cannot see who moved it, which is the difference
 * between watching and understanding.
 *
 * It reads the SESSION LEDGER rather than keeping its own list, which is what
 * makes it survive a reload — and what makes a command the model issued show
 * up here too, since every source writes the same rows through the same daemon
 * handler.
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
/** How many rows the pane keeps. Older ones stay in the trace on disk. */
const MAX_ROWS = 200;

export function BrowserActivityList({
  projectId,
  consentToken,
  active,
  className,
}: {
  projectId: string | null;
  consentToken: string | null;
  /** False while the tab is hidden: a pane nobody is looking at polls nothing. */
  active: boolean;
  className?: string;
}) {
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
  const listRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is at the bottom. A list that auto-scrolled while
  // somebody was reading three rows up would be a list they cannot read.
  const pinned = useRef(true);

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
          const next = sessions.find((s) => !s.closedAt)?.sessionId ?? null;
          if (next) {
            setReading({ projectId, sessionId: next });
            return;
          }
        }
      }
      if (!currentSession) {
        let lookupFailed = false;
        const found = await listLocalBrowserSessions(projectId, consentToken)
          .then((r) => r.sessions.find((s) => !s.closedAt)?.sessionId ?? null)
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

  useEffect(() => {
    if (!pinned.current) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries]);

  const onScroll = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    // A small slack so a rounding difference does not unpin a list that is, to
    // a reader, plainly at the bottom.
    pinned.current =
      node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  }, []);

  const body = useMemo(() => {
    if (entries.length === 0) {
      return (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Nothing has driven this browser yet.
        </p>
      );
    }
    return entries.map((entry) =>
      entry.kind === "gap" ? (
        <GapRow key={`gap-${entry.seq}`} entry={entry} />
      ) : (
        <CommandRow key={`row-${entry.seq}`} row={entry} />
      ),
    );
  }, [entries]);

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
        <span className="text-xs font-medium text-foreground">Activity</span>
        {warning ? (
          <span
            className="flex items-center gap-1 text-[11px] text-destructive"
            title={warning}
          >
            <AlertTriangle className="h-3 w-3" />
            {warning.includes("could not be read")
              ? "history unavailable"
              : "history incomplete"}
          </span>
        ) : null}
      </div>
      <div
        ref={listRef}
        onScroll={onScroll}
        data-testid="rail-browser-activity"
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {body}
      </div>
    </div>
  );
}

/**
 * One command.
 *
 * The three outcomes are shown as three different things rather than as a
 * colour on one thing: `refused` means nothing ran, `unknown` means we cannot
 * say, and a reader who cannot tell those apart cannot tell whether to retry.
 */
function CommandRow({ row }: { row: LocalBrowserTraceRow }) {
  const failed = row.outcome === "executed" && row.ok === false;
  return (
    <div className="border-b px-3 py-1.5 text-xs last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
          {row.seq}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">
          {describe(row)}
        </span>
        <Outcome row={row} failed={failed} />
      </div>
      <div className="mt-0.5 flex items-baseline gap-2 text-[11px] text-muted-foreground">
        <span className="shrink-0" title={row.actor.label ?? undefined}>
          {actorLabel(row)}
        </span>
        {row.url ? <span className="min-w-0 truncate">{row.url}</span> : null}
        <span className="ml-auto shrink-0 tabular-nums">{row.durationMs}ms</span>
      </div>
    </div>
  );
}

function Outcome({
  row,
  failed,
}: {
  row: LocalBrowserTraceRow;
  failed: boolean;
}) {
  if (row.outcome === "refused") {
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
        title={`Refused: ${row.errorCode ?? "no reason given"} — nothing ran`}
      >
        <ShieldOff className="h-3 w-3" />
        {row.errorCode ?? "refused"}
      </span>
    );
  }
  if (row.outcome === "unknown") {
    return (
      <span
        className="flex shrink-0 items-center gap-1 text-[11px] text-destructive"
        title={
          `Unknown: ${row.errorCode ?? "no reason given"} — this may or may ` +
          "not have run. Do not assume it did not."
        }
      >
        <HelpCircle className="h-3 w-3" />
        unknown
      </span>
    );
  }
  if (failed) {
    return (
      <span
        className="shrink-0 text-[11px] text-destructive"
        title={row.errorCode ?? undefined}
      >
        {row.errorCode ?? "failed"}
      </span>
    );
  }
  return null;
}

/** A stretch of history that is missing, said out loud. */
function GapRow({
  entry,
}: {
  entry: Extract<LocalBrowserTraceEntry, { kind: "gap" }>;
}) {
  return (
    <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground last:border-b-0">
      <AlertTriangle className="h-3 w-3 shrink-0" />
      <span>
        {entry.reason === "daemon_restart"
          ? "the browser restarted here"
          : entry.reason === "ring_overflow"
            ? `${entry.toSeq - entry.fromSeq + 1} earlier commands are no longer kept`
            : "some history could not be recorded"}
      </span>
    </div>
  );
}

/**
 * What a row says it did, in one line.
 *
 * Reads from the RECORDED command rather than re-deriving anything: a typed
 * value is already `{redacted, chars}` by the time it reaches here, and a URL
 * has already lost its query. There is nothing to redact in this component,
 * which is the point — the pane cannot leak what it was never sent.
 */
export function describe(row: LocalBrowserTraceRow): string {
  const command = row.command;
  const target =
    command.target?.a11yRef ??
    command.target?.selector ??
    (command.target?.coordinates
      ? `(${command.target.coordinates.join(", ")})`
      : undefined);
  switch (command.kind) {
    case "navigate":
      return `navigate ${command.url ?? ""}`.trim();
    case "back":
      return "back";
    case "reload":
      return "reload";
    case "note":
      return `note — ${command.value ?? ""}`;
    case "observe":
      return `observe ${command.mode ?? ""}`.trim();
    case "webmcp_invoke":
      return "page tool";
    case "webmcp_cancel":
      return "cancel page tool";
    case "act": {
      const value = command.redactedValue
        ? `${command.redactedValue.chars} chars (hidden)`
        : command.value;
      return [command.verb, target, value].filter(Boolean).join(" ");
    }
    default:
      return command.kind;
  }
}

/** Who did it, short enough for a rail. */
export function actorLabel(row: LocalBrowserTraceRow): string {
  if (row.actor.kind === "human") return "you";
  if (row.actor.kind === "model") return "model";
  if (row.actor.kind === "agent") return row.actor.id;
  return row.actor.id;
}
