/**
 * Public v1 SWARM CONTAINER surface.
 *
 * ⚠️ THIS FILE REVERSES A DOCUMENTED DECISION, deliberately and in isolation.
 *
 * `./journeys.ts` argues at length that "swarm" is not a resource noun in this
 * API: a swarm is a container users author in the UI, what executes is a
 * JOURNEY, and a public `/swarms` route would inherit the backend's genuinely
 * confusing overload — `kind:"swarm"`, `swarm_grant` and
 * `swarmId: v.id('chatboxes')` all mean chatbox GUEST EXECUTION, a different
 * product entirely. That argument is still correct about the DANGER and this
 * file does not dispute it.
 *
 * What changed is the requirement. An agent authoring from scratch has to
 * reproduce what the UI produces, and the UI produces journeys grouped under a
 * container that owns the shared execution config and the shared rubric. Without
 * this route an agent can only make orphan journeys — legal, but a shape no
 * human user ever creates, and one the UI's own list views render oddly.
 *
 * Which is why it is a SEPARATE FILE rather than four more routes in
 * `journeys.ts`: journeys stand alone without it, `waveId` already groups runs
 * of a batch, and reviewers who think the original decision should hold can
 * reject this module without touching the rest of the surface.
 *
 * NAMING GUARD. Nothing here ever exposes an id from the guest-execution sense
 * of "swarm". The only ids that cross this boundary are `swarms` row ids and
 * `projectEnvironments` ids.
 *
 * CROSS-PROJECT SCOPING is enforced here: `swarms:getSwarm`, `updateSwarm` and
 * `archiveSwarm` take a `swarmRefId` alone and check membership of whatever
 * project the row turns out to be in. `getSwarm` returns the row's projectId,
 * so the preflight is a real read plus a comparison — not the list-and-scan
 * `./personas.ts` is stuck with.
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

const swarms = new Hono();

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.swarms" });
}

type SwarmRow = {
  _id: string;
  projectId: string;
  name: string;
  description: string | null;
  environmentIds: string[] | null;
  config: { sessionsPerTarget?: number; maxTurns?: number } | undefined;
  createdAt: number;
  updatedAt: number;
};

function toSwarmDto(row: SwarmRow) {
  return {
    id: row._id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    /** Default fan-out for journeys authored under this container. */
    environmentIds: row.environmentIds ?? [],
    sessionsPerTarget: row.config?.sessionsPerTarget ?? null,
    maxTurns: row.config?.maxTurns ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const swarmConfigFields = {
  sessionsPerTarget: z.number().int().min(1).max(100),
  maxTurns: z.number().int().min(1).max(200),
};

const createSwarmSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  environmentIds: z.array(z.string().min(1)).min(1).optional(),
  ...swarmConfigFields,
});

const updateSwarmSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional(),
    /** `null` clears; absent leaves alone. Same tri-state as journeys. */
    description: z.union([z.string().max(2000), z.null()]).optional(),
    environmentIds: z
      .union([z.array(z.string().min(1)).min(1), z.null()])
      .optional(),
    sessionsPerTarget: swarmConfigFields.sessionsPerTarget.optional(),
    maxTurns: swarmConfigFields.maxTurns.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one swarm field to update.",
  })
  .refine(
    (value) =>
      (value.sessionsPerTarget === undefined) ===
      (value.maxTurns === undefined),
    {
      // One `config` object upstream; a partial update would need a
      // read-modify-write and could silently clobber a concurrent edit.
      message:
        "sessionsPerTarget and maxTurns must be updated together — they are one execution config upstream.",
    }
  );

async function parseBody<T>(
  c: { req: { json: () => Promise<unknown> } },
  schema: z.ZodType<T>
): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be JSON"
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      parsed.error.issues[0]?.message ?? "Invalid request body"
    );
  }
  return parsed.data;
}

/**
 * Assert `swarmId` belongs to `projectId`, and return it.
 *
 * Convex answers `null` for an archived swarm and for one in another project
 * alike, and this 404s on a project mismatch too — so the route is never an
 * existence oracle for a project the caller cannot see.
 */
