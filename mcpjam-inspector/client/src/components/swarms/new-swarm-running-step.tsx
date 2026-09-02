/**
 * Running step of the New swarm create flow.
 *
 * Persona × client matrix while the just-launched runs fan out. Columns are
 * the execution targets (environments / hosts). Cell state prefers the live
 * SSE stream so the grid updates before Convex session rows land.
 *
 * Click a session chip to watch its live stream in the right pane
 * (`SwarmLiveStreamPane` — same Trace / Chat / Raw surface as Personas).
 */
import { useEffect, useMemo, useState } from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";
import { JourneyHostLogoMark } from "@/components/swarms/journey-host-logo";
import {
  resolveSwarmCellOutcome,
  SwarmLiveStreamPane,
  type SwarmAttemptOutcome,
  type SwarmMatrixCellOutcome,
  type SwarmMatrixSelection,
} from "@/components/swarms/journey-run-results";
import {
  liveSessionTrace,
  swarmCellKey,
  useJourneyRunStream,
  type JourneyRunStreamState,
  type SwarmCellLiveStatus,
} from "@/components/swarms/use-journey-run-stream";
import {
  buildSwarmRunTargets,
  findTargetCellForChatSessionId,
  summaryTargetKey,
  type SwarmTargetColumn,
} from "@/components/swarms/swarm-targets";
import { swarmAttemptChatSessionId } from "@/shared/swarm-session-id";
import { humanizeSwarmAttemptError } from "@/shared/swarm-attempt-error";
import {
  DEFAULT_PAGE_SIZE,
  SWARM_QUERIES,
  type JourneyRun,
  type JourneyRunAttempt,
  type JourneySessionRow,
} from "@/lib/swarm-api";
import type { ProjectEnvironmentView } from "@/hooks/useProjectEnvironments";
import { cn } from "@/lib/utils";

export type SwarmLaunchedRun = {
  runId: string;
  journeyId: string;
  personaId: string;
  personaName: string;
  personaRole: string;
  avatarShape?: number;
  avatarPalette?: number;
  label: string;
};

export type SwarmRunningColumn = {
  key: string;
  label: string;
};

type AttributedSession = JourneySessionRow & { columnKey: string };

type RunLiveSnapshot = {
  status: string;
  sessions: AttributedSession[];
  stream: JourneyRunStreamState;
  summaryTotal: number;
  summaryDone: number;
  /** Attempts that reached a non-succeeded terminal, for the run banner. */
  summarySucceeded: number;
  summaryRateLimited: number;
  summaryFailed: number;
  columns: SwarmRunningColumn[];
  /** Full target columns — needed to mint chatSessionIds for click → stream. */
  targets: SwarmTargetColumn[];
  sessionsPerTarget: number;
  /** Per-attempt outcomes from `journeyRunAttempts` — the authority on how a
   * cell actually went (see `resolveSwarmCellOutcome`). */
  attempts: JourneyRunAttempt[];
};

type RunningSelection = SwarmMatrixSelection & {
  runId: string;
  personaId: string;
};

type PersonaRow = {
  personaId: string;
  name: string;
  role: string;
  avatarShape?: number;
  avatarPalette?: number;
  runIds: string[];
};

type CellView = {
  outcome: SwarmMatrixCellOutcome | "queued";
  primary: string;
  secondary: string | null;
};

type SessionSlot = {
  runId: string;
  targetKey: string;
  hostId: string;
  sessionIndex: number;
  chatSessionId: string;
  view: CellView;
};

type FirstFinding = {
  text: string;
  /**
   * The session that produced it — `chatSessions._id`, the SAME id the Insights
   * workbench and the Overview findings list already open sessions with
   * (`buildSwarmPath({ tab: "sessions", session })`). A finding nobody can
   * trace back to a session is a claim, so a row without one is skipped rather
   * than surfaced as an unfollowable line.
   */
  sessionId: string;
  /**
   * The criterion that failed, when exactly one did. Carried so the run page
   * this link leaves for can NAME the finding — the wizard's own line says
   * what was found, and that sentence used to be lost the moment the viewer
   * followed it. Omitted for a multi-check failure: naming one of several
   * would misreport which claim the viewer is looking at.
   */
  criterionId?: string;
};

