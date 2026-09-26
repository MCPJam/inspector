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
import type { Context } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { markDeprecated } from "./deprecation.js";
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
      // `get_swarms_overview` KEPT its name through the goal rename, so this
      // shape has no renamed twin to carry the new spellings. It emits both
      // until GA: the `goal*`/`swarmRunId` names are canonical, the
      // `journey*`/`waveId` ones are here for callers written before it.
      goalId: run.journeyRefId,
      goalName: run.journeyName,
      goalArchived: run.journeyArchived,
      journeyId: run.journeyRefId,
      journeyName: run.journeyName,
      journeyArchived: run.journeyArchived,
      personaName: run.personaName,
      status: run.status,
      ...(run.swarmRunGroupId !== undefined
        ? { swarmRunId: run.swarmRunGroupId, waveId: run.swarmRunGroupId }
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
        /** Consecutive runs of this goal where the criterion failed. */
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
    /**
     * `new | recurring | regressed | resolved` — the backend's own union
     * (mcpjam-backend schema.ts `swarmFindings.status`), which is a LIFECYCLE:
     * first seen, seen again, came back after being resolved, stopped firing.
     *
     * This comment used to read `open | resolved | dismissed`, which was wrong
     * in both directions. Three of the four real values were missing, and
     * `dismissed` is not a status at all — dismissal is the orthogonal
     * `dismissedAt` below, set by the dismiss endpoints. A finding can be both
     * recurring and dismissed, and collapsing them would make that
     * unrepresentable.
     */
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

/**
 * `legacy` decides only the key the batch id is spelled under: the canonical
 * `/swarm-runs` surface says `swarmRunId`, the deprecated `/waves` one keeps
 * saying `waveId` for the callers it exists for. The stored column is
 * `swarmRunGroupId` on both and does not move.
 */
function toSwarmRunInsightsDto(
  row: WaveInsightsRow,
  swarmRunId: string,
  surface: { legacy: boolean },
) {
  return {
    [surface.legacy ? "waveId" : "swarmRunId"]: swarmRunId,
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
  runId: string,
): Promise<void> {
  let run: { projectId?: string } | null;
  try {
    run = (await client.query(
      "journeyRuns:getJourneyRun" as never,
      { runId } as never,
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
  projectId: string,
): Promise<FindingRow[]> {
  try {
    return ((await client.query(
      "swarmWaveInsights:listSwarmFindings" as never,
      { projectId } as never,
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
  findingId: string,
): Promise<FindingRow> {
  const row = (await listFindingRows(client, projectId)).find(
    (candidate) => String(candidate.findingId) === findingId,
  );
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Finding not found");
  }
  return row;
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * Register one route under its canonical path and its pre-rename alias.
 *
 * Same handler, same authorization, same body — only the path differs, so the
 * alias carries `Deprecation: true` and nothing else about it is special.
 * Deleted at GA. The operations reached through these paths KEPT their names
 * (`get_swarms_overview`, `list_swarm_findings`); it is the routes underneath
 * them that moved with the noun.
 */
function both(
  method: "get" | "post",
  canonicalPath: string,
  legacyPath: string,
  handler: (c: Context) => Promise<Response>,
): void {
  swarmInsights[method](canonicalPath, handler);
  swarmInsights[method](legacyPath, (c) => {
    markDeprecated(c, `/api/v1${canonicalPath.replace(/:(\w+)/g, "{$1}")}`);
    return handler(c);
  });
}

// GET /v1/projects/:projectId/goals-overview   (alias: /journeys-overview)
//
// NOT `/goals/overview`: that path would be matched by the `/goals/:goalId`
// route registered in `./goals.ts`, and which one won would depend on mount
// order — a caller asking for the overview would intermittently get a 404 for
// a goal named "overview". A distinct segment cannot collide.
both(
  "get",
  "/projects/:projectId/goals-overview",
  "/projects/:projectId/journeys-overview",
  async (c) => {
    const projectId = c.req.param("projectId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    let row: OverviewRow;
    try {
      row = (await client.query(
        "journeyRuns:getSwarmOverview" as never,
        { projectId } as never,
      )) as OverviewRow;
    } catch (error) {
      throw translateReadError(error);
    }
    return v1Resource(c, toOverviewDto(row));
  },
);

// GET /v1/projects/:projectId/goal-runs/:runId/scorecard
//   (alias: /journey-runs/:runId/scorecard)
both(
  "get",
  "/projects/:projectId/goal-runs/:runId/scorecard",
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
        { runId } as never,
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
        "This run has no rubric, so it has no scorecard",
      );
    }
    return v1Resource(c, toScorecardDto(row, runId));
  },
);

// GET /v1/projects/:projectId/goal-findings   (alias: /journey-findings)
both(
  "get",
  "/projects/:projectId/goal-findings",
  "/projects/:projectId/journey-findings",
  async (c) => {
    const projectId = c.req.param("projectId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    const rows = await listFindingRows(client, projectId);
    return v1PageJson(c, rows.map(toFindingDto));
  },
);

/**
 * The batch id off the path, under whichever spelling the surface addresses
 * it by. `swarmRunGroupId` upstream on both.
 */
function swarmRunIdParam(c: Context, surface: { legacy: boolean }): string {
  return c.req.param(surface.legacy ? "waveId" : "swarmRunId");
}

/** Register one insights route on both spellings, deprecating the old one. */
function bothInsights(
  method: "get" | "post" | "delete",
  suffix: string,
  handler: (c: Context, surface: { legacy: boolean }) => Promise<Response>,
): void {
  const canonical = `/projects/:projectId/swarm-runs/:swarmRunId${suffix}`;
  swarmInsights[method](canonical, (c) => handler(c, { legacy: false }));
  swarmInsights[method](`/projects/:projectId/waves/:waveId${suffix}`, (c) => {
    markDeprecated(
      c,
      "/api/v1/projects/{projectId}/swarm-runs/{swarmRunId}/insights",
    );
    return handler(c, { legacy: true });
  });
}

// GET /v1/projects/:projectId/swarm-runs/:swarmRunId/insights
//   (alias: /waves/:waveId/insights)
bothInsights("get", "/insights", async (c, surface) => {
  const projectId = c.req.param("projectId");
  const swarmRunId = swarmRunIdParam(c, surface);
  const client = createConvexClient(await getConvexBearerForRequest(c));

  let row: WaveInsightsRow | null;
  try {
    row = (await client.query(
      "swarmWaveInsights:getWaveInsights" as never,
      { projectId, swarmRunGroupId: swarmRunId } as never,
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
      surface.legacy
        ? "No insights have been requested for this wave"
        : "No insights have been requested for this swarm run",
    );
  }
  return v1Resource(c, toSwarmRunInsightsDto(row, swarmRunId, surface));
});

// ── Writes ──────────────────────────────────────────────────────────────────

const requestInsightsSchema = z
  .strictObject({
    /**
     * Regenerate over a swarm run that already has insights. Off by default
     * because it SPENDS a second time against the org's shared daily ledger,
     * and the common cause of a repeated request is a caller that did not poll.
     */
    force: z.boolean().optional(),
  })
  .optional();

// POST /v1/projects/:projectId/swarm-runs/:swarmRunId/insights
//   (alias: /waves/:waveId/insights)
//
// Answers **202**: generation is scheduled, not done. Poll the GET above.
//
// SPENDS, and now in two ways. The org's `insightsPerDay` ledger is shared with
// user-testing window insights, so a caller that burns it here has taken it
// from there too — and the generation itself DEBITS the org's model budget
// (it used to be priced and charged to nobody).
//
// Two 429s can come back, and they mean different waits: the per-minute burst
// brake (`rate_limited`, seconds) and the daily ledger
// (`billing_limit_reached`, until the UTC roll). Both carry `Retry-After`. The
// beta gate's refusal stays a distinct 403 — collapsing it into the 429s would
// tell an org that hit its daily cap that the feature is unavailable to them,
// and they would go and ask for a plan they already have.
bothInsights("post", "/insights", async (c, surface) => {
  const projectId = c.req.param("projectId");
  const swarmRunId = swarmRunIdParam(c, surface);
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
        "Request body must be JSON",
      );
    }
    const parsed = requestInsightsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues[0]?.message ?? "Invalid request body",
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
        swarmRunGroupId: swarmRunId,
        ...(body?.force ? { force: true } : {}),
      } as never,
    );
  } catch (error) {
    throw translateConvexWriteError(error, {
      resource: surface.legacy ? "Wave insights" : "Swarm run insights",
    });
  }

  return v1Resource(
    c,
    {
      [surface.legacy ? "waveId" : "swarmRunId"]: swarmRunId,
      projectId,
      status: "pending",
    },
    202,
  );
});

// DELETE /v1/projects/:projectId/swarm-runs/:swarmRunId/insights
//   (alias: /waves/:waveId/insights)
//
// Cancel an in-flight generation. Parity with the UI, and the recovery path
// when a request was made by mistake or its runner went silent — without it a
// swarm run stuck in `pending` can never be re-requested without `force`,
// which spends again.
bothInsights("delete", "/insights", async (c, surface) => {
  const projectId = c.req.param("projectId");
  const swarmRunId = swarmRunIdParam(c, surface);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  try {
    await client.mutation(
      "swarmWaveInsights:cancelWaveInsights" as never,
      { projectId, swarmRunGroupId: swarmRunId } as never,
    );
  } catch (error) {
    throw translateConvexWriteError(error, {
      resource: surface.legacy ? "Wave insights" : "Swarm run insights",
    });
  }
  return v1Resource(c, {
    [surface.legacy ? "waveId" : "swarmRunId"]: swarmRunId,
    projectId,
    canceled: true,
  });
});

// POST /v1/projects/:projectId/goal-findings/:findingId/dismiss
//   (alias: /journey-findings/:findingId/dismiss)
both(
  "post",
  "/projects/:projectId/goal-findings/:findingId/dismiss",
  "/projects/:projectId/journey-findings/:findingId/dismiss",
  async (c) => {
    const projectId = c.req.param("projectId");
    const findingId = c.req.param("findingId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireFindingInProject(client, projectId, findingId);
    try {
      await client.mutation(
        "swarmWaveInsights:dismissFinding" as never,
        { findingId } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Finding" });
    }
    return v1Resource(c, { id: findingId, projectId, dismissed: true });
  },
);

// POST /v1/projects/:projectId/goal-findings/:findingId/undismiss
//   (alias: /journey-findings/:findingId/undismiss)
//
// The counterpart, and it earns its own route rather than a PATCH with a
// boolean: dismissing is a judgement someone made, and undoing it is a
// deliberate act, not a field edit.
both(
  "post",
  "/projects/:projectId/goal-findings/:findingId/undismiss",
  "/projects/:projectId/journey-findings/:findingId/undismiss",
  async (c) => {
    const projectId = c.req.param("projectId");
    const findingId = c.req.param("findingId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    await requireFindingInProject(client, projectId, findingId);
    try {
      await client.mutation(
        "swarmWaveInsights:undismissFinding" as never,
        { findingId } as never,
      );
    } catch (error) {
      throw translateConvexWriteError(error, { resource: "Finding" });
    }
    return v1Resource(c, { id: findingId, projectId, dismissed: false });
  },
);

export default swarmInsights;
