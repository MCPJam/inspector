/**
 * Public v1 surface for Claude directory-readiness runs.
 *
 * ASYNCHRONOUS ON PURPOSE. A readiness run dials somebody else's server,
 * traces its redirects, reads its metadata and opens an MCP connection — tens
 * of seconds on a healthy target and longer on a sick one. Running that inside
 * the POST would put a third party's latency on the caller's request timeout,
 * and lose the whole grade when a proxy gave up first. So the POST enqueues a
 * durable row and answers `202`; a worker on some inspector node claims it,
 * and the caller polls the run.
 *
 * WHY THE URL IS NOT A REQUEST FIELD. The run grades the connector as it is
 * SAVED, so the URL comes off the server record rather than the body. A caller
 * who could name a URL here could point somebody else's project's readiness
 * history at an arbitrary host, and the grade would be filed against a
 * connector it never described. The CLI, which grades an arbitrary URL, is the
 * surface for that — it runs on the caller's own machine.
 *
 * AUTHORIZATION IS CONVEX'S. `requestReadinessRun` requires project `member`,
 * the reads require `guest`, and cancellation requires `member`. This module
 * adds one check of its own: that the server named in the path really belongs
 * to the project named in the path, so a cross-project server id cannot become
 * a run filed under a project the caller does happen to belong to.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { ConvexHttpClient } from "convex/browser";
import { createConvexClient } from "./convex-client.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { v1PageJson, v1Resource } from "./envelope.js";
import { translateConvexWriteError } from "./convex-errors.js";
import {
  classifyConvexReadError,
  translateConvexReadError,
} from "./convex-read-errors.js";

const claudeReadiness = new Hono();

/** What a caller may say about a run they are asking for. */
const requestRunSchema = z
  .strictObject({
    /**
     * Replay protection. A retried POST that started a second run would dial
     * the target twice, so the key is checked and the row inserted in one
     * Convex mutation.
     */
    idempotencyKey: z.string().min(1).max(200).optional(),
  })
  .optional();

/**
 * A saved server, or a 404.
 *
 * Scoped by project on purpose: a server id from another project comes back
 * as "not found", which is the same answer as one that does not exist. That is
 * what keeps this from being an existence oracle for other people's projects.
 */
async function requireServerInProject(
  client: ConvexHttpClient,
  projectId: string,
  serverId: string,
): Promise<{ url: string }> {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await client.query("servers:getProjectServers" as never, {
      projectId,
    } as never)) as Array<Record<string, unknown>>;
  } catch (error) {
    // A membership refusal is a 404 for the same reason as a cross-project id.
    // A bad credential is a 401 and an outage a 502, because a client told
    // "not found" during either will reasonably conclude the server is gone.
    const failure = classifyConvexReadError(error);
    if (failure.kind !== "membership") {
      throw translateConvexReadError(error, { scope: "v1.claudeReadiness" });
    }
    rows = [];
  }

  const row = rows.find(
    (candidate) => String(candidate._id ?? candidate.id) === serverId,
  );
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Server not found");
  }

  const url = typeof row.url === "string" ? row.url.trim() : "";
  if (!url) {
    // A STDIO server has no URL to grade, and Anthropic's directory lists
    // remote connectors. Saying so beats grading nothing and reporting
    // `incomplete` for reasons the caller cannot act on.
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Readiness grades a remote connector URL, and this server has none. Directory submissions are remote MCP servers.",
    );
  }
  return { url };
}

async function readOptionalJsonBody(c: {
  req: { text: () => Promise<string> };
}): Promise<unknown> {
  const raw = (await c.req.text()).trim();
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON",
    );
  }
}