export async function requireSwarmInProject(
  client: ConvexHttpClient,
  projectId: string,
  swarmId: string
): Promise<SwarmRow> {
  let row: SwarmRow | null;
  try {
    row = (await client.query(
      "swarms:getSwarm" as never,
      { swarmRefId: swarmId } as never
    )) as SwarmRow | null;
  } catch (error) {
    throw translateReadError(error);
  }
  if (!row || String(row.projectId) !== projectId) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Swarm not found");
  }
  return row;
}

// GET /v1/projects/:projectId/swarms
swarms.get("/projects/:projectId/swarms", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  let rows: SwarmRow[] | null;
  try {
    rows = (await client.query(
      "swarms:listSwarms" as never,
      { projectId } as never
    )) as SwarmRow[] | null;
  } catch (error) {
    throw translateReadError(error);
  }
  return v1PageJson(c, (rows ?? []).map(toSwarmDto));
});

// GET /v1/projects/:projectId/swarms/:swarmId
swarms.get("/projects/:projectId/swarms/:swarmId", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  return v1Resource(
    c,
    toSwarmDto(
      await requireSwarmInProject(client, projectId, c.req.param("swarmId"))
    )
  );
});

// POST /v1/projects/:projectId/swarms
//
// IDEMPOTENT on the `idempotency-key` header, forwarded untransformed (the
// backend fingerprints a replay as sha256 of the args minus the key, so a
// field this layer injected would make a retry look like key reuse).
//
// Behind the beta gate.
swarms.post("/projects/:projectId/swarms", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await parseBody(c, createSwarmSchema);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const idempotencyKey = c.req.header("idempotency-key")?.trim();

  let row: SwarmRow;
  try {
    row = (await client.mutation(
      "swarms:createSwarm" as never,
      {
        projectId,
        name: body.name,
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.environmentIds !== undefined
          ? { environmentIds: body.environmentIds }
          : {}),
        config: {
          sessionsPerTarget: body.sessionsPerTarget,
          maxTurns: body.maxTurns,
        },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as never
    )) as SwarmRow;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Swarm" });
  }

  return v1Resource(c, toSwarmDto(row), 201);
});

// PATCH /v1/projects/:projectId/swarms/:swarmId
swarms.patch("/projects/:projectId/swarms/:swarmId", async (c) => {
  const projectId = c.req.param("projectId");
  const swarmId = c.req.param("swarmId");
  const body = await parseBody(c, updateSwarmSchema);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  await requireSwarmInProject(client, projectId, swarmId);

  let row: SwarmRow;
  try {
    row = (await client.mutation(
      "swarms:updateSwarm" as never,
      {
        swarmRefId: swarmId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        // `null` forwarded verbatim — it is the clear signal upstream too.
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.environmentIds !== undefined
          ? { environmentIds: body.environmentIds }
          : {}),
        ...(body.sessionsPerTarget !== undefined && body.maxTurns !== undefined
          ? {
              config: {
                sessionsPerTarget: body.sessionsPerTarget,
                maxTurns: body.maxTurns,
              },
            }
          : {}),
      } as never
    )) as SwarmRow;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Swarm" });
  }

  return v1Resource(c, toSwarmDto(row));
});

// DELETE /v1/projects/:projectId/swarms/:swarmId
//
// ARCHIVES the container. Journeys authored under it keep working and keep
// their `swarmId` — the reference is authoring provenance, not ownership, so
// removing the container does not remove what was made in it. Second call
// answers 404 (an archived swarm reads as absent), which cleanup scripts
// should treat as success.
//
// NOT flag-gated.
swarms.delete("/projects/:projectId/swarms/:swarmId", async (c) => {
  const projectId = c.req.param("projectId");
  const swarmId = c.req.param("swarmId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  await requireSwarmInProject(client, projectId, swarmId);

  try {
    await client.mutation(
      "swarms:archiveSwarm" as never,
      { swarmRefId: swarmId } as never
    );
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Swarm" });
  }

  return v1Resource(c, { id: swarmId, projectId, archived: true });
});

export default swarms;
