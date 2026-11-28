/**
 * Public v1 reads of ONE swarm run: the goal runs launched together under one
 * `swarmRunId` (stored as `journeyRuns.swarmRunGroupId`).
 *
 *   GET /projects/:projectId/swarm-runs/:swarmRunId[?include=launchFailures]
 *     `swarmRuns:getSwarmRun`, the query the swarm run page reads. With
 *     `include=launchFailures`, also `journeyRuns:listRunLaunchFailures` over
 *     its goal runs, returned as `launchFailures`: why sessions never ran, as
 *     the page explains them. Opt-in, because that read scans every attempt
 *     of every goal run and agents poll this route.
 *   GET /projects/:projectId/swarm-runs/:swarmRunId/sessions?cursor&limit
 *     `swarmRuns:listSwarmRunSessions`: goal run by goal run, oldest first.
 *
 * Both swarm run queries take the project and check membership, so scoping is
 * enforced upstream rather than by a preflight here. Each backend function
 * name is spelled out in this file because the agent parity scan reads route
 * files, not the modules they call.
 *
 * Guest-DENIED by default: no GUEST_ALLOWED_V1_RULES entry matches these.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { convexErrorData } from "./convex-errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { toGoalSessionDto, type JourneySessionRow } from "./goals.js";
import {
  toSwarmRunDto,
  type RunLaunchFailuresRow,
  type SwarmRunViewRow,
} from "./swarm-run-dto.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";

const SCOPE = "v1.swarm-runs";
const NOT_FOUND = "Swarm run not found";

const swarmRunReads = new Hono();

/**
 * For each route's first read, which decides whether the caller may see the
 * project: production masks a membership refusal to "Server Error", and that
 * answers the 404 a missing swarm run gets (MJ-021), not a 502.
 */
function translateScopingReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, {
    scope: SCOPE,
    notFoundMessage: NOT_FOUND,
    redactedIsRefusal: true,
  });
}

/**
 * Why sessions never ran. Read after the swarm run, whose goal runs (at most
 * 100, the backend's cap here too) are all in this project: a failure is ours.
 */
async function readLaunchFailures(
  client: ConvexHttpClient,
  runIds: readonly string[],
): Promise<RunLaunchFailuresRow[]> {
  if (runIds.length === 0) return [];
  try {
    return (await client.query(
      "journeyRuns:listRunLaunchFailures" as never,
      { journeyRunIds: runIds } as never,
    )) as RunLaunchFailuresRow[];
  } catch (error) {
    throw translateConvexReadError(error, { scope: SCOPE });
  }
}

/** `include` names the optional parts of the read; there is one so far. */
const swarmRunQuery = z.object({
  include: z.literal("launchFailures").optional(),
});

// GET /v1/projects/:projectId/swarm-runs/:swarmRunId
swarmRunReads.get("/projects/:projectId/swarm-runs/:swarmRunId", async (c) => {
  const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
  const swarmRunId = c.req.param("swarmRunId");
  const { include } = parseWithSchema(swarmRunQuery, c.req.query());
  const client = createConvexClient(await getConvexBearerForRequest(c));

  let view: SwarmRunViewRow | null;
  try {
    view = (await client.query(
      "swarmRuns:getSwarmRun" as never,
      { projectId, swarmRunId } as never,
    )) as SwarmRunViewRow | null;
  } catch (error) {
    throw translateScopingReadError(error);
  }
  if (!view) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, NOT_FOUND);
  }
  const launchFailures =
    include === "launchFailures"
      ? await readLaunchFailures(
          client,
          view.runs.map((run) => run.runId),
        )
      : undefined;
  return v1Resource(c, toSwarmRunDto(view, launchFailures));
});

/** A `swarmRuns:listSwarmRunSessions` row: the shared session row, placed. */
type SwarmRunSessionRow = JourneySessionRow & {
  goalId: string;
  runId: string;
  outcome?: string | null;
};

/** A row as `list_goal_run_sessions` returns one, always naming its goal run. */
function toSwarmRunSessionDto(row: SwarmRunSessionRow) {
  return {
    ...toGoalSessionDto(row, { legacy: false }, row.outcome ?? null),
    goalId: row.goalId,
    runId: row.runId,
  };
}

/** The page parameters. The backend takes 1-200 and defaults to 50. */
const sessionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** The backend's refusal of a cursor it did not issue for this swarm run. */
const INVALID_CURSOR = "INVALID_CURSOR";

// GET /v1/projects/:projectId/swarm-runs/:swarmRunId/sessions
//
// An opaque cursor walks the goal runs oldest first, filling each page across
// them. `nextCursor` is present while sessions remain.
swarmRunReads.get(
  "/projects/:projectId/swarm-runs/:swarmRunId/sessions",
  async (c) => {
    const projectId = requireProjectIdArg(c.req.param("projectId"), SCOPE);
    const swarmRunId = c.req.param("swarmRunId");
    const { cursor, limit } = parseWithSchema(sessionsQuery, c.req.query());
    const client = createConvexClient(await getConvexBearerForRequest(c));

    let page: { items: SwarmRunSessionRow[]; nextCursor?: string };
    try {
      page = (await client.query(
        "swarmRuns:listSwarmRunSessions" as never,
        {
          projectId,
          swarmRunId,
          ...(cursor ? { cursor } : {}),
          ...(limit !== undefined ? { limit } : {}),
        } as never,
      )) as typeof page;
    } catch (error) {
      const data = convexErrorData(error);
      if (data?.code === INVALID_CURSOR) {
        // The caller's to fix, by paging again from the start.
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          typeof data.message === "string" && data.message.trim()
            ? data.message
            : "cursor: Send the nextCursor of the page before, unchanged, or leave it out to start again.",
          { code: INVALID_CURSOR },
        );
      }
      throw translateScopingReadError(error);
    }
    return v1PageJson(
      c,
      page.items.map(toSwarmRunSessionDto),
      page.nextCursor || undefined,
    );
  },
);

export default swarmRunReads;