// POST /v1/projects/:projectId/servers/:serverId/claude-readiness-runs
//
// Enqueue a run. 202 with the run, because nothing has been graded yet — the
// status is `pending` and the lanes are empty until a worker finishes.
claudeReadiness.post(
  "/projects/:projectId/servers/:serverId/claude-readiness-runs",
  async (c) => {
    const projectId = c.req.param("projectId");
    const serverId = c.req.param("serverId");
    const parsed = requestRunSchema.safeParse(await readOptionalJsonBody(c));
    if (!parsed.success) {
      throw new WebRouteError(
        400,
        ErrorCode.VALIDATION_ERROR,
        parsed.error.issues[0]?.message ?? "Invalid request body",
      );
    }
    const body = parsed.data ?? {};

    const client = createConvexClient(await getConvexBearerForRequest(c));
    const server = await requireServerInProject(client, projectId, serverId);

    let result: { runId: string; jobId: string; reused: boolean };
    try {
      result = (await client.mutation(
        "claudeReadinessRuns:requestReadinessRun" as never,
        {
          projectId,
          serverId,
          serverUrl: server.url,
          ...(body.idempotencyKey !== undefined
            ? { idempotencyKey: body.idempotencyKey }
            : {}),
          // A hosted run is headless and holds no credential of the caller's,
          // which is also what makes the SDK's intrusive resolver refuse to
          // arm: there is no grant here to spend. Stated rather than left to
          // a default, because the run's own report is graded against it.
          authMode: "headless",
          capabilities: ["dns", "raw-origin"],
        } as never,
      )) as { runId: string; jobId: string; reused: boolean };
    } catch (error) {
      throw translateConvexWriteError(error, {
        resource: "Readiness run",
        // Already a project member (Convex checked), so naming the role
        // requirement is actionable and reveals nothing new.
        adminFailureIsForbidden: true,
      });
    }

    // The JOB ID IS NOT RETURNED. It is the executing node's lease, not a
    // handle for the caller; every read below addresses the run by its id.
    return v1Resource(
      c,
      { id: result.runId, status: "pending", reused: result.reused },
      // 200 on a replay: nothing new was created, and a caller retrying after
      // a dropped response should be able to tell.
      result.reused ? 200 : 202,
    );
  },
);

// GET /v1/projects/:projectId/claude-readiness-runs — recent runs.
claudeReadiness.get("/projects/:projectId/claude-readiness-runs", async (c) => {
  const projectId = c.req.param("projectId");
  const serverId = c.req.query("serverId");
  const limitRaw = c.req.query("limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "limit must be a positive integer",
    );
  }

  const client = createConvexClient(await getConvexBearerForRequest(c));
  try {
    const rows = (await client.query(
      "claudeReadinessRuns:listReadinessRuns" as never,
      {
        projectId,
        ...(serverId ? { serverId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      } as never,
    )) as unknown[];
    return v1PageJson(c, rows);
  } catch (error) {
    throw translateConvexReadError(error, { scope: "v1.claudeReadiness" });
  }
});

// GET /v1/projects/:projectId/claude-readiness-runs/:runId — one run.
claudeReadiness.get(
  "/projects/:projectId/claude-readiness-runs/:runId",
  async (c) => {
    const projectId = c.req.param("projectId");
    const runId = c.req.param("runId");
    const client = createConvexClient(await getConvexBearerForRequest(c));

    let run: Record<string, unknown> | null;
    try {
      run = (await client.query(
        "claudeReadinessRuns:getReadinessRun" as never,
        { runId } as never,
      )) as Record<string, unknown> | null;
    } catch (error) {
      throw translateConvexReadError(error, { scope: "v1.claudeReadiness" });
    }
    if (!run) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Readiness run not found");
    }
    // The Convex query authorizes against the run's OWN project, which need
    // not be the one in the path. Without this a caller could read a run from
    // any project they belong to under a URL naming a different one, and a
    // client that trusts its own URL would file it in the wrong place.
    //
    // ABSENT means an older backend that does not return `projectId` yet, and
    // this deliberately allows it rather than 404ing every read during a
    // deploy. The caller is already authorized to read this run — Convex said
    // so — and the residual harm is a client filing it under the wrong
    // project, which is smaller than the surface being unusable until both
    // sides ship.
    if (run.projectId !== undefined && String(run.projectId) !== projectId) {
      throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Readiness run not found");
    }
    return v1Resource(c, run);
  },
);

// POST /v1/projects/:projectId/claude-readiness-runs/:runId/cancel
//
// POST rather than DELETE: the run is not removed, it reaches a terminal
// `cancelled` status that stays in the project's history.
claudeReadiness.post(
  "/projects/:projectId/claude-readiness-runs/:runId/cancel",
  async (c) => {
    const runId = c.req.param("runId");
    const client = createConvexClient(await getConvexBearerForRequest(c));
    try {
      const result = (await client.mutation(
        "claudeReadinessRuns:cancelReadinessRun" as never,
        { runId } as never,
      )) as { cancelled: boolean };
      return v1Resource(c, { id: runId, cancelled: result.cancelled === true });
    } catch (error) {
      throw translateConvexWriteError(error, {
        resource: "Readiness run",
        // "Not in progress" is a state conflict, not bad input: the caller
        // asked to stop something that had already stopped.
        conflictMessage: "This readiness run is not in progress.",
      });
    }
  },
);

export default claudeReadiness;
