import {
  createContext,
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
};

const RunSessionsContext = createContext<RunSessionsContextValue | null>(null);

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
  useEffect(() => {
    if (appliedInitialThreadRef.current || !initialThreadId) return;
    const match = rows.find((s) => s.id === initialThreadId);
    if (!match) return;
    appliedInitialThreadRef.current = true;
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

  const appliedInitialTargetRef = useRef(false);
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

  useEffect(() => {
    if (matrixSelection || !streamEnabled) return;
    const runningEntry = Object.entries(stream.cellStatus).find(
      ([, status]) => status === "running"
    );
    if (!runningEntry) return;
    const [key] = runningEntry;
    const cut = key.lastIndexOf(":");
    if (cut <= 0) return;
    const targetKey = key.slice(0, cut);
    const sessionIndex = Number(key.slice(cut + 1));
    if (!Number.isFinite(sessionIndex)) return;
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
  }, [matrixSelection, streamEnabled, stream.cellStatus, runId, targets]);

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
      onMatrixSelect: setMatrixSelection,
      selectedConvex,
      fallbackTrace,
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
