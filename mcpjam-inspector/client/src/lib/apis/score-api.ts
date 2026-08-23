/**
 * score.mcpjam.com persistence client.
 *
 * Deliberately a plain `fetch`, NOT `webPost`/`buildServerRequest`: those
 * carry the hosted bootstrap machinery ({projectId, serverId} resolution,
 * `BootstrapNotReadyError`) that a result page has no business needing. A
 * `/results/<token>` visitor may have no session, no guest cookie, and no
 * project — the token in the URL is the whole credential.
 */

import type { ConformanceScore } from "@mcpjam/sdk/browser";
import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPTasksConformanceResult,
} from "@mcpjam/sdk";
import type { OAuthConformanceStartResult } from "@/lib/apis/mcp-conformance-api";

export type ScoreSuiteId = "protocol" | "apps" | "tasks" | "oauth";

/**
 * The flat headline stored on a run. Mirrors `ConformanceScore` minus
 * advisories and pending. Pending is derived on the results page from
 * `report[suite].profile.pendingCheckIds` (the share fetch always includes
 * the report blob). A flat `pending` int is a backend follow-up for
 * surfaces that list summaries without reports.
 */
export interface ScoreSummary {
  score: number | null;
  outcome: "passed" | "failed" | "incomplete";
  applicable: number;
  passed: number;
  failed: number;
  couldNotRun: number;
  notApplicable: number;
  advisoryCount: number;
  protocolVersion?: string;
}

export interface ScoreSuiteSummary extends ScoreSummary {
  suiteId: ScoreSuiteId;
}

/** The full multi-suite report, stored as a blob and rendered on the result page. */
export interface ScoreReport {
  protocol?: MCPConformanceResult;
  apps?: MCPAppsConformanceResult;
  tasks?: MCPTasksConformanceResult;
  oauth?: OAuthConformanceStartResult["result"];
}

export interface StoredScoreRun extends ScoreSummary {
  serverUrl: string;
  suiteSummaries: ScoreSuiteSummary[];
  report: ScoreReport;
  createdAt: number;
}

/** Drop the advisory bodies; the counts are what the stored row carries. */
export function toScoreSummary(score: ConformanceScore): ScoreSummary {
  return {
    score: score.score,
    outcome: score.outcome,
    applicable: score.applicable,
    passed: score.passed,
    failed: score.failed,
    couldNotRun: score.couldNotRun,
    notApplicable: score.notApplicable,
    advisoryCount: score.advisories.length,
    ...(score.protocolVersion
      ? { protocolVersion: score.protocolVersion }
      : {}),
  };
}

async function readError(response: Response, fallback: string) {
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    error?: string;
  } | null;
  return body?.message ?? body?.error ?? fallback;
}

export async function submitScoreRun(input: {
  serverUrl: string;
  summary: ScoreSummary;
  suiteSummaries: ScoreSuiteSummary[];
  report: ScoreReport;
}): Promise<{ token: string }> {
  const response = await fetch("/api/web/score/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(await readError(response, "Could not save this run."));
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new Error("Could not save this run.");
  return { token: body.token };
}

export class ScoreRunNotFoundError extends Error {}

export async function fetchScoreRun(token: string): Promise<StoredScoreRun> {
  const response = await fetch(
    `/api/web/score/runs/${encodeURIComponent(token)}`
  );
  if (response.status === 404) {
    throw new ScoreRunNotFoundError(
      await readError(
        response,
        "That result link is not valid, or the run no longer exists."
      )
    );
  }
  if (!response.ok) {
    throw new Error(await readError(response, "Could not load this result."));
  }
  const body = (await response.json()) as { run?: StoredScoreRun };
  if (!body.run) throw new Error("Could not load this result.");
  return body.run;
}
