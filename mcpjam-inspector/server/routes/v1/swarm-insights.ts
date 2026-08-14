/**
 * Public v1 SWARM INSIGHTS surface — the layer above raw runs.
 *
 * A run tells you what happened once. The insights layer answers the questions
 * anyone actually has after a fan-out: which criteria are failing, is this new
 * or has it been failing for four waves, and what does the model make of the
 * whole batch. Until now all of it existed only behind the hosted UI's Convex
 * subscriptions, so an agent could launch a run and read its sessions but had
 * no way to reach the conclusion a human reading the same screen would draw.
 *
 * THREE KINDS OF THING LIVE HERE, and they are not interchangeable:
 *
 *   1. SCORECARD — deterministic. Rubric criteria, pass/fail/pending counts
 *      for one run. No model involved; the numbers are the numbers.
 *   2. FINDINGS — deterministic, aggregated across waves. A criterion that
 *      keeps failing becomes a finding with a streak. Dismissable.
 *   3. WAVE INSIGHTS — LLM-generated prose over a whole wave. Requested
 *      explicitly, produced asynchronously, and it SPENDS: the request draws
 *      on the org's shared `insightsPerDay` ledger.
 *
 * The distinction matters for how a caller uses them, which is why the reads
 * are separate routes rather than one fat run payload. An agent explaining a
 * failure should reach for the scorecard first — it is free, exact, and
 * usually the whole answer — and ask for wave insights only when the counts
 * do not explain themselves.
 *
 * `swarmRunGroupId` upstream is `waveId` here throughout, matching
 * `./journeys.ts`: the public meaning is "the batch this run was launched
 * with", and every solo relaunch is a wave of one.
 *
 * CROSS-PROJECT SCOPING. The scorecard route resolves the run and asserts the
 * project; wave routes take the project in the path and pass it to Convex,
 * which scopes on it. Findings have no scoped getter, so dismissal does a
 * list-and-scan preflight — the same bounded compromise `./personas.ts`
 * documents.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";

const swarmInsights = new Hono();

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.swarm-insights" });
}

// ── Convex row shapes (hand-mirrored) ───────────────────────────────────────

type ScorecardRow = {
  criteria: Array<{
    criterionId: string;
    label?: string;
    kind: string;
    passCount: number;
    failCount: number;
    pendingCount: number;
    failedGradingCount: number;
  }>;
  sessionsTotal: number;
  sessionsGraded: number;
};

type OverviewRow = {
  runs: Array<{
    runId: string;
    journeyRefId: string;
    journeyName: string;
    journeyArchived: boolean;
    personaName: string;
    createdAt: number;
    swarmRunGroupId?: string;
    status: string;
    summary: {
      total: number;
      succeeded: number;
      failed: number;
      rateLimited: number;
    };
    goalScoreSummary?: {
      gradedCount: number;
      passedCount: number;
      avgScore: number | null;
      pendingCount?: number;
      failedCount?: number;
    };
    findings: Array<{
      criterionId: string;
      label?: string;
      kind?: string;
      failCount: number;
      pendingCount: number;
      failedGradingCount: number;
      sessionsGraded: number;
      runStreak: number;
    }>;
    targets: Array<{
      hostName: string;
      modelId: string;
      environmentName?: string;
    }>;
  }>;
  runsConsidered: number;
  goalCompletion: {
    gradedCount: number;
    passedCount: number;
    passRate: number | null;
    runsWithGrades: number;
    trend: Array<{
      dayStartMs: number;
      gradedCount: number;
      passedCount: number;
      passRate: number;
    }>;
  };
};

type FindingRow = {
  findingId: string;
  fingerprint: string;
  dimension: string;
  subjectKind: string;
  subjectId: string;
  subjectLabel: string;
  status: string;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSeenGroupId: string;
  occurrenceCount: number;
  resolvedAt: number | null;
  dismissedAt: number | null;
  updatedAt: number;
};

type WaveInsightsRow = {
  status: "pending" | "completed" | "failed";
  insights: unknown | null;
  discovery: unknown | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: number;
};

// ── DTOs ────────────────────────────────────────────────────────────────────

function toScorecardDto(row: ScorecardRow, runId: string) {
  return {
    runId,
    /**
     * The rubric's OWN criteria, in the run snapshot's order — including any
     * nothing was graded against. An absent row would be indistinguishable
     * from a criterion that was never configured, which is the difference
     * between "we did not check" and "there was nothing to check".
     */
    criteria: row.criteria.map((criterion) => ({
      id: criterion.criterionId,
      label: criterion.label ?? null,
      kind: criterion.kind,
      passCount: criterion.passCount,
      failCount: criterion.failCount,
      /** Claimed for grading but unfinished — includes crashed runners. */
      pendingCount: criterion.pendingCount,
      /**
       * Sessions whose GRADING broke. Kept apart from `failCount` on purpose:
       * folding them together makes a crashed judge look like a product
       * regression, and someone acts on that.
       */
      failedGradingCount: criterion.failedGradingCount,
    })),
    sessionsTotal: row.sessionsTotal,
    sessionsGraded: row.sessionsGraded,
  };
}

