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
   * Called with the run id THE MOMENT IT EXISTS, before suites execute. That
   * call is what posts the `conformance` attempt and binds the run.
   */
  onRunStarted?: (runId: string) => Promise<void>;
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
  // GitHub App has no interactive OAuth. Unselected/unsupported OAuth is
  // dropped from the requested snapshot so it is not incomplete.
  const suites =
    args.source === "github_app"
      ? requestedSuites.filter((kind) => kind !== "oauth")
      : requestedSuites;

  const started = (await client.mutation("conformanceRuns:startRun" as never, {
    projectId: args.projectId,
    target: args.target,
    source: args.source,
    requestedSuites: suites,
    protocolVersion: args.protocolVersion,
    engineVersion: args.engineVersion,
    actorLabel: args.actorLabel,
    githubCheckTriggerId: args.githubCheckTriggerId,
  } as never)) as {
    runId: string;
    reused?: boolean;
    status?: string;
    outcome?: string | null;
  };

  await args.onRunStarted?.(started.runId);

  if (started.reused && started.status && started.status !== "queued") {
    return {
      runId: started.runId,
      reused: true,
      outcome: started.outcome ?? null,
    };
  }

  const heartbeat = setInterval(() => {
    void client
      .mutation("conformanceRuns:heartbeat" as never, {
        runId: started.runId,
      } as never)
      .catch((error: unknown) => {
        logger.warn("[conformance-run] heartbeat failed", {
          runId: started.runId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, 20_000);
  (heartbeat as unknown as { unref?: () => void }).unref?.();

  try {
    const report = await runConformance({
      server: args.server,
      suites,
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
        await client.action("conformanceRuns:upsertReportAction" as never, {
          runId: started.runId,
          suiteKind: event.suiteKind,
          report: body,
          status: event.status === "completed" ? "completed" : "failed",
          durationMs: body.durationMs,
        } as never);
      },
    });

    const finalized = (await client.mutation(
      "conformanceRuns:finalizeRun" as never,
      { runId: started.runId } as never
    )) as { outcome?: string | null; score?: number | null };

    return {
      runId: started.runId,
      outcome: finalized.outcome ?? report.outcome,
      score: finalized.score ?? report.score.score,
    };
  } finally {
    clearInterval(heartbeat);
  }
}