function shortRole(role: string): string {
  const trimmed = role.trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 27)}…`;
}

function columnsFromRun(
  run: JourneyRun,
  hostName: (hostId: string) => string | undefined
): SwarmRunningColumn[] {
  // snapshot.hosts is the fan-out the runner actually uses — prefer it over
  // hostSummaries, which can lag or key oddly while attempts are in flight.
  const snapshotHosts = run.snapshot?.hosts ?? [];
  if (snapshotHosts.length > 0) {
    return snapshotHosts.map((host) => {
      const key = summaryTargetKey({
        hostId: host.hostId,
        targetId: host.targetId,
      });
      return {
        key,
        label:
          hostName(host.hostId) ??
          host.environmentRef?.name ??
          host.hostName ??
          key.slice(0, 8),
      };
    });
  }
  return buildSwarmRunTargets({
    hostSummaries: run.hostSummaries ?? [],
    snapshotHosts: run.snapshot?.hosts,
    hostName,
  }).map((target) => ({ key: target.key, label: target.label }));
}

function attributeSessions(
  run: JourneyRun,
  sessions: JourneySessionRow[],
  hostName: (hostId: string) => string | undefined
): {
  columns: SwarmRunningColumn[];
  targets: SwarmTargetColumn[];
  sessions: AttributedSession[];
  sessionsPerTarget: number;
} {
  const sessionsPerTarget = Math.max(1, run.snapshot?.sessionsPerTarget ?? 1);
  const columns = columnsFromRun(run, hostName);
  const targets = buildSwarmRunTargets({
    hostSummaries:
      (run.hostSummaries?.length ?? 0) > 0
        ? run.hostSummaries
        : (run.snapshot?.hosts ?? []).map((host) => ({
            hostId: host.hostId,
            targetId: host.targetId,
          })),
    snapshotHosts: run.snapshot?.hosts,
    hostName,
  });

  if (columns.length === 0) {
    const byHost = new Map<string, string>();
    for (const session of sessions) {
      if (!byHost.has(session.hostId)) {
        byHost.set(
          session.hostId,
          hostName(session.hostId) ?? session.hostId.slice(0, 8)
        );
      }
    }
    const fallbackTargets: SwarmTargetColumn[] = Array.from(
      byHost.entries()
    ).map(([key, label]) => ({
      key,
      hostId: key,
      label,
      identity: { hostId: key },
    }));
    return {
      columns: fallbackTargets.map((target) => ({
        key: target.key,
        label: target.label,
      })),
      targets: fallbackTargets,
      sessions: sessions.map((session) => ({
        ...session,
        columnKey: session.hostId,
      })),
      sessionsPerTarget,
    };
  }

  return {
    columns,
    targets,
    sessionsPerTarget,
    sessions: sessions.map((session) => {
      const hit = findTargetCellForChatSessionId({
        runId: run._id,
        targets,
        sessionsPerTarget,
        chatSessionId: session.chatSessionId,
      });
      return {
        ...session,
        columnKey: hit?.target.key ?? session.hostId,
      };
    }),
  };
}

function streamMatchesColumn(
  envelope: { hostId: string; targetId?: string },
  columnKey: string
): boolean {
  if (summaryTargetKey(envelope) === columnKey) return true;
  if (envelope.targetId === columnKey) return true;
  if (envelope.hostId === columnKey) return true;
  return false;
}

function RunLiveBridge({
  runId,
  hostName,
  onSnapshot,
}: {
  runId: string;
  hostName: (hostId: string) => string | undefined;
  onSnapshot: (runId: string, snapshot: RunLiveSnapshot | null) => void;
}) {
  const run = useQuery(
    SWARM_QUERIES.getJourneyRun as any,
    {
      runId,
    } as any
  ) as JourneyRun | null | undefined;
  const { results: sessionResults } = usePaginatedQuery(
    SWARM_QUERIES.listSessionsByJourneyRun as any,
    { journeyRunId: runId } as any,
    { initialNumItems: Math.max(DEFAULT_PAGE_SIZE, 32) }
  );
  const runStatus = run?.status ?? "running";
  const stream = useJourneyRunStream(runId, runStatus === "running");

  useEffect(() => {
    if (run === undefined) return;
    if (run === null) {
      onSnapshot(runId, null);
      return;
    }
    const sessions = (sessionResults ?? []) as JourneySessionRow[];
    const attributed = attributeSessions(run, sessions, hostName);
    const summary = run.summary ?? {
      total: 0,
      succeeded: 0,
      failed: 0,
      rateLimited: 0,
    };
    onSnapshot(runId, {
      status: run.status,
      sessions: attributed.sessions,
      stream,
      summaryTotal: summary.total,
      summaryDone: summary.succeeded + summary.failed + summary.rateLimited,
      summarySucceeded: summary.succeeded,
      summaryRateLimited: summary.rateLimited,
      summaryFailed: summary.failed,
      columns: attributed.columns,
      targets: attributed.targets,
      sessionsPerTarget: attributed.sessionsPerTarget,
      attempts: run.attempts ?? [],
    });
  }, [hostName, onSnapshot, run, runId, sessionResults, stream]);

  return null;
}

function cellTone(outcome: CellView["outcome"]): string {
  switch (outcome) {
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300";
    case "failed":
      return "border-destructive/40 bg-destructive/10 text-destructive";
    case "rate_limited":
      return "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300";
    case "running":
      return "border-primary/25 bg-primary/5 text-foreground";
    case "queued":
      return "border-dashed border-border/70 bg-muted/20 text-muted-foreground";
    default:
      return "border-border/50 bg-muted/15 text-muted-foreground";
  }
}

function slotView(args: {
  liveStatus?: SwarmCellLiveStatus;
  session: JourneySessionRow | null;
  attempt?: SwarmAttemptOutcome | null;
  runStatus: string;
  turns?: number | null;
}): CellView {
  const { liveStatus, session, attempt, runStatus, turns } = args;
  const outcome = resolveSwarmCellOutcome({
    liveStatus,
    session,
    attempt,
    runStatus,
  });

  if (outcome === "running") {
    return {
      outcome: "running",
      primary: "running",
      secondary:
        typeof turns === "number" && turns > 0 ? `turn ${turns}` : null,
    };
  }
  if (outcome === "pending" && runStatus === "running") {
    return { outcome: "queued", primary: "queued", secondary: null };
  }
  if (outcome === "pending") {
    return { outcome: "pending", primary: "…", secondary: null };
  }

  // A non-success terminal is reported BEFORE the rubric, and never dressed up
  // as one. A rate-limited attempt never ran, so it has no rubric result to
  // show — and reusing the `rate_limited` tone for a partial rubric pass (as
  // the block below still does for its own middle case) must not leak into a
  // cell that was genuinely refused by the provider.
  if (outcome === "rate_limited") {
    return {
      outcome: "rate_limited",
      primary: "limited",
      secondary:
        attempt?.errorCode === "spend_cap_exceeded" ? "spend cap" : "not run",
    };
  }
  if (outcome === "failed" && (session?.messageCount ?? 0) === 0) {
    return { outcome: "failed", primary: "failed", secondary: "no activity" };
  }

  const criteria = session?.criteria;
  if (criteria?.status === "completed" && criteria.results?.length) {
    const checks = criteria.results.length;
    const passed = criteria.results.filter((result) => result.passed).length;
    return {
      outcome:
        passed === checks
          ? "succeeded"
          : passed === 0
          ? "failed"
          : "rate_limited",
      primary: `${passed}/${checks} pass`,
      secondary:
        outcome === "failed"
          ? "gave up"
          : (session?.messageCount ?? 0) > 0
          ? `${session!.messageCount} turns`
          : null,
    };
  }

  if (outcome === "failed") {
    return { outcome: "failed", primary: "failed", secondary: "gave up" };
  }
  return {
    outcome: "succeeded",
    primary: "done",
    secondary:
      (session?.messageCount ?? 0) > 0
        ? `${session!.messageCount} turns`
        : null,
  };
}

/**
 * One clickable chip per (run, target, sessionIndex) under a persona × client
 * cell. Prefers minted ids from snapshot targets so a click works before the
 * Convex session row lands.
 */
function collectSessionSlots(args: {
  columnKey: string;
  runEntries: Array<{ runId: string; snap: RunLiveSnapshot }>;
}): SessionSlot[] {
  const { columnKey, runEntries } = args;
  const slots: SessionSlot[] = [];

  for (const { runId, snap } of runEntries) {
    const target = snap.targets.find((entry) => entry.key === columnKey);
    if (!target) continue;

    // Attempts are claimed with the SAME id the client mints below, so the
    // chatSessionId join is exact. `(hostId, sessionIdx)` is the fallback for
    // an attempt that failed before it could claim one.
    const attemptByChatSessionId = new Map<string, JourneyRunAttempt>();
    const attemptByHostSlot = new Map<string, JourneyRunAttempt>();
    for (const attempt of snap.attempts) {
      if (attempt.chatSessionId) {
        attemptByChatSessionId.set(attempt.chatSessionId, attempt);
      }
      attemptByHostSlot.set(`${attempt.hostId}#${attempt.sessionIdx}`, attempt);
    }

    for (let index = 0; index < snap.sessionsPerTarget; index++) {
      const chatSessionId = swarmAttemptChatSessionId(
        runId,
        target.identity,
        index
      );
      const direct = snap.stream.cellStatus[swarmCellKey(columnKey, index)] as
        | SwarmCellLiveStatus
        | undefined;
      const fromEnvelope = Object.values(snap.stream.sessions).find(
        (entry) =>
          entry.envelope.sessionIndex === index &&
          streamMatchesColumn(entry.envelope, columnKey)
      );
      const live = direct ?? fromEnvelope?.attemptStatus;
      const session =
        snap.sessions.find(
          (row) =>
            row.chatSessionId === chatSessionId ||
            row.chatSessionId === fromEnvelope?.envelope.chatSessionId
        ) ?? null;
      const turns =
        fromEnvelope?.stream.actualToolCalls.length ||
        (session?.status === "active" || session?.status === "running"
          ? session.messageCount
          : null);

      const attempt =
        attemptByChatSessionId.get(chatSessionId) ??
        (fromEnvelope?.envelope.chatSessionId
          ? attemptByChatSessionId.get(fromEnvelope.envelope.chatSessionId)
          : undefined) ??
        attemptByHostSlot.get(`${target.hostId}#${index}`) ??
        null;

      slots.push({
        runId,
        targetKey: columnKey,
        hostId: target.hostId,
        sessionIndex: index,
        chatSessionId: fromEnvelope?.envelope.chatSessionId ?? chatSessionId,
        view: slotView({
          liveStatus: live,
          session,
          attempt,
          runStatus: snap.status,
          turns: typeof turns === "number" ? turns : null,
        }),
      });
    }
  }

  return slots;
}

