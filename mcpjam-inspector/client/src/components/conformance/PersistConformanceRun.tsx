/**
 * Persist a hosted UI conformance execution as a durable Convex run.
 *
 * Mounted only when a project id is available, so ConformancePanel tests
 * (no Convex provider) stay Convex-free. Creates the run on first start,
 * upserts each suite as it settles, heartbeats while work is in flight,
 * and finalizes once every requested suite is terminal.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useAction } from "convex/react";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { useConformanceRun } from "@/hooks/use-conformance-run";
import { isHttpServer } from "@/hooks/use-conformance-run";
import {
  toConformanceReport,
  type ConformanceReport,
} from "@mcpjam/sdk/browser";

export type ConformancePersistConfig = {
  projectId: string;
  serverId?: string | null;
};

type RunSnapshot = ReturnType<typeof useConformanceRun>;

const HEARTBEAT_MS = 20_000;

function suiteReport(
  kind: "protocol" | "apps" | "tasks" | "oauth",
  state: {
    status: string;
    error?: string;
    verdict?: string;
    result?: unknown;
  }
): ConformanceReport {
  if (state.result) {
    try {
      const report = toConformanceReport(state.result as never);
      if (state.status === "error" && report.outcome === "passed") {
        return {
          ...report,
          passed: false,
          outcome: "incomplete",
          incompleteReason:
            state.error ?? `${kind} suite ended with an execution error`,
        };
      }
      return report;
    } catch {
      // Fall through to a diagnostic synthetic report for malformed results.
    }
  }

  const reportKind =
    kind === "protocol"
      ? "protocol-conformance"
      : kind === "apps"
      ? "apps-conformance"
      : kind === "tasks"
      ? "tasks-conformance"
      : "oauth-conformance";
  const error = state.error ?? `${kind} suite did not produce a report`;
  return {
    schemaVersion: 1,
    kind: reportKind,
    name: kind,
    passed: false,
    outcome: "incomplete",
    incompleteReason: error,
    score: {
      score: null,
      outcome: "incomplete",
      applicable: 1,
      passed: 0,
      failed: 0,
      couldNotRun: 1,
      notApplicable: 0,
      // A suite that never produced a report has no pending bucket: the one
      // thing known about it is that an obligation went untested.
      pending: 0,
      advisories: [],
      advicePointsLost: 0,
    },
    durationMs: 0,
    groups: [
      {
        id: `${kind}-execution`,
        title: "Execution",
        target: "",
        passed: false,
        durationMs: 0,
        cases: [
          {
            id: `${kind}-could-not-run`,
            title: `${kind} could not run`,
            category: "execution",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            error,
          },
        ],
      },
    ],
  };
}

function requestedSuitesFor(server: ServerWithName, snapshot: RunSnapshot) {
  const suites: Array<"protocol" | "apps" | "tasks" | "oauth"> = [];
  if (snapshot.protocol.status !== "unavailable") suites.push("protocol");
  if (snapshot.apps.status !== "unavailable") suites.push("apps");
  if (snapshot.tasks.status !== "unavailable") suites.push("tasks");
  if (isHttpServer(server) && snapshot.oauth.status !== "unavailable") {
    suites.push("oauth");
  }
  return suites.length > 0 ? suites : (["protocol", "apps", "tasks"] as const);
}

function isSettled(status: string): boolean {
  return (
    status === "done" ||
    status === "error" ||
    status === "unavailable" ||
    status === "idle"
  );
}

/**
 * Persist only when the operator actually started suites.
 *
 * `runVersion` also increments on mount and server-change resets
 * (`resetStates` in `use-conformance-run`). Those leave every suite idle.
 * Treating that bump as a Convex start writes an Incomplete 0s history row
 * the user never asked for — and remounting the live panel (clicking a
 * history row, switching servers, StrictMode) repeats it.
 */
export function shouldStartPersistedRun({
  runVersion,
  startedVersion,
  isExecuting,
}: {
  runVersion: number;
  startedVersion: number;
  isExecuting: boolean;
}): boolean {
  if (runVersion === 0) return false;
  if (startedVersion === runVersion) return false;
  return isExecuting;
}

