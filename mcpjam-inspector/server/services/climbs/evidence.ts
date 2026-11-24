/**
 * The baseline's steering iterations, as the climb functions take them.
 *
 * Only steering cases are read. A validation or confirmation case is never
 * fetched, so nothing built from this can name one (amendment A8): the filter
 * is on the case's key against the keys the climb says steer, before an
 * iteration becomes evidence.
 */
import { buildAppPermalink, type PlatformEvalIteration } from "@mcpjam/sdk/platform";
import type { ClimbEvidence } from "@mcpjam/sdk/climbs";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import type { ClimbDeps } from "./deps.js";
import { readRunGroups } from "./run-groups.js";

const PAGE = 100;
const MAX_PAGES = 10;

/** `lost` is everything that says nothing about the server: provider and setup failures, timeouts, a cancel. */
function outcomeOf(iteration: PlatformEvalIteration): ClimbEvidence["outcome"] {
  if (iteration.infraError) return "lost";
  if (iteration.status === "completed" && iteration.result === "passed") return "passed";
  if (iteration.status === "completed" && iteration.result === "failed") return "failed";
  return "lost";
}

export type EvidenceScope = { projectId: string; appOrigin: string; listedTools: ReadonlySet<string> };

export async function loadBaselineEvidence(
  deps: ClimbDeps,
  climb: PlatformClimb,
  scope: EvidenceScope,
): Promise<{ evidence: ClimbEvidence[]; available: boolean }> {
  const groups = await readRunGroups(deps.convex, climb.climbId);
  if (!groups) return { evidence: [], available: false };
  const steering = new Map(climb.groups.steeringCases.map((entry) => [entry.key, entry.tool]));
  const evidence: ClimbEvidence[] = [];
  const baselineRuns = groups.filter((group) => group.unitKey.startsWith("baseline:")).flatMap((group) => group.launchedRunIds);
  for (const runId of baselineRuns) {
    const run = await deps.client.getEvalRun({ projectId: scope.projectId, runId });
    const environmentId = run.environment?.id;
    if (!environmentId) continue;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const result = await deps.client.listEvalRunIterations({ projectId: scope.projectId, runId, cursor, limit: PAGE });
      for (const iteration of result.items) {
        const key = [iteration.caseId, iteration.testCaseId].find((candidate): candidate is string => !!candidate && steering.has(candidate));
        if (!key) continue;
        evidence.push(toEvidence(iteration, { runId, environmentId, key, tool: steering.get(key), climb, scope }));
      }
      cursor = result.nextCursor ?? undefined;
      if (!cursor) break;
    }
  }
  return { evidence, available: true };
}

function toEvidence(
  iteration: PlatformEvalIteration,
  ctx: { runId: string; environmentId: string; key: string; tool: string | undefined; climb: PlatformClimb; scope: EvidenceScope },
): ClimbEvidence {
  const stage = iteration.firstFailedStage;
  const row = stage ? iteration.stageResults?.find((candidate) => candidate.stage === stage) : undefined;
  const expectedTools = iteration.expectedToolCalls.map((call) => String(call.toolName ?? call.name ?? "")).filter(Boolean);
  return {
    runId: ctx.runId,
    iterationId: iteration.id,
    environmentId: ctx.environmentId,
    caseKey: ctx.key,
    ...(iteration.title ? { caseTitle: iteration.title } : {}),
    ...(ctx.tool ? { tool: ctx.tool } : {}),
    outcome: outcomeOf(iteration),
    ...(typeof iteration.usage?.totalTokens === "number" ? { tokens: iteration.usage.totalTokens } : {}),
    ...(typeof iteration.usage?.estimatedCostUsd === "number" ? { costUsd: iteration.usage.estimatedCostUsd } : {}),
    toolCalls: iteration.actualToolCalls.length,
    ...(stage ? { failedStage: { stage, ...(row?.reason ? { reason: row.reason } : {}) } } : {}),
    ...(iteration.failureCategory ? { failureCategory: iteration.failureCategory } : {}),
    ...(expectedTools.some((name) => !ctx.scope.listedTools.has(name)) ? { expectedToolNotListed: true } : {}),
    link: buildAppPermalink(
      {
        type: "eval_iteration",
        id: iteration.id,
        projectId: ctx.scope.projectId,
        parent: { type: "eval_run", id: ctx.runId, parent: { type: "eval_suite", id: ctx.climb.suiteId } },
      },
      { appOrigin: ctx.scope.appOrigin },
    ).url,
  };
}
