import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePaginatedQuery, useQuery } from "convex/react";
import {
  SWARM_QUERIES,
  DEFAULT_PAGE_SIZE,
  swarmAttemptChatSessionId,
  type JourneyRun,
  type JourneyRollup,
  type JourneySessionRow,
} from "@/lib/swarm-api";
import {
  buildSwarmRunTargets,
  findTargetCellForChatSessionId,
  type SwarmTargetColumn,
} from "@/components/swarms/swarm-targets";
import {
  liveSessionTrace,
  swarmCellKey,
  useJourneyRunStream,
  type JourneyRunStreamState,
} from "@/components/swarms/use-journey-run-stream";
import type { SwarmMatrixSelection } from "@/components/swarms/journey-run-results";
import type { TraceEnvelope } from "@/components/evals/trace-viewer-adapter";
import { runNumberLabel } from "@/components/swarms/journey-run-format";

type HostItem = { hostId: string; name: string };

export type RunSessionsContextValue = {
  run: JourneyRun;
  runId: string;
  runLabel: string;
  runStatus: JourneyRun["status"];
  sessionsPerHost: number;
  sessions: JourneySessionRow[];
  sessionsStatus: string;
  loadMoreSessions: (n: number) => void;
  targets: SwarmTargetColumn[];
  hostSummaries: JourneyRun["hostSummaries"];
  stream: JourneyRunStreamState;
  matrixSelection: SwarmMatrixSelection | null;
  onMatrixSelect: (sel: SwarmMatrixSelection) => void;
  selectedConvex: JourneySessionRow | null;
  fallbackTrace: TraceEnvelope | null;
  /**
   * True while the view is following the run rather than a session the user
   * chose: the selection was made for them and will move on to the next running
   * attempt when this one finishes. Goes false permanently on a manual pick.
   */
  autoFollowing: boolean;
};

const RunSessionsContext = createContext<RunSessionsContextValue | null>(null);

/**
 * Which matrix cell auto-follow should move to, or `null` for "stay put".
 *
 * Stays put when the cell being watched is still running (don't yank the view
 * off a live session) and when nothing is running at all (don't jump to a
 * finished attempt). Otherwise it takes the first running cell — which is both
 * the initial pick, when nothing is selected yet, and the hand-off when the
 * watched attempt finishes. Pure so the policy is testable without a provider.
 */
export function pickAutoFollowCell(args: {
  cellStatus: Record<string, string>;
  currentCell: string | null;
}): { targetKey: string; sessionIndex: number } | null {
  const { cellStatus, currentCell } = args;
  if (currentCell && cellStatus[currentCell] === "running") return null;
  const next = Object.entries(cellStatus).find(
    ([, status]) => status === "running",
  );
  if (!next) return null;
  const key = next[0];
  if (key === currentCell) return null;
  // Returned STRUCTURED rather than as a composite key. The caller used to
  // reverse-parse `targetKey:sessionIndex` with `lastIndexOf(":")`, which happens
  // to work only because sessionIndex is a colon-free integer even when the
  // targetKey itself contains one (`environment:e1`) — an untested coupling to
  // `swarmCellKey`'s format that no compiler would have caught changing.
  const cut = key.lastIndexOf(":");
  if (cut <= 0) return null;
  const sessionIndex = Number(key.slice(cut + 1));
  if (!Number.isInteger(sessionIndex) || sessionIndex < 0) return null;
  return { targetKey: key.slice(0, cut), sessionIndex };
}

export function useRunSessionsContext() {
  return useContext(RunSessionsContext);
}