export function PersistConformanceRun({
  persist,
  server,
  snapshot,
}: {
  persist: ConformancePersistConfig;
  server: ServerWithName;
  snapshot: RunSnapshot;
}) {
  const startRun = useMutation("conformanceRuns:startRun" as any);
  const heartbeat = useMutation("conformanceRuns:heartbeat" as any);
  const finalizeRun = useMutation("conformanceRuns:finalizeRun" as any);
  const upsertReport = useAction("conformanceRuns:upsertReportAction" as any);

  const [runId, setRunId] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const uploadedRef = useRef<Set<string>>(new Set());
  const pendingUploadsRef = useRef<Map<string, Promise<unknown>>>(new Map());
  /**
   * The `runVersion` a run was already created for. Keyed by the run attempt
   * itself rather than by "a start is in flight", so neither a StrictMode
   * double-mount nor a re-render that merely changes the `server` object's
   * identity can open a second Convex run for one click of Run — the extra
   * row would sit unfinalized until the sweep timed it out, littering the
   * history with runs the user never started.
   */
  const startedVersionRef = useRef(0);
  const finalizedRef = useRef(false);
  const finalizationScheduledRef = useRef(false);

  const { protocol, apps, tasks, oauth, isRunning, runVersion } = snapshot;

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  // A run parked on the consent screen is ALIVE. `isRunning` is false there —
  // no suite is executing — so heartbeating on it alone lets the backend sweep
  // declare the pause abandoned while the user is still authorizing.
  const awaitingAuthorization =
    oauth.status === "needs-authorization" || oauth.waitingForAuth === true;
  const isExecuting = isRunning || awaitingAuthorization;

  useEffect(() => {
    if (
      !shouldStartPersistedRun({
        runVersion,
        startedVersion: startedVersionRef.current,
        isExecuting,
      })
    ) {
      return;
    }
    startedVersionRef.current = runVersion;
    runIdRef.current = null;
    setRunId(null);
    uploadedRef.current = new Set();
    pendingUploadsRef.current = new Map();
    finalizedRef.current = false;
    finalizationScheduledRef.current = false;
    const suites = [...requestedSuitesFor(server, snapshotRef.current)];
    const target = persist.serverId
      ? { kind: "server" as const, serverId: persist.serverId }
      : {
          kind: "external" as const,
          serverUrl:
            server.config && "url" in server.config
              ? String(server.config.url)
              : undefined,
          serverRef: server.name,
        };
    void startRun({
      projectId: persist.projectId,
      target,
      source: "ui",
      requestedSuites: suites,
      actorLabel: "Inspector UI",
    })
      .then((result: { runId?: string }) => {
        if (result?.runId) {
          runIdRef.current = result.runId;
          setRunId(result.runId);
        }
      })
      .catch(() => {
        // Persistence is best-effort for the live panel; the suites still run.
      });
  }, [
    isExecuting,
    persist.projectId,
    persist.serverId,
    runVersion,
    server,
    startRun,
  ]);

  useEffect(() => {
    if (!runId) return;

    const queueUpload = (key: string, payload: Record<string, unknown>) => {
      const operation = Promise.resolve()
        .then(() => upsertReport(payload))
        .catch(() => undefined)
        .finally(() => {
          pendingUploadsRef.current.delete(key);
        });
      pendingUploadsRef.current.set(key, operation);
    };

    const maybeUpload = (
      kind: "protocol" | "apps" | "tasks" | "oauth",
      state: {
        status: string;
        waitingForAuth?: boolean;
        verdict?: string;
        result?: { checks?: unknown[]; steps?: unknown[]; durationMs?: number };
      }
    ) => {
      if (
        uploadedRef.current.has(`${kind}:done`) ||
        uploadedRef.current.has(`${kind}:error`)
      ) {
        return;
      }
      if (
        state.status === "running" &&
        !uploadedRef.current.has(`${kind}:running`)
      ) {
        uploadedRef.current.add(`${kind}:running`);
        queueUpload(`${kind}:running`, {
          runId,
          suiteKind: kind,
          status: "running",
        });
        return;
      }
      if (state.status === "needs-authorization" || state.waitingForAuth) {
        if (!uploadedRef.current.has(`${kind}:awaiting`)) {
          uploadedRef.current.add(`${kind}:awaiting`);
          queueUpload(`${kind}:awaiting`, {
            runId,
            suiteKind: kind,
            status: "awaiting_authorization",
          });
        }
        return;
      }
      if (state.status === "done" || state.status === "error") {
        uploadedRef.current.add(`${kind}:${state.status}`);
        queueUpload(`${kind}:${state.status}`, {
          runId,
          suiteKind: kind,
          status: state.status === "error" ? "failed" : "completed",
          report: suiteReport(kind, state),
        });
      }
    };

    maybeUpload("protocol", protocol);
    maybeUpload("apps", apps);
    maybeUpload("tasks", tasks);
    maybeUpload("oauth", oauth);
  }, [apps, oauth, protocol, tasks, upsertReport, runId]);

  useEffect(() => {
    if (!runId || !isExecuting) return;
    const timer = window.setInterval(() => {
      void heartbeat({ runId });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [heartbeat, isExecuting, runId]);

  useEffect(() => {
    if (!runId || isRunning || runVersion === 0 || finalizedRef.current) return;
    const suites = requestedSuitesFor(server, snapshotRef.current);
    const settled = suites.every((kind) =>
      isSettled(snapshotRef.current[kind].status)
    );
    if (!settled) return;
    if (finalizationScheduledRef.current) return;
    finalizationScheduledRef.current = true;
    const uploads = [...pendingUploadsRef.current.values()];
    void Promise.allSettled(uploads).then(() => {
      if (finalizedRef.current) return;
      finalizedRef.current = true;
      void finalizeRun({ runId });
    });
  }, [finalizeRun, isRunning, runVersion, server, runId]);

  return null;
}