function mergeStreams(
  snapshots: Record<string, RunLiveSnapshot>
): JourneyRunStreamState {
  let stream: JourneyRunStreamState = {
    sessions: {},
    cellStatus: {},
    runComplete: true,
    connected: false,
    error: null,
  };
  for (const snap of Object.values(snapshots)) {
    stream = {
      sessions: { ...stream.sessions, ...snap.stream.sessions },
      cellStatus: { ...stream.cellStatus, ...snap.stream.cellStatus },
      runComplete: stream.runComplete && snap.stream.runComplete,
      connected: stream.connected || snap.stream.connected,
      error: stream.error ?? snap.stream.error,
    };
  }
  return stream;
}

function findFirstFinding(
  snapshots: Record<string, RunLiveSnapshot>
): FirstFinding | null {
  for (const snap of Object.values(snapshots)) {
    for (const session of snap.sessions) {
      const criteria = session.criteria;
      if (criteria?.status !== "completed" || !criteria.results?.length) {
        continue;
      }
      const failed = criteria.results.filter((result) => !result.passed);
      if (failed.length === 0) continue;
      if (!session.id) continue;
      const reason =
        session.goalScore?.reason?.trim() ||
        `failed ${failed.length} ${failed.length === 1 ? "check" : "checks"}`;
      return {
        text: `First finding: ${reason}`,
        sessionId: session.id,
        ...(failed.length === 1 && failed[0]
          ? { criterionId: failed[0].criterionId }
          : {}),
      };
    }
  }
  return null;
}