export function RunSessionsProvider({
  runId,
  runSnapshot,
  journeyRefId,
  hosts,
  sessionsPerHost,
  initialTargetKey,
  initialThreadId,
  children,
}: {
  runId: string;
  runSnapshot: JourneyRun;
  journeyRefId: string;
  hosts: HostItem[];
  sessionsPerHost: number;
  initialTargetKey?: string | null;
  initialThreadId?: string;
  children: ReactNode;
}) {
  const { results: runs } = usePaginatedQuery(
    SWARM_QUERIES.listJourneyRuns as any,
    { journeyRefId } as any,
    { initialNumItems: DEFAULT_PAGE_SIZE }
  );
  const rollup = useQuery(
    SWARM_QUERIES.journeyRollup as any,
    { journeyRefId } as any
  ) as JourneyRollup | undefined;
  const typedRuns = runs as JourneyRun[];
  const runIndex = typedRuns.findIndex((r) => r._id === runId);
  const run = (runIndex >= 0 ? typedRuns[runIndex] : null) ?? runSnapshot;
  const runLabel =
    runIndex >= 0
      ? runNumberLabel(rollup?.runCount ?? typedRuns.length, runIndex)
      : "Run";
  const runStatus = run.status;

  const {
    results: sessions,
    status: sessionsStatus,
    loadMore,
  } = usePaginatedQuery(
    SWARM_QUERIES.listSessionsByJourneyRun as any,
    { journeyRunId: runId } as any,
    { initialNumItems: Math.max(DEFAULT_PAGE_SIZE, sessionsPerHost * 4) }
  );

  const streamEnabled = runStatus === "running";
  const stream = useJourneyRunStream(runId, streamEnabled);

  const [matrixSelection, setMatrixSelection] =
    useState<SwarmMatrixSelection | null>(null);
  // A manual pin is permanent for the life of this run detail: once the user has
  // said which session they want to watch, the view must never move under them —
  // not when that attempt finishes, and not when a livelier one starts.
  const [pinnedManually, setPinnedManually] = useState(false);
  const pinSelection = useCallback((sel: SwarmMatrixSelection) => {
    setPinnedManually(true);
    setMatrixSelection(sel);
  }, []);

  const hostName = (id: string) => hosts.find((h) => h.hostId === id)?.name;
  const hostNameOrId = (id: string) => hostName(id) ?? id.slice(0, 8);

  const rows = sessions as JourneySessionRow[];
  const hostSummaries = run.hostSummaries;

  const targets = useMemo<SwarmTargetColumn[]>(() => {
    if (hostSummaries.length > 0) {
      return buildSwarmRunTargets({
        hostSummaries,
        snapshotHosts: run.snapshot?.hosts,
        hostName,
      });
    }
    const seen = new Set<string>();
    for (const s of rows) seen.add(s.hostId);
    return Array.from(seen).map((hostId) => ({
      key: hostId,
      hostId,
      label: hostNameOrId(hostId),
      identity: { hostId },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostSummaries, run.snapshot, rows, hosts]);

  const convexByChatId = useMemo(() => {
    const map = new Map<string, JourneySessionRow>();
    for (const s of rows) map.set(s.chatSessionId, s);
    return map;
  }, [rows]);

  const selectedConvex = matrixSelection
    ? convexByChatId.get(matrixSelection.chatSessionId) ?? null
    : null;

  const fallbackTrace = useMemo(
    () =>
      matrixSelection
        ? liveSessionTrace(stream.sessions[matrixSelection.chatSessionId])
        : null,
    [matrixSelection, stream.sessions]
  );

  const appliedInitialThreadRef = useRef(false);
  const appliedInitialTargetRef = useRef(false);

  // Every piece of selection state above is scoped to ONE run detail. The
  // provider is not guaranteed to remount when the route moves to another run,
  // and a pin carried across would both show the wrong session and keep
  // auto-follow from ever starting on the new one. Reset on the run identity.
  const scopeKey = `${runId}::${initialTargetKey ?? ""}::${initialThreadId ?? ""}`;
  const appliedScopeRef = useRef(scopeKey);
  if (appliedScopeRef.current !== scopeKey) {
    appliedScopeRef.current = scopeKey;
    appliedInitialThreadRef.current = false;
    appliedInitialTargetRef.current = false;
    // Render-phase reset (not an effect) so the very first render of the new run
    // never paints the previous run's selection.
    setMatrixSelection(null);
    setPinnedManually(false);
  }

  useEffect(() => {
    if (appliedInitialThreadRef.current || !initialThreadId) return;
    const match = rows.find((s) => s.id === initialThreadId);
    if (!match) return;
    appliedInitialThreadRef.current = true;
    // Arriving on a specific thread IS a choice — don't let auto-follow move off it.
    setPinnedManually(true);
    const cell = findTargetCellForChatSessionId({
      runId,
      targets,
      sessionsPerHost,
      chatSessionId: match.chatSessionId,
    });
    setMatrixSelection({
      targetKey: cell?.target.key ?? match.hostId,
      hostId: match.hostId,
      sessionIndex: cell?.sessionIndex ?? 0,
      chatSessionId: match.chatSessionId,
    });
  }, [initialThreadId, rows, runId, targets, sessionsPerHost]);

  useEffect(() => {
    if (
      appliedInitialTargetRef.current ||
      !initialTargetKey ||
      initialThreadId
    ) {
      return;
    }
    const target = targets.find((t) => t.key === initialTargetKey);
    if (!target) return;
    const mintedIds = Array.from(
      { length: Math.max(1, sessionsPerHost) },
      (_, i) => swarmAttemptChatSessionId(runId, target.identity, i)
    );
    const matchIdx = mintedIds.findIndex((id) =>
      rows.some((s) => s.chatSessionId === id)
    );
    if (matchIdx >= 0) {
      appliedInitialTargetRef.current = true;
      setPinnedManually(true);
      setMatrixSelection({
        targetKey: target.key,
        hostId: target.hostId,
        sessionIndex: matchIdx,
        chatSessionId: mintedIds[matchIdx],
      });
      return;
    }
    if (
      runStatus !== "running" &&
      hostSummaries.some(
        (h) =>
          (h.targetId ?? h.hostId) === initialTargetKey ||
          h.hostId === initialTargetKey
      )
    ) {
      appliedInitialTargetRef.current = true;
      setPinnedManually(true);
      setMatrixSelection({
        targetKey: target.key,
        hostId: target.hostId,
        sessionIndex: 0,
        chatSessionId: mintedIds[0],
      });
    }
  }, [
    initialTargetKey,
    initialThreadId,
    rows,
    runStatus,
    hostSummaries,
    runId,
    targets,
    sessionsPerHost,
  ]);

  // Auto-follow: while the run is live and the user hasn't pinned anything, keep
  // the view on a RUNNING attempt — pick one when nothing is selected, and move
  // on when the one being watched finishes. Without the second half this only
  // ever selected once, so a viewer ended up staring at a completed session
  // while the rest of the run played out unwatched.
  useEffect(() => {
    // `pinnedManually` is state, so a deep-link effect that just called
    // `setPinnedManually(true)` in this same commit is not visible here yet — but
    // its ref IS. Consult both, or auto-follow can steal the very session the
    // user navigated to. Also skip while a deep link is still PENDING (the prop
    // is set but the matching row hasn't loaded), so we don't grab a running cell
    // and then get overridden a beat later.
    const deepLinkRequested = Boolean(initialThreadId || initialTargetKey);
    if (
      pinnedManually ||
      appliedInitialThreadRef.current ||
      appliedInitialTargetRef.current ||
      deepLinkRequested ||
      !streamEnabled
    ) {
      return;
    }
    const currentCell = matrixSelection
      ? swarmCellKey(matrixSelection.targetKey, matrixSelection.sessionIndex)
      : null;
    const picked = pickAutoFollowCell({
      cellStatus: stream.cellStatus,
      currentCell,
    });
    if (!picked) return;
    const { targetKey, sessionIndex } = picked;
    const target = targets.find((t) => t.key === targetKey);
    if (!target) return;
    setMatrixSelection({
      targetKey,
      hostId: target.hostId,
      sessionIndex,
      chatSessionId: swarmAttemptChatSessionId(
        runId,
        target.identity,
        sessionIndex
      ),
    });
  }, [
    pinnedManually,
    matrixSelection,
    streamEnabled,
    stream.cellStatus,
    runId,
    targets,
    initialThreadId,
    initialTargetKey,
  ]);

  const value = useMemo<RunSessionsContextValue>(
    () => ({
      run,
      runId,
      runLabel,
      runStatus,
      sessionsPerHost,
      sessions: rows,
      sessionsStatus,
      loadMoreSessions: loadMore,
      targets,
      hostSummaries,
      stream,
      matrixSelection,
      onMatrixSelect: pinSelection,
      selectedConvex,
      fallbackTrace,
      autoFollowing: !pinnedManually && streamEnabled,
    }),
    [
      run,
      runId,
      runLabel,
      runStatus,
      sessionsPerHost,
      rows,
      sessionsStatus,
      loadMore,
      targets,
      hostSummaries,
      stream,
      matrixSelection,
      pinSelection,
      pinnedManually,
      streamEnabled,
      selectedConvex,
      fallbackTrace,
    ]
  );

  return (
    <RunSessionsContext.Provider value={value}>
      {children}
    </RunSessionsContext.Provider>
  );
}