function toOverviewDto(row: OverviewRow) {
  return {
    runs: row.runs.map((run) => ({
      runId: run.runId,
      journeyId: run.journeyRefId,
      journeyName: run.journeyName,
      journeyArchived: run.journeyArchived,
      personaName: run.personaName,
      status: run.status,
      ...(run.swarmRunGroupId !== undefined
        ? { waveId: run.swarmRunGroupId }
        : {}),
      summary: run.summary,
      goalCompletion: run.goalScoreSummary
        ? {
            gradedCount: run.goalScoreSummary.gradedCount,
            passedCount: run.goalScoreSummary.passedCount,
            avgScore: run.goalScoreSummary.avgScore,
            pendingCount: run.goalScoreSummary.pendingCount ?? null,
            failedCount: run.goalScoreSummary.failedCount ?? null,
          }
        : null,
      findings: run.findings.map((finding) => ({
        criterionId: finding.criterionId,
        label: finding.label ?? null,
        kind: finding.kind ?? null,
        failCount: finding.failCount,
        pendingCount: finding.pendingCount,
        failedGradingCount: finding.failedGradingCount,
        /**
         * The DENOMINATOR is graded sessions, never the session total. A
         * criterion that failed 3 of 4 graded sessions out of 40 attempted is
         * not a 7.5% failure, and reporting it as one would understate a real
         * regression by an order of magnitude.
         */
        sessionsGraded: finding.sessionsGraded,
        /** Consecutive runs of this journey where the criterion failed. */
        runStreak: finding.runStreak,
      })),
      targets: run.targets.map((target) => ({
        hostName: target.hostName,
        modelId: target.modelId,
        ...(target.environmentName !== undefined
          ? { environmentName: target.environmentName }
          : {}),
      })),
      createdAt: run.createdAt,
    })),
    runsConsidered: row.runsConsidered,
    goalCompletion: {
      gradedCount: row.goalCompletion.gradedCount,
      passedCount: row.goalCompletion.passedCount,
      /**
       * `null` when nothing has been graded — never 0. Zero would read as
       * "everything failed", which is the opposite of "we do not know yet".
       */
      passRate: row.goalCompletion.passRate,
      runsWithGrades: row.goalCompletion.runsWithGrades,
      trend: row.goalCompletion.trend,
    },
  };
}

function toFindingDto(row: FindingRow) {
  return {
    id: row.findingId,
    /** Stable identity across waves — what makes a streak a streak. */
    fingerprint: row.fingerprint,
    dimension: row.dimension,
    subject: {
      kind: row.subjectKind,
      id: row.subjectId,
      label: row.subjectLabel,
    },
    /** open | resolved | dismissed. */
    status: row.status,
    occurrenceCount: row.occurrenceCount,
    /** The wave this was last seen in. */
    lastSeenWaveId: row.lastSeenGroupId,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    resolvedAt: row.resolvedAt,
    dismissedAt: row.dismissedAt,
    updatedAt: row.updatedAt,
  };
}

function toWaveInsightsDto(row: WaveInsightsRow, waveId: string) {
  return {
    waveId,
    /**
     * pending | completed | failed. `pending` means a generation is in flight;
     * poll rather than re-requesting, which would either 409 or (with `force`)
     * spend a second time against the daily ledger.
     */
    status: row.status,
    /** Directed lane: findings the request asked about. Null until complete. */
    insights: row.insights,
    /**
     * Discovery lane: what the model noticed unprompted. Null while only the
     * directed lane has finished — a completed `insights` with a null
     * `discovery` is a normal intermediate state, not an error.
     */
    discovery: row.discovery,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    updatedAt: row.updatedAt,
  };
}

