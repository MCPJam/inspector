/**
 * Public `/api/v1` climbs. The backend owns the climb (its cases, limits,
 * rounds and the rule that settles them) and checks the tier and the
 * `climbs` flag on every call. These routes add what needs this process: the
 * real server's listing, the mock with no changes, the estimate, and the launch
 * of each unit's run groups, through the same grouped launch every run uses.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { PlatformClimb } from "@mcpjam/sdk/platform";
import { climbFns, translateClimbReadError, translateClimbWriteError } from "../../services/climbs/backend.js";
import type { ClimbDeps } from "../../services/climbs/deps.js";
import { hashRealServerListing } from "../../services/climbs/listing.js";
import { startClimb } from "../../services/climbs/start-climb.js";
import { submitRound } from "../../services/climbs/submit-round.js";
import { submittedViaOf } from "../../services/climbs/surface.js";
import { readRound } from "../../services/climbs/wait-round.js";
import { MAX_ROUND_WAIT_SECONDS } from "@mcpjam/sdk/platform";
import { readAnyIdempotencyKey } from "../../utils/idempotency.js";
import { randomUUID } from "node:crypto";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { readLaunchContext } from "../../utils/launch-context.js";
import { buildMcpjamPlatformClient } from "../web/mcpjam-platform-client.js";
import { ErrorCode, WebRouteError, parseWithSchema } from "../web/errors.js";
import { readJsonObjectBody } from "./adapter.js";
import { createConvexClient } from "./convex-client.js";
import { requireProjectIdArg } from "./convex-id-param.js";
import { v1PageJson, v1Resource } from "./envelope.js";

const climbs = new Hono();

const id = z.string().trim().min(1);
const groupSizes = z.strictObject({
  steering: z.number().int().min(0).optional(),
  validation: z.number().int().min(0).optional(),
  confirmation: z.number().int().min(0).optional(),
});
const groupLists = z.strictObject({
  steering: z.array(id).optional(),
  validation: z.array(id).optional(),
  confirmation: z.array(id).optional(),
});
const measure = z.enum(["pass_rate", "tokens", "cost", "tool_calls"]);

const startBody = z
  .strictObject({
    suiteId: id,
    serverId: id,
    roundLimit: z.number().int().min(1).max(100),
    creditLimit: z.number().positive(),
    environmentIds: z.array(id).min(1).max(10).optional(),
    picker: z.enum(["person", "agent"]).optional(),
    measure: measure.optional(),
    minImprovementBps: z.number().int().min(1).max(10_000).optional(),
    targetBps: z.number().int().min(1).max(9_999).optional(),
    groupSizes: groupSizes.optional(),
    groupLists: groupLists.optional(),
    seed: z.number().int().optional(),
  })
  .refine((body) => !(body.groupSizes && body.groupLists), { message: "Give groupSizes or groupLists, not both." });

const updateBody = z.strictObject({
  measure: measure.optional(),
  minImprovementBps: z.number().int().min(1).max(10_000).optional(),
  targetBps: z.number().int().min(1).max(9_999).nullable().optional(),
  moveToConfirmation: z.array(id).min(1).optional(),
});

const submitBody = z.strictObject({
  serverId: id,
  serverVersion: id.optional(),
  idempotencyKey: id.max(256).optional(),
});

const decisionBody = z.strictObject({
  decision: z.enum(["kept", "reverted"]),
  reason: z.string().trim().min(1).max(500),
});

const roundQuery = z.object({ wait: z.coerce.number().int().min(0).max(MAX_ROUND_WAIT_SECONDS).optional() });

const roundNumberOf = (c: Context): number => {
  const parsed = Number(c.req.param("roundNumber"));
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Round not found. Read the climb with get_climb to see its rounds.");
  }
  return parsed;
};

const listQuery = z.object({
  suiteId: id.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export function projectIdOf(c: Context): string {
  const projectId = c.req.param("projectId") ?? "";
  requireProjectIdArg(projectId, "v1.climbs");
  return projectId;
}

/** The backend, the grouped launch and the listing, each as this caller. */
export async function climbDepsFor(c: Context): Promise<ClimbDeps> {
  const launch = readLaunchContext(c);
  return {
    convex: createConvexClient(await getConvexBearerForRequest(c)),
    client: buildMcpjamPlatformClient(c, {
      ...(launch?.launcher ? { launcher: launch.launcher } : {}),
      ...(launch?.ciMetadata ? { ci: launch.ciMetadata } : {}),
    }),
    hashListing: (projectId, serverId) => hashRealServerListing(c, projectId, serverId),
  };
}

/** A climb the path's project holds; one in another project is not found here. */
export async function readClimb(deps: ClimbDeps, projectId: string, climbId: string): Promise<PlatformClimb> {
  let climb: PlatformClimb;
  try {
    climb = await deps.convex.query(climbFns.get, { climbId });
  } catch (error) {
    throw translateClimbReadError(error);
  }
  if (climb.projectId !== projectId) throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Climb not found");
  return climb;
}

