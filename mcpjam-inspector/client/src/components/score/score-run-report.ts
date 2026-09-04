import type { useConformanceRun } from "@/hooks/use-conformance-run";
import {
  toScoreSummary,
  type ScoreSuiteId,
  type ScoreSuiteSummary,
} from "@/lib/apis/score-api";

type ConformanceRun = ReturnType<typeof useConformanceRun>;

export function buildScoreRunSubmission(
  serverUrl: string,
  run: ConformanceRun,
) {
  if (!run.pooledScore) return null;

  const suiteSummaries: ScoreSuiteSummary[] = (
    [
      ["protocol", run.protocolScore],
      ["apps", run.appsScore],
      ["tasks", run.tasksScore],
      ["oauth", run.oauthScore],
    ] as const
  )
    .filter(([, score]) => score !== undefined)
    .map(([suiteId, score]) => ({
      suiteId: suiteId as ScoreSuiteId,
      ...toScoreSummary(score!),
    }));

  return {
    serverUrl,
    summary: toScoreSummary(run.pooledScore),
    suiteSummaries,
    report: {
      protocol: run.protocol.result,
      apps: run.apps.result,
      tasks: run.tasks.result,
      oauth: run.oauth.result,
    },
  };
}