// ── Preflights ──────────────────────────────────────────────────────────────

/** Assert `runId` belongs to `projectId`. Mirrors `./journeys.ts`. */
async function requireRunInProject(
  client: ConvexHttpClient,
  projectId: string,
  runId: string
): Promise<void> {
  let run: { projectId?: string } | null;
  try {
    run = (await client.query(
      "journeyRuns:getJourneyRun" as never,
      { runId } as never
    )) as { projectId?: string } | null;
  } catch (error) {
    throw translateReadError(error);
  }
  if (!run || String(run.projectId) !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Journey run not found");
  }
}

async function listFindingRows(
  client: ConvexHttpClient,
  projectId: string
): Promise<FindingRow[]> {
  try {
    return ((await client.query(
      "swarmWaveInsights:listSwarmFindings" as never,
      { projectId } as never
    )) ?? []) as FindingRow[];
  } catch (error) {
    throw translateReadError(error);
  }
}

/**
 * Assert `findingId` belongs to `projectId`.
 *
 * LIST-AND-SCAN, because `swarmWaveInsights:dismissFinding` takes a finding id
 * alone and resolves the project from the row — so without this,
 * `POST /projects/A/journey-findings/{a-finding-in-B}/dismiss` would dismiss
 * B's finding through A's URL for a member of both. The list is the project's
 * open findings, which is bounded in practice; if a scoped getter ever lands
 * upstream, this should become a single read.
 */
async function requireFindingInProject(
  client: ConvexHttpClient,
  projectId: string,
  findingId: string
): Promise<FindingRow> {
  const row = (await listFindingRows(client, projectId)).find(
    (candidate) => String(candidate.findingId) === findingId
  );
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Finding not found");
  }
  return row;
}

// ── Reads ───────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/journeys-overview
//
// NOT `/journeys/overview`: that path would be matched by the
// `/journeys/:journeyId` route registered in `./journeys.ts`, and which one
// won would depend on mount order — a caller asking for the overview would
// intermittently get a 404 for a journey named "overview". A distinct segment
// cannot collide.
swarmInsights.get("/projects/:projectId/journeys-overview", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let row: OverviewRow;
  try {
    row = (await client.query(
      "journeyRuns:getSwarmOverview" as never,
      { projectId } as never
    )) as OverviewRow;
  } catch (error) {
    throw translateReadError(error);
  }
  return v1Resource(c, toOverviewDto(row));
});

// GET /v1/projects/:projectId/journey-runs/:runId/scorecard
swarmInsights.get(
  "/projects/:projectId/journey-runs/:runId/scorecard",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireRunInProject(client, projectId, runId);

    let row: ScorecardRow | null;
    try {
      row = (await client.query(
        "journeyRuns:getRunScorecard" as never,
        { runId } as never
      )) as ScorecardRow | null;
    } catch (error) {
      throw translateReadError(error);
    }
    if (!row) {
      // The run exists (the preflight proved it) but carries no rubric, so
      // there is no scorecard to serve. An empty criteria list would imply a
      // rubric that graded nothing, which is a different and misleading claim.
      throw new WebRouteError(
        404,
        ErrorCode.NOT_FOUND,
        "This run has no rubric, so it has no scorecard"
      );
    }
    return v1Resource(c, toScorecardDto(row, runId));
  }
);

// GET /v1/projects/:projectId/journey-findings
swarmInsights.get("/projects/:projectId/journey-findings", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const rows = await listFindingRows(client, projectId);
  return v1PageJson(c, rows.map(toFindingDto));
});

