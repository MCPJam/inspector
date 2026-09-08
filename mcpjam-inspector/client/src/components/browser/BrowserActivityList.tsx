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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const cursor = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  // Whether the reader is at the bottom. A list that auto-scrolled while
  // somebody was reading three rows up would be a list they cannot read.
  const pinned = useRef(true);

  /**
   * The session these rows belong to.
   *
   * A ref, and compared rather than reset on every change, because the FIRST
   * change is not a change of session — it is this pane learning which session
   * it was already reading. Resetting there wipes the page the same poll just
   * appended while leaving the cursor past it, so the opening rows of every
   * session vanish and are never fetched again.
   *
   * A genuine switch (one id to a different one) still resets: the cursor
   * belongs to one ledger, and carrying it across would skip the new session's
   * first rows for real.
   */
  const readingSession = useRef<string | null>(null);
  useEffect(() => {
    const previous = readingSession.current;
    readingSession.current = sessionId;
    if (previous === null || previous === sessionId) return;
    cursor.current = 0;
    setEntries([]);
    setWarning(null);
  }, [sessionId]);

  /**
   * A PROJECT switch drops the session along with the rows.
   *
   * `sessionId` is rediscovered only when it is null, so without this the pane
   * keeps polling the previous project's session and keeps showing its history
   * — one project's browsing displayed under another project's name, which is
   * the one mistake a per-project profile exists to prevent.
   */
  const readingProject = useRef<string | null>(projectId);
  useEffect(() => {
    if (readingProject.current === projectId) return;
    readingProject.current = projectId;
    readingSession.current = null;
    cursor.current = 0;
    setSessionId(null);
    setEntries([]);
    setWarning(null);
  }, [projectId]);

  const poll = useCallback(async () => {
    if (!projectId) return;
    let currentSession = sessionId;
    if (!currentSession) {
      const found = await listLocalBrowserSessions(projectId, consentToken)
        .then((r) => r.sessions.find((s) => !s.closedAt)?.sessionId ?? null)
        .catch(() => null);
      if (!found) return;
      currentSession = found;
      setSessionId(found);
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
    if (!page) return;
    // Never silent: a hole in the history is the pane's to report, not
    // something a reader should have to notice for themselves.
    setWarning(page.historyWarning ?? null);
    if (page.entries.length === 0) return;
    cursor.current = Math.max(
      cursor.current,
      ...page.entries.map((entry) => entry.seq),
    );
    setEntries((previous) =>
      [...previous, ...page.entries].slice(-MAX_ROWS),
    );
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
            history incomplete
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