export function NewSwarmRunningStep({
  projectId,
  runs,
  fallbackColumns,
  environments = [],
  onLeave,
  onOpenSession,
}: {
  projectId: string;
  runs: SwarmLaunchedRun[];
  /** Columns from the Describe-step environments — always shown. */
  fallbackColumns: SwarmRunningColumn[];
  /** Used to label columns by client (host) instead of env nickname. */
  environments?: ProjectEnvironmentView[];
  onLeave: () => void;
  /**
   * Follow one session's evidence out of the wizard. The caller lands on this
   * swarm's OWN page, deep-linked to that session — both where the transcript
   * is and the run's durable home, so following a finding stays reversible
   * while the run keeps going.
   */
  onOpenSession: (sessionId: string, criterionId?: string) => void;
}) {
  const hosts = useQuery(
    SWARM_QUERIES.listHosts as any,
    {
      projectId,
    } as any
  ) as { hostId: string; name: string }[] | undefined;

  const hostName = useMemo(() => {
    const map = new Map(
      (hosts ?? []).map((host) => [host.hostId, host.name] as const)
    );
    return (hostId: string) => map.get(hostId);
  }, [hosts]);

  const clientLabel = useMemo(() => {
    const envById = new Map(
      environments.map((env) => [env.environmentId, env] as const)
    );
    return (key: string, fallback: string) => {
      if (key.startsWith("environment:")) {
        const env = envById.get(key.slice("environment:".length));
        if (env) {
          return hostName(env.hostId) ?? env.name ?? fallback;
        }
      }
      return hostName(key) ?? fallback;
    };
  }, [environments, hostName]);

  const [snapshots, setSnapshots] = useState<Record<string, RunLiveSnapshot>>(
    {}
  );
  const [selection, setSelection] = useState<RunningSelection | null>(null);

  const onSnapshot = useMemo(
    () => (runId: string, snapshot: RunLiveSnapshot | null) => {
      setSnapshots((current) => {
        if (!snapshot) {
          if (!(runId in current)) return current;
          const next = { ...current };
          delete next[runId];
          return next;
        }
        const prev = current[runId];
        // RunLiveBridge rebuilds array fields every effect tick; compare the
        // live bits by value so an unchanged tick does not loop setState.
        if (
          prev &&
          prev.status === snapshot.status &&
          prev.summaryDone === snapshot.summaryDone &&
          prev.summaryTotal === snapshot.summaryTotal &&
          prev.sessionsPerTarget === snapshot.sessionsPerTarget &&
          prev.stream === snapshot.stream &&
          prev.columns.length === snapshot.columns.length &&
          prev.columns.every(
            (column, index) =>
              column.key === snapshot.columns[index]?.key &&
              column.label === snapshot.columns[index]?.label
          ) &&
          prev.targets.length === snapshot.targets.length &&
          prev.targets.every(
            (target, index) => target.key === snapshot.targets[index]?.key
          ) &&
          prev.sessions.length === snapshot.sessions.length &&
          prev.sessions.every(
            (session, index) =>
              session.chatSessionId ===
                snapshot.sessions[index]?.chatSessionId &&
              session.status === snapshot.sessions[index]?.status &&
              session.messageCount === snapshot.sessions[index]?.messageCount &&
              session.criteria?.status ===
                snapshot.sessions[index]?.criteria?.status
          )
        ) {
          return current;
        }
        return { ...current, [runId]: snapshot };
      });
    },
    []
  );

  const personaRows = useMemo((): PersonaRow[] => {
    const order: string[] = [];
    const byId = new Map<string, PersonaRow>();
    for (const run of runs) {
      const existing = byId.get(run.personaId);
      if (existing) {
        existing.runIds.push(run.runId);
        continue;
      }
      order.push(run.personaId);
      byId.set(run.personaId, {
        personaId: run.personaId,
        name: run.personaName,
        role: run.personaRole,
        avatarShape: run.avatarShape,
        avatarPalette: run.avatarPalette,
        runIds: [run.runId],
      });
    }
    return order.map((id) => byId.get(id)!);
  }, [runs]);

  // Once any run snapshot has landed, columns come ONLY from those snapshots
  // (what the runner actually fans out). Fallback env columns are a pre-load
  // placeholder — keeping them after load made Cursor look "queued" when the
  // journeys were still single-client.
  const columns = useMemo((): SwarmRunningColumn[] => {
    const seen = new Map<string, string>();
    const snapList = Object.values(snapshots);
    if (snapList.length === 0) {
      for (const column of fallbackColumns) {
        seen.set(column.key, clientLabel(column.key, column.label));
      }
    } else {
      for (const snap of snapList) {
        for (const column of snap.columns) {
          seen.set(column.key, clientLabel(column.key, column.label));
        }
      }
    }
    return Array.from(seen.entries()).map(([key, label]) => ({ key, label }));
  }, [clientLabel, fallbackColumns, snapshots]);

  const missingPlannedClients = useMemo(() => {
    const snapList = Object.values(snapshots);
    if (snapList.length === 0 || fallbackColumns.length === 0) return [];
    const onRuns = new Set(
      snapList.flatMap((snap) => snap.columns.map((column) => column.key))
    );
    return fallbackColumns.filter((column) => !onRuns.has(column.key));
  }, [fallbackColumns, snapshots]);

  const { done, total, allTerminal, succeeded, rateLimited, failed } =
    useMemo(() => {
      let doneCount = 0;
      let totalCount = 0;
      let succeededCount = 0;
      let rateLimitedCount = 0;
      let failedCount = 0;
      let terminal = runs.length > 0;
      for (const run of runs) {
        const snap = snapshots[run.runId];
        if (!snap) {
          terminal = false;
          continue;
        }
        doneCount += snap.summaryDone;
        totalCount += snap.summaryTotal;
        succeededCount += snap.summarySucceeded;
        rateLimitedCount += snap.summaryRateLimited;
        failedCount += snap.summaryFailed;
        if (snap.status === "running" || snap.status === "pending") {
          terminal = false;
        }
      }
      return {
        done: doneCount,
        total: totalCount,
        allTerminal: terminal,
        succeeded: succeededCount,
        rateLimited: rateLimitedCount,
        failed: failedCount,
      };
    }, [runs, snapshots]);

  /**
   * The first non-success terminal, humanized — what the run banner explains.
   *
   * Every attempt of a rate-limited run carries the same provider refusal, so
   * showing one is showing all of them. Rendered through the shared humanizer
   * rather than raw, because rows written before the runner started
   * sanitizing still hold the full `swarm-agent <url> failed (429): {...}`
   * envelope.
   */
  const runFailure = useMemo(() => {
    if (!allTerminal || rateLimited + failed === 0) return null;
    for (const snap of Object.values(snapshots)) {
      for (const attempt of snap.attempts) {
        if (attempt.status !== "rate_limited" && attempt.status !== "failed") {
          continue;
        }
        // A structured code alone is enough — the humanizer maps recognized
        // sandbox codes without any stored message.
        if (!attempt.errorMessage && !attempt.errorCode) continue;
        return {
          kind: attempt.status,
          info: humanizeSwarmAttemptError(
            attempt.errorMessage,
            attempt.errorCode,
          ),
        };
      }
    }
    return null;
  }, [allTerminal, failed, rateLimited, snapshots]);

  const progress = total > 0 ? Math.min(1, done / total) : allTerminal ? 1 : 0;
  const finding = useMemo(() => findFirstFinding(snapshots), [snapshots]);

  const mergedStream = useMemo(() => mergeStreams(snapshots), [snapshots]);

  const selectedConvex = useMemo(() => {
    if (!selection) return null;
    const snap = snapshots[selection.runId];
    return (
      snap?.sessions.find(
        (session) => session.chatSessionId === selection.chatSessionId
      ) ?? null
    );
  }, [selection, snapshots]);

  const selectedRunStatus = selection
    ? snapshots[selection.runId]?.status ?? "running"
    : "running";

  const fallbackTrace = useMemo(
    () =>
      selection
        ? liveSessionTrace(mergedStream.sessions[selection.chatSessionId])
        : null,
    [mergedStream.sessions, selection]
  );

  return (
    <div
      className="flex h-full min-h-0 w-full"
      data-testid="new-swarm-running-step"
    >
      {runs.map((run) => (
        <RunLiveBridge
          key={run.runId}
          runId={run.runId}
          hostName={hostName}
          onSnapshot={onSnapshot}
        />
      ))}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
              {/* "finished" only when something actually finished. A run whose
                  every attempt was refused used to read "Swarm finished — 20 of
                  20 sessions", which is true only if you count a refusal as a
                  session. Lead with what succeeded instead. */}
              {!allTerminal
                ? "Swarming"
                : succeeded > 0
                ? "Swarm finished"
                : rateLimited > 0
                ? "Swarm could not run"
                : "Swarm failed"}
              {total > 0 ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  —{" "}
                  {allTerminal
                    ? `${succeeded} of ${total} sessions ran`
                    : `${done} of ${total} sessions`}
                </span>
              ) : null}
            </h2>
            {allTerminal && rateLimited + failed > 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="new-swarm-running-outcome-breakdown"
              >
                {[
                  succeeded > 0 ? `${succeeded} ran` : null,
                  rateLimited > 0 ? `${rateLimited} rate-limited` : null,
                  failed > 0 ? `${failed} failed` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            ) : null}
            {columns.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Clients:{" "}
                <span className="font-medium text-foreground">
                  {columns.map((column) => column.label).join(" · ")}
                </span>
                {columns.length === 1
                  ? " — select multiple environments on Describe to compare clients side by side."
                  : null}
              </p>
            ) : null}
            {missingPlannedClients.length > 0 ? (
              <p
                className="text-sm text-amber-700 dark:text-amber-300"
                data-testid="new-swarm-running-missing-clients"
                role="status"
              >
                Selected at Describe but not on these runs:{" "}
                {missingPlannedClients
                  .map((column) => clientLabel(column.key, column.label))
                  .join(" · ")}
                . These runs launched without that environment — leave and
                launch the swarm again to include it.
              </p>
            ) : null}
            {runFailure ? (
              <div
                className={cn(
                  "rounded-md border px-3 py-2 text-sm",
                  // Calm (amber) for the two outcomes whose fix is "do it
                  // again": a provider refusal, and an authorization handshake
                  // that needs re-running. Destructive red stays for failures
                  // the user has to go and repair — an expired sign-in in front
                  // of an XAA-protected server is not an incident.
                  runFailure.kind === "rate_limited" ||
                    runFailure.info.rerunnable
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
                    : "border-destructive/40 bg-destructive/10 text-destructive"
                )}
                data-testid="new-swarm-running-failure"
                role="status"
              >
                <p className="font-medium">
                  {runFailure.kind === "rate_limited"
                    ? "No sessions ran — the model provider refused the request."
                    : runFailure.info.rerunnable
                    ? "No sessions ran — this run's authorization needs re-running."
                    : "No sessions ran."}
                </p>
                <p className="mt-0.5">{runFailure.info.message}</p>
                {runFailure.info.canTopUp ? (
                  <p className="mt-0.5 text-[13px] opacity-90">
                    Add credit or connect your own provider key (BYOK) to run
                    now.
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="flex items-center gap-3">
              <div
                className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-valuenow={Math.round(progress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                data-testid="new-swarm-running-progress"
              >
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                />
              </div>
              <span className="shrink-0 text-xs text-muted-foreground">
                {allTerminal
                  ? "done"
                  : total > 0
                  ? `${Math.round(progress * 100)}%`
                  : "starting…"}
              </span>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0"
            data-testid="new-swarm-running-stop"
            onClick={onLeave}
          >
            {allTerminal ? "Done" : "Stop"}
          </Button>
        </div>

        {columns.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Waiting for client targets from the launched runs…
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/50">
            <table className="w-full min-w-[28rem] border-collapse text-left">
              <thead>
                <tr className="border-b border-border/40">
                  <th className="sticky left-0 z-10 w-[12rem] max-w-[12rem] bg-background px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Persona · rubric score
                  </th>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      className="min-w-[7.5rem] px-2 py-2.5 text-center text-xs font-medium text-muted-foreground"
                    >
                      <span className="inline-flex items-center justify-center gap-1.5">
                        <JourneyHostLogoMark label={column.label} />
                        <span className="truncate">{column.label}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {personaRows.map((persona) => {
                  const runEntries = persona.runIds
                    .map((runId) => {
                      const snap = snapshots[runId];
                      return snap ? { runId, snap } : null;
                    })
                    .filter(Boolean) as Array<{
                    runId: string;
                    snap: RunLiveSnapshot;
                  }>;

                  return (
                    <tr
                      key={persona.personaId}
                      className="border-b border-border/30 last:border-0"
                      data-testid="new-swarm-running-persona-row"
                    >
                      <td className="sticky left-0 z-10 max-w-[12rem] bg-background px-3 py-3 align-middle">
                        <div className="flex min-w-0 items-center gap-2.5">
                          <PersonaPixelAvatar
                            seed={persona.personaId}
                            shapeIndex={persona.avatarShape}
                            paletteIndex={persona.avatarPalette}
                            size="sm"
                          />
                          <p className="min-w-0 truncate text-sm font-medium text-foreground">
                            {persona.name}
                            {persona.role ? (
                              <span className="font-normal text-muted-foreground">
                                {" "}
                                — {shortRole(persona.role)}
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </td>
                      {columns.map((column) => {
                        const slots =
                          runEntries.length === 0
                            ? []
                            : collectSessionSlots({
                                columnKey: column.key,
                                runEntries,
                              });

                        return (
                          <td
                            key={column.key}
                            className="min-w-[7.5rem] px-2 py-2 align-middle"
                            data-testid="new-swarm-running-cell"
                          >
                            {slots.length === 0 ? (
                              <div
                                data-outcome="queued"
                                className={cn(
                                  "rounded-lg border px-2.5 py-2 text-center",
                                  cellTone("queued")
                                )}
                              >
                                <p className="text-xs font-semibold leading-tight">
                                  queued
                                </p>
                              </div>
                            ) : (
                              <div className="flex flex-col gap-1">
                                {slots.map((slot) => {
                                  const selected =
                                    selection?.chatSessionId ===
                                    slot.chatSessionId;
                                  const showIndex = slots.length > 1;
                                  return (
                                    <button
                                      key={slot.chatSessionId}
                                      type="button"
                                      data-testid="new-swarm-running-session"
                                      data-outcome={slot.view.outcome}
                                      aria-pressed={selected}
                                      aria-label={`Watch ${persona.name} on ${
                                        column.label
                                      } session ${slot.sessionIndex + 1}`}
                                      onClick={() =>
                                        setSelection({
                                          runId: slot.runId,
                                          personaId: persona.personaId,
                                          targetKey: slot.targetKey,
                                          hostId: slot.hostId,
                                          sessionIndex: slot.sessionIndex,
                                          chatSessionId: slot.chatSessionId,
                                        })
                                      }
                                      className={cn(
                                        "rounded-lg border px-2.5 py-2 text-center transition-colors",
                                        "hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                        cellTone(slot.view.outcome),
                                        selected &&
                                          "ring-2 ring-primary ring-offset-1 ring-offset-background"
                                      )}
                                    >
                                      <p className="text-xs font-semibold leading-tight">
                                        {showIndex
                                          ? `#${slot.sessionIndex + 1} · ${
                                              slot.view.primary
                                            }`
                                          : slot.view.primary}
                                      </p>
                                      {slot.view.secondary ? (
                                        <p className="mt-0.5 text-[11px] opacity-80">
                                          {slot.view.secondary}
                                        </p>
                                      ) : null}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {finding ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5"
            data-testid="new-swarm-running-finding"
          >
            <p className="min-w-0 flex-1 text-sm leading-snug text-foreground">
              {finding.text}
            </p>
            <button
              type="button"
              className="shrink-0 text-sm font-medium text-primary hover:text-primary/80"
              data-testid="new-swarm-running-finding-open"
              aria-label="Open the session behind this finding"
              onClick={() =>
                onOpenSession(finding.sessionId, finding.criterionId)
              }
            >
              Look now
            </button>
          </div>
        ) : null}

        <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
          Click a session to watch it stream on the right. Leaving goes back to
          Overview — the run keeps going and finishes on its own. A finding
          opens this swarm's own page on the session that produced it, and the
          run is still there when you come back.
        </div>
      </div>

      <aside
        className="flex w-[min(32rem,44%)] shrink-0 flex-col border-l border-border/50 bg-muted/10 p-3 sm:p-4"
        data-testid="new-swarm-running-stream"
      >
        <SwarmLiveStreamPane
          selection={selection}
          stream={mergedStream}
          convexSession={selectedConvex}
          fallbackTrace={fallbackTrace}
          runStatus={selectedRunStatus}
          // The session, not just "somewhere else". This used to hand the pane
          // `onLeave`, which threw away the session it was called with and left
          // the viewer on the flat Sessions list hunting for the transcript
          // they had been watching a moment earlier.
          onOpenCompleted={(session) => onOpenSession(session.id)}
          fillHeight
        />
      </aside>
    </div>
  );
}
