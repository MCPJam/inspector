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
    verdict?: string;
    result?: { checks?: unknown[]; steps?: unknown[]; durationMs?: number };
  },
  score: unknown
) {
  const items = (
    kind === "oauth"
      ? (state.result?.steps ?? [])
      : (state.result?.checks ?? [])
  ) as Array<{
    id?: string;
    title?: string;
    status?: string;
    skipReason?: string;
  }>;
  const cases = items.map((item) => ({
    id: item.id,
    title: item.title,
    status:
      item.status === "passed" || item.status === "failed"
        ? item.status
        : "skipped",
    skipReason:
      item.skipReason === "could-not-run" || item.skipReason === "not-applicable"
        ? item.skipReason
        : state.status === "error"
          ? ("could-not-run" as const)
          : undefined,
  }));
  if (cases.length === 0 && state.status === "error") {
    cases.push({
      id: `${kind}-could-not-run`,
      title: `${kind} could not run`,
      status: "skipped",
      skipReason: "could-not-run",
    });
  }
  return {
    schemaVersion: 1,
    kind: `${kind}-conformance`,
    name: kind,
    passed: state.verdict === "passed",
    outcome: state.verdict,
    score,
    durationMs: state.result?.durationMs,
    cases,
    groups: [{ name: kind, cases }],
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
  const startingRef = useRef(false);
  const finalizedRef = useRef(false);

  const {
    protocol,
    apps,
    tasks,
    oauth,
    protocolScore,
    appsScore,
    tasksScore,
    oauthScore,
    isRunning,
    runVersion,
  } = snapshot;

  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (runVersion === 0) return;
    if (startingRef.current) return;
    startingRef.current = true;
    runIdRef.current = null;
    setRunId(null);
    uploadedRef.current = new Set();
    finalizedRef.current = false;
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
      })
      .finally(() => {
        startingRef.current = false;
      });
  }, [persist.projectId, persist.serverId, runVersion, server, startRun]);

  useEffect(() => {
    if (!runId) return;

    const maybeUpload = (
      kind: "protocol" | "apps" | "tasks" | "oauth",
      state: {
        status: string;
        waitingForAuth?: boolean;
        verdict?: string;
        result?: { checks?: unknown[]; steps?: unknown[]; durationMs?: number };
      },
      score: unknown
    ) => {
      if (uploadedRef.current.has(`${kind}:done`) || uploadedRef.current.has(`${kind}:error`)) {
        return;
      }
      if (state.status === "running" && !uploadedRef.current.has(`${kind}:running`)) {
        uploadedRef.current.add(`${kind}:running`);
        void upsertReport({ runId, suiteKind: kind, status: "running" });
        return;
      }
      if (state.status === "needs-authorization" || state.waitingForAuth) {
        if (!uploadedRef.current.has(`${kind}:awaiting`)) {
          uploadedRef.current.add(`${kind}:awaiting`);
          void upsertReport({
            runId,
            suiteKind: kind,
            status: "awaiting_authorization",
          });
        }
        return;
      }
      if (state.status === "done" || state.status === "error") {
        uploadedRef.current.add(`${kind}:${state.status}`);
        void upsertReport({
          runId,
          suiteKind: kind,
          status: state.status === "error" ? "failed" : "completed",
          report: suiteReport(kind, state, score),
        });
      }
    };

    maybeUpload("protocol", protocol, protocolScore);
    maybeUpload("apps", apps, appsScore);
    maybeUpload("tasks", tasks, tasksScore);
    maybeUpload("oauth", oauth, oauthScore);
  }, [
    apps,
    appsScore,
    oauth,
    oauthScore,
    protocol,
    protocolScore,
    tasks,
    tasksScore,
    upsertReport,
    runId,
  ]);

  useEffect(() => {
    if (!runId || !isRunning) return;
    const timer = window.setInterval(() => {
      void heartbeat({ runId });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [heartbeat, isRunning, runId]);

  useEffect(() => {
    if (!runId || isRunning || runVersion === 0 || finalizedRef.current) return;
    const suites = requestedSuitesFor(server, snapshotRef.current);
    const settled = suites.every((kind) =>
      isSettled(snapshotRef.current[kind].status)
    );
    if (!settled) return;
    finalizedRef.current = true;
    void finalizeRun({ runId });
  }, [finalizeRun, isRunning, runVersion, server, runId]);

  return null;
}