// GET /v1/projects/:projectId/waves/:waveId/insights
swarmInsights.get("/projects/:projectId/waves/:waveId/insights", async (c) => {
  const projectId = c.req.param("projectId");
  const waveId = c.req.param("waveId");
  const client = createConvexClient(await getConvexBearerForRequest(c));

  let row: WaveInsightsRow | null;
  try {
    row = (await client.query(
      "swarmWaveInsights:getWaveInsights" as never,
      { projectId, swarmRunGroupId: waveId } as never
    )) as WaveInsightsRow | null;
  } catch (error) {
    throw translateReadError(error);
  }
  if (!row) {
    // Never requested. 404 rather than an empty `status: "none"` body, so a
    // caller polling in a loop cannot mistake "nobody asked for this" for
    // "asked and still working".
    throw new WebRouteError(
      404,
      ErrorCode.NOT_FOUND,
      "No insights have been requested for this wave"
    );
  }
  return v1Resource(c, toWaveInsightsDto(row, waveId));
});

// ── Writes ──────────────────────────────────────────────────────────────────

const requestInsightsSchema = z
  .strictObject({
    /**
     * Regenerate over a wave that already has insights. Off by default because
     * it SPENDS a second time against the org's shared daily ledger, and the
     * common cause of a repeated request is a caller that did not poll.
     */
    force: z.boolean().optional(),
  })
  .optional();

// POST /v1/projects/:projectId/waves/:waveId/insights
//
// Answers **202**: generation is scheduled, not done. Poll the GET above.
//
// SPENDS. The org's `insightsPerDay` ledger is shared with user-testing window
// insights, so a caller that burns it here has taken it from there too. The
// ledger's rejection arrives as 429 and the beta gate's as a distinct 403 —
// collapsing them would tell an org that hit its daily cap that the feature is
// unavailable to them, and they would go and ask for a plan they already have.
swarmInsights.post("/projects/:projectId/waves/:waveId/insights", async (c) => {
  const projectId = c.req.param("projectId");
  const waveId = c.req.param("waveId");
  const raw = (await c.req.text()).trim();
  let body: { force?: boolean } | undefined;
  if (raw.length > 0) {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        "Request body must be JSON"
      );
    }
    const parsed = requestInsightsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues[0]?.message ?? "Invalid request body"
      );
    }
    body = parsed.data;
  }

  const client = createConvexClient(await getConvexBearerForRequest(c));
  try {
    await client.mutation(
      "swarmWaveInsights:requestWaveInsights" as never,
      {
        projectId,
        swarmRunGroupId: waveId,
        ...(body?.force ? { force: true } : {}),
      } as never
    );
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Wave insights" });
  }

  return v1Resource(c, { waveId, projectId, status: "pending" }, 202);
});

// DELETE /v1/projects/:projectId/waves/:waveId/insights
//
// Cancel an in-flight generation. Parity with the UI, and the recovery path
// when a request was made by mistake or its runner went silent — without it a
// wave stuck in `pending` can never be re-requested without `force`, which
// spends again.
swarmInsights.delete(
  "/projects/:projectId/waves/:waveId/insights",
  async (c) => {
    const projectId = c.req.param("projectId");
    const waveId = c.req.param("waveId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    try {
      await client.mutation(
        "swarmWaveInsights:cancelWaveInsights" as never,
        { projectId, swarmRunGroupId: waveId } as never
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Wave insights" });
    }
    return v1Resource(c, { waveId, projectId, canceled: true });
  }
);

// POST /v1/projects/:projectId/journey-findings/:findingId/dismiss
swarmInsights.post(
  "/projects/:projectId/journey-findings/:findingId/dismiss",
  async (c) => {
    const projectId = c.req.param("projectId");
    const findingId = c.req.param("findingId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireFindingInProject(client, projectId, findingId);
    try {
      await client.mutation(
        "swarmWaveInsights:dismissFinding" as never,
        { findingId } as never
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Finding" });
    }
    return v1Resource(c, { id: findingId, projectId, dismissed: true });
  }
);

// POST /v1/projects/:projectId/journey-findings/:findingId/undismiss
//
// The counterpart, and it earns its own route rather than a PATCH with a
// boolean: dismissing is a judgement someone made, and undoing it is a
// deliberate act, not a field edit.
swarmInsights.post(
  "/projects/:projectId/journey-findings/:findingId/undismiss",
  async (c) => {
    const projectId = c.req.param("projectId");
    const findingId = c.req.param("findingId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireFindingInProject(client, projectId, findingId);
    try {
      await client.mutation(
        "swarmWaveInsights:undismissFinding" as never,
        { findingId } as never
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Finding" });
    }
    return v1Resource(c, { id: findingId, projectId, dismissed: false });
  }
);

export default swarmInsights;