// POST /v1/projects/:projectId/climbs: start a climb and launch its baseline.
climbs.post("/projects/:projectId/climbs", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(startBody, await readJsonObjectBody(c));
  const deps = await climbDepsFor(c);
  try {
    const started = await startClimb(deps, projectId, body);
    return v1Resource(c, started, 201);
  } catch (error) {
    throw error instanceof WebRouteError ? error : translateClimbWriteError(error);
  }
});

// GET /v1/projects/:projectId/climbs?suiteId=&limit=
climbs.get("/projects/:projectId/climbs", async (c) => {
  const projectId = projectIdOf(c);
  const query = parseWithSchema(listQuery, c.req.query());
  const convex = createConvexClient(await getConvexBearerForRequest(c));
  try {
    const items = await convex.query(climbFns.list, { projectId, ...query });
    return v1PageJson(c, items);
  } catch (error) {
    throw translateClimbReadError(error);
  }
});

// GET /v1/projects/:projectId/climbs/:climbId
climbs.get("/projects/:projectId/climbs/:climbId", async (c) => {
  const deps = await climbDepsFor(c);
  return v1Resource(c, await readClimb(deps, projectIdOf(c), c.req.param("climbId") ?? ""));
});

// PATCH /v1/projects/:projectId/climbs/:climbId
climbs.patch("/projects/:projectId/climbs/:climbId", async (c) => {
  const projectId = projectIdOf(c);
  const climbId = c.req.param("climbId") ?? "";
  const body = parseWithSchema(updateBody, await readJsonObjectBody(c));
  const deps = await climbDepsFor(c);
  await readClimb(deps, projectId, climbId);
  try {
    return v1Resource(c, await deps.convex.mutation(climbFns.update, { climbId, ...body }));
  } catch (error) {
    throw translateClimbWriteError(error);
  }
});

// POST /v1/projects/:projectId/climbs/:climbId/rounds: register a round and launch it.
climbs.post("/projects/:projectId/climbs/:climbId/rounds", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(submitBody, await readJsonObjectBody(c));
  const deps = await climbDepsFor(c);
  const climb = await readClimb(deps, projectId, c.req.param("climbId") ?? "");
  try {
    const submitted = await submitRound(deps, projectId, climb, {
      serverId: body.serverId,
      serverVersion: body.serverVersion,
      // The header wins, like every launch route; a call with neither gets a key of its own.
      idempotencyKey: readAnyIdempotencyKey(c) ?? body.idempotencyKey ?? randomUUID(),
      submittedVia: submittedViaOf(readLaunchContext(c)),
    });
    return v1Resource(c, submitted, 202);
  } catch (error) {
    throw error instanceof WebRouteError ? error : translateClimbWriteError(error);
  }
});

// GET /v1/projects/:projectId/climbs/:climbId/rounds/:roundNumber?wait=
climbs.get("/projects/:projectId/climbs/:climbId/rounds/:roundNumber", async (c) => {
  const projectId = projectIdOf(c);
  const { wait } = parseWithSchema(roundQuery, c.req.query());
  const deps = await climbDepsFor(c);
  const climb = await readClimb(deps, projectId, c.req.param("climbId") ?? "");
  try {
    return v1Resource(c, await readRound(deps.convex, climb, roundNumberOf(c), wait ?? 0));
  } catch (error) {
    throw translateClimbReadError(error);
  }
});

// POST /v1/projects/:projectId/climbs/:climbId/rounds/:roundNumber/decision: overrule a settled round.
climbs.post("/projects/:projectId/climbs/:climbId/rounds/:roundNumber/decision", async (c) => {
  const projectId = projectIdOf(c);
  const body = parseWithSchema(decisionBody, await readJsonObjectBody(c));
  const deps = await climbDepsFor(c);
  const climb = await readClimb(deps, projectId, c.req.param("climbId") ?? "");
  const roundNumber = roundNumberOf(c);
  try {
    const result: { round: Record<string, unknown>; best: unknown } = await deps.convex.mutation(climbFns.setDecision, {
      climbId: climb.climbId,
      roundNumber,
      ...body,
    });
    return v1Resource(c, { climbId: climb.climbId, suiteId: climb.suiteId, ...result });
  } catch (error) {
    throw translateClimbWriteError(error);
  }
});

// POST /v1/projects/:projectId/climbs/:climbId/stop
climbs.post("/projects/:projectId/climbs/:climbId/stop", async (c) => {
  const deps = await climbDepsFor(c);
  const climb = await readClimb(deps, projectIdOf(c), c.req.param("climbId") ?? "");
  try {
    const stopped: Record<string, unknown> = await deps.convex.mutation(climbFns.stop, { climbId: climb.climbId });
    return v1Resource(c, { climbId: climb.climbId, suiteId: climb.suiteId, ...stopped });
  } catch (error) {
    throw translateClimbWriteError(error);
  }
});

export default climbs;
