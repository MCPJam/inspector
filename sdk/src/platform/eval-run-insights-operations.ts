/**
 * Eval run analysis on every agent surface: request, cancel, and the findings
 * build the analysis explains.
 *
 * The app's Analyze button builds findings when a run has none, then starts
 * the analysis. These three operations are those steps, so an agent reaches
 * the same result the run page shows. Results are read from `get_eval_run`'s
 * `insights` envelope; none of these returns findings.
 */
import { z } from "zod";
import type { PlatformOperation } from "./operations.js";
import {
  evalRunScopedInput,
  resolveProjectOrThrow,
  toSelectedProjectInfo,
  type EvalRunScopedInput,
} from "./operation-support.js";
import { noPermalink } from "./permalinks.js";
import type { SelectedProjectInfo } from "./show-servers.js";
import type {
  PlatformEvalRunFindingsBuildRequested,
  PlatformEvalRunInsightsCanceled,
  PlatformEvalRunInsightsRequested,
} from "./types.js";

const requestEvalRunInsightsInput = evalRunScopedInput.extend({
  force: z
    .boolean()
    .optional()
    .describe(
      "Rerun over a run whose analysis already finished. Takes another unit of the daily insight quota (no credits either way). Read get_eval_run first: a finished analysis is already there."
    ),
});

export type RequestEvalRunInsightsInput = z.infer<
  typeof requestEvalRunInsightsInput
>;
export type RequestEvalRunInsightsResult = {
  project: SelectedProjectInfo;
  request: PlatformEvalRunInsightsRequested;
};

export const requestEvalRunInsightsOperation: PlatformOperation<
  RequestEvalRunInsightsInput,
  RequestEvalRunInsightsResult
> = {
  name: "request_eval_run_insights",
  title: "Request MCPJam eval run insights",
  description:
    "Start the findings analysis of a finished eval run, the same analysis the app's run page runs: a model explains the run's findings with cited evidence. Returns immediately with status pending; poll get_eval_run until `insights.status` is completed, then read `insights.findings`. Most finished runs are analyzed automatically, so read get_eval_run first. Included with MCPJam; no customer credits consumed; it counts against the organization's daily insight quota, shared with goal, study and user-testing insights. Refused with CONFLICT while an analysis is running (cancel it with cancel_eval_run_insights), when one already finished and `force` is absent, and when the run has no findings yet (`insights.unifiedFindings.snapshot` is null): call build_eval_run_findings first.",
  readOnly: false,
  risk: "none",
  permalink: noPermalink("mutation-only"),
  inputSchema: requestEvalRunInsightsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const request = await client.requestEvalRunInsights(
      {
        projectId: project.id,
        runId: input.runId,
        ...(input.force ? { force: true } : {}),
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), request };
  },
};

export type CancelEvalRunInsightsResult = {
  project: SelectedProjectInfo;
  canceled: PlatformEvalRunInsightsCanceled;
};

export const cancelEvalRunInsightsOperation: PlatformOperation<
  EvalRunScopedInput,
  CancelEvalRunInsightsResult
> = {
  name: "cancel_eval_run_insights",
  title: "Cancel an MCPJam eval run insights request",
  description:
    "Stop a running eval run analysis. This is the recovery path for a run stuck in pending, which cannot be re-requested even with force. Afterwards get_eval_run reads `insights.status` failed with reasonCode cancelled. Refused with CONFLICT when no analysis is running.",
  readOnly: false,
  risk: "none",
  permalink: noPermalink("mutation-only"),
  inputSchema: evalRunScopedInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const canceled = await client.cancelEvalRunInsights(
      { projectId: project.id, runId: input.runId },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), canceled };
  },
};

const buildEvalRunFindingsInput = evalRunScopedInput.extend({
  force: z
    .boolean()
    .optional()
    .describe(
      "Rebuild over findings that already exist, for example when `insights.unifiedFindings.snapshot.enrichment.status` is stale."
    ),
});

export type BuildEvalRunFindingsInput = z.infer<
  typeof buildEvalRunFindingsInput
>;
export type BuildEvalRunFindingsResult = {
  project: SelectedProjectInfo;
  build: PlatformEvalRunFindingsBuildRequested;
};

export const buildEvalRunFindingsOperation: PlatformOperation<
  BuildEvalRunFindingsInput,
  BuildEvalRunFindingsResult
> = {
  name: "build_eval_run_findings",
  title: "Build MCPJam eval run findings",
  description:
    "Build (or with force, rebuild) a settled eval run's findings from its recorded evidence. Deterministic: no model call, no credits, no quota. Returns immediately with status pending; poll get_eval_run until `insights.unifiedFindings.job.status` is completed. On a run that has never been analyzed, a finished build starts the analysis automatically, which counts against the daily insight quota; otherwise call request_eval_run_insights afterwards. When the explanation is stale (`insights.unifiedFindings.snapshot.enrichment.status` is stale), rebuild with force, then request the analysis with force, as the app does. Refused with CONFLICT while a build is running, when findings exist and `force` is absent, and while the run is still running or grading.",
  readOnly: false,
  risk: "none",
  permalink: noPermalink("mutation-only"),
  inputSchema: buildEvalRunFindingsInput,
  async execute(input, { client, signal, onScopeResolved }) {
    const { project } = await resolveProjectOrThrow(
      { client, signal, onScopeResolved },
      input.project
    );
    const build = await client.buildEvalRunFindings(
      {
        projectId: project.id,
        runId: input.runId,
        ...(input.force ? { force: true } : {}),
      },
      { signal }
    );
    return { project: toSelectedProjectInfo(project), build };
  },
};
