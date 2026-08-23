/**
 * Shared durable conformance execution for hosted UI and the GitHub worker.
 *
 * Creates the Convex run first, streams suite progress into report rows, and
 * finalizes once every requested suite has settled. Directory readiness is
 * deliberately absent — it grades publisher policy and must never enter the
 * conformance score or CI verdict.
 */

import {
  runConformance,
  type ConformanceReport,
  type ConformanceSuiteKind,
  type MCPServerConfig,
} from "@mcpjam/sdk";
import { createConvexClient } from "./evals/route-helpers.js";
import { logger } from "../utils/logger.js";

export type ConformanceRunSource =
  | "ui"
  | "sdk"
  | "cli"
  | "github_action"
  | "github_app"
  | "api";

export type ExecutePersistedConformanceArgs = {
  convexToken: string;
  projectId: string;
  server: MCPServerConfig;
  suites?: ConformanceSuiteKind[];
  source: ConformanceRunSource;
  target: {
    kind: "server" | "github_repo" | "external";
    serverId?: string;
    githubCheckRepoConfigId?: string;
    serverRef?: string;
    serverUrl?: string;
  };
  protocolVersion?: string;
  engineVersion?: string;
  githubCheckTriggerId?: string;
  actorLabel?: string;
  /**
   * Route-level idempotency. Mapped by the caller onto a namespaced
   * `externalRunId` (`api:<projectId>:<serverId>:<key>`). Absent ⇒ every start inserts.
   */
  externalRunId?: string;
  /**
   * Called with the run id THE MOMENT IT EXISTS, before suites execute. That
   * call is what posts the `conformance` attempt and binds the run.
   *
   * `meta` is how a start-and-detach surface learns whether this was a
   * replay: the mutation returns `reused` only here, and the receipt must
   * report the run's real status rather than a decorative `queued`.
   */
  onRunStarted?: (
    runId: string,
    meta?: { reused?: boolean; status?: string },
  ) => Promise<void>;
};

export type ExecutePersistedConformanceResult = {
  runId: string;
  reused?: boolean;
  outcome?: string | null;
  score?: number | null;
};

function syntheticIncompleteReport(
  kind: ConformanceSuiteKind,
  error: string
): ConformanceReport {
  const reportKind =
    kind === "protocol"
      ? "protocol-conformance"
      : kind === "apps"
      ? "apps-conformance"
      : kind === "tasks"
      ? "tasks-conformance"
      : "oauth-conformance";
  return {
    schemaVersion: 1,
    kind: reportKind,
    name: kind,
    passed: false,
    outcome: "incomplete",
    durationMs: 0,
    groups: [
      {
        id: "execution",
        title: "Execution",
        target: "",
        passed: false,
        durationMs: 0,
        cases: [
          {
            id: `${kind}-could-not-run`,
            title: "Suite could not run",
            status: "skipped",
            skipReason: "could-not-run",
            durationMs: 0,
            category: "execution",
            error,
          },
        ],
      },
    ],
  };
}

export async function executePersistedConformanceRun(
  args: ExecutePersistedConformanceArgs
): Promise<ExecutePersistedConformanceResult> {
  const client = createConvexClient(args.convexToken);
  const requestedSuites = (args.suites ?? ["protocol", "apps", "tasks"]).filter(
    (kind): kind is ConformanceSuiteKind =>
      kind === "protocol" ||
      kind === "apps" ||
      kind === "tasks" ||
      kind === "oauth"
  );
  // GitHub App has no interactive OAuth. Keep OAuth in the persisted requested
  // snapshot, but record it as an explicit incomplete suite instead of silently
  // dropping a configured gate.
  const suites = requestedSuites;
  const unsupportedOAuth =
    args.source === "github_app" && suites.includes("oauth");
  const executionSuites = unsupportedOAuth
    ? suites.filter((kind) => kind !== "oauth")
    : suites;

  const started = (await client.mutation(
    "conformanceRuns:startRun" as never,
    {
      projectId: args.projectId,
      target: args.target,
      source: args.source,
      requestedSuites: suites,
      protocolVersion: args.protocolVersion,
      engineVersion: args.engineVersion,
      actorLabel: args.actorLabel,
      githubCheckTriggerId: args.githubCheckTriggerId,
      ...(args.externalRunId ? { externalRunId: args.externalRunId } : {}),
    } as never
  )) as {
    runId: string;
    reused?: boolean;
    status?: string;
    outcome?: string | null;
  };

  await args.onRunStarted?.(started.runId, {
    reused: started.reused === true,
    status: started.status,
  });

  // A reused row already has an owner — the request that inserted it.
  // Re-entering `runConformance` for a still-`queued` replay would dial the
  // target twice and write conflicting reports for one run id. Recovery for a
  // dead owner is heartbeat + sweep, never a second execute.
  if (started.reused) {
    return {
      runId: started.runId,
      reused: true,
      outcome: started.outcome ?? null,
    };
  }

  const heartbeat = setInterval(() => {
    void client
      .mutation(
        "conformanceRuns:heartbeat" as never,
        {
          runId: started.runId,
        } as never
      )
      .catch((error: unknown) => {
        logger.warn("[conformance-run] heartbeat failed", {
          runId: started.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, 20_000);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    const report =
      executionSuites.length > 0
        ? await runConformance({
            server: args.server,
            suites: executionSuites,
            protocolVersion: args.protocolVersion as never,
            engineVersion: args.engineVersion,
            onProgress: async (event) => {
              if (event.status === "running") return;
              const body =
                event.report ??
                syntheticIncompleteReport(
                  event.suiteKind,
                  event.error ?? "suite did not produce a report"
                );
              await client.action(
                "conformanceRuns:upsertReportAction" as never,
                {
                  runId: started.runId,
                  suiteKind: event.suiteKind,
                  report: body,
                  status: event.status === "completed" ? "completed" : "failed",
                  durationMs: body.durationMs,
                } as never
              );
            },
          })
        : null;

    if (unsupportedOAuth) {
      const body = syntheticIncompleteReport(
        "oauth",
        "GitHub App checks cannot complete interactive OAuth authorization"
      );
      await client.action(
        "conformanceRuns:upsertReportAction" as never,
        {
          runId: started.runId,
          suiteKind: "oauth",
          report: body,
          status: "failed",
          durationMs: body.durationMs,
        } as never
      );
    }

    const finalized = (await client.mutation(
      "conformanceRuns:finalizeRun" as never,
      { runId: started.runId } as never
    )) as { outcome?: string | null; score?: number | null };

    return {
      runId: started.runId,
      outcome: finalized.outcome ?? report?.outcome,
      score: finalized.score ?? report?.score.score,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
