/**
 * Public v1 PERSONA surface — the reusable synthetic characters Swarms run as.
 *
 * A persona is a name, a role and some notes, owned by a project. The GOAL is
 * not here: a persona has many journeys and each journey carries its own goal
 * (see `./journeys.ts`). That split is why authoring works — one "impatient
 * enterprise buyer" can be pointed at a dozen different things to try.
 *
 * WHY THIS FILE EXISTS. Until now `/api/v1` could launch and read journeys but
 * could not author one, because a journey needs a persona and there was no way
 * to make a persona outside the UI. The loop an agent needs is
 * create → run → read, and the create end simply was not there.
 *
 * CROSS-PROJECT SCOPING is enforced HERE, not by Convex —
 * `personas:updatePersona` and `deletePersona` take a `personaRefId` alone and
 * check membership of whatever project the persona turns out to be in, never
 * the project named in the path. Without the preflight below,
 * `PATCH /projects/A/personas/{a-persona-in-B}` would edit B's persona through
 * A's URL for anyone who is a member of both.
 *
 * The preflight is a LIST-AND-SCAN, which is not the pattern `journeys.ts`
 * uses and not the pattern anyone should copy. `journeys:getJourney` takes
 * `{projectId, journeyRefId}` and asserts the scope inside Convex, which is
 * where a scope rule belongs; personas have no equivalent scoped getter, so
 * the gateway pays a full project read per by-id request and holds a copy of
 * the rule. It is bounded (200 personas per project, enforced backend-side) so
 * this is a cost rather than a hazard. If exactly one backend addition is ever
 * on the table for this surface, `personas:getPersona {projectId, personaRefId}`
 * is the one to ask for.
 *
 * BETA. Creates and updates are behind the `sandboxes-enabled` flag, enforced
 * server-side; reads and DELETE are not — an org that has just lost the flag
 * must still be able to see and clean up what it authored.
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

const personas = new Hono();

function translateReadError(error: unknown): WebRouteError {
  return translateConvexReadError(error, { scope: "v1.personas" });
}

/** Convex `personas:serializePersona` output, hand-mirrored. */
type PersonaRow = {
  _id: string;
  personaId: string;
  name: string;
  role: string;
  notes?: string;
  avatarShape?: number;
  avatarPalette?: number;
  source?: "manual" | "generated" | "cluster";
  seedKeywords?: string[];
  createdAt: number;
  updatedAt: number;
};

function toPersonaDto(row: PersonaRow, projectId: string) {
  return {
    /**
     * The durable row id — what journeys join on, and what every other route
     * in this API means by "persona id". NOT `personaId`, which is the
     * slug-shaped external key below; returning that one here would mean a
     * caller who listed personas could not then create a journey against one.
     */
    id: row._id,
    projectId,
    /**
     * The stable slug key, kept across runs and shared with exported session
     * data. Useful for correlating with transcripts; not an address for this
     * API.
     */
    slug: row.personaId,
    name: row.name,
    role: row.role,
    notes: row.notes ?? null,
    /** How this persona came to exist: authored, LLM-generated, or clustered
     * from real user-testing sessions. */
    source: row.source ?? "manual",
    ...(row.seedKeywords ? { seedKeywords: row.seedKeywords } : {}),
    avatar: {
      shape: row.avatarShape ?? null,
      palette: row.avatarPalette ?? null,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const createPersonaSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1).max(120),
  notes: z.string().max(2000).optional(),
  /** Look, as indices into the app's fixed shape/palette sets. */
  avatarShape: z.number().int().min(0).optional(),
  avatarPalette: z.number().int().min(0).optional(),
});

const updatePersonaSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    role: z.string().trim().min(1).max(120).optional(),
    notes: z.string().max(2000).optional(),
    avatarShape: z.number().int().min(0).optional(),
    avatarPalette: z.number().int().min(0).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "Provide at least one persona field to update.",
  });

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

async function listPersonaRows(
  client: ConvexHttpClient,
  projectId: string
): Promise<PersonaRow[]> {
  try {
    return ((await client.query(
      "personas:listPersonas" as never,
      { projectId } as never
    )) ?? []) as PersonaRow[];
  } catch (error) {
    throw translateReadError(error);
  }
}

/**
 * Assert `personaId` belongs to `projectId`. See the header on why this scans
 * rather than asking Convex for a scoped row.
 *
 * A persona in another project is simply absent from this list, so the 404 is
 * indistinguishable from one that never existed — no existence oracle.
 */
async function requirePersonaInProject(
  client: ConvexHttpClient,
  projectId: string,
  personaId: string
): Promise<PersonaRow> {
  const row = (await listPersonaRows(client, projectId)).find(
    (candidate) => String(candidate._id) === personaId
  );
  if (!row) {
    throw new WebRouteError(404, ErrorCode.NOT_FOUND, "Persona not found");
  }
  return row;
}

/**
 * The write idempotency key for this request, or nothing.
 *
 * Straight from the `idempotency-key` header, with NO transformation. That is
 * load-bearing: Convex fingerprints a replay as sha256 of the mutation args
 * minus the key, so if this layer injected a timestamp, renamed a field, or
 * defaulted one differently between the original and the retry, the replay
 * arrives with a different fingerprint and is rejected as a key reuse rather
 * than honoured as a retry. Every optional field below is therefore forwarded
 * only when the caller sent it.
 */
function idempotencyKeyOf(c: {
  req: { header: (name: string) => string | undefined };
}): string | undefined {
  const key = c.req.header("idempotency-key")?.trim();
  return key && key.length > 0 ? key : undefined;
}

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /v1/projects/:projectId/personas
personas.get("/projects/:projectId/personas", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const rows = await listPersonaRows(client, projectId);
  // Archived personas are filtered backend-side.
  return v1PageJson(
    c,
    rows.map((row) => toPersonaDto(row, projectId))
  );
});

// GET /v1/projects/:projectId/personas/:personaId
personas.get("/projects/:projectId/personas/:personaId", async (c) => {
  const projectId = c.req.param("projectId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const row = await requirePersonaInProject(
    client,
    projectId,
    c.req.param("personaId")
  );
  return v1Resource(c, toPersonaDto(row, projectId));
});

// POST /v1/projects/:projectId/personas
//
// IDEMPOTENT on the `idempotency-key` header. Worth using even though creating
// a persona spends nothing: the backend replays the key BEFORE it uniquifies
// the slug, so a retry without one produces a second near-identical persona
// called `impatient-buyer-2` rather than the row you already made.
//
// Behind the beta gate: an unflagged org gets FEATURE_UNAVAILABLE as a 403
// with a real message, not a 404.
personas.post("/projects/:projectId/personas", async (c) => {
  const projectId = c.req.param("projectId");
  const body = await parseBody(c, createPersonaSchema);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  const idempotencyKey = idempotencyKeyOf(c);

  let row: PersonaRow;
  try {
    row = (await client.mutation(
      "personas:createPersona" as never,
      {
        projectId,
        name: body.name,
        role: body.role,
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.avatarShape !== undefined
          ? { avatarShape: body.avatarShape }
          : {}),
        ...(body.avatarPalette !== undefined
          ? { avatarPalette: body.avatarPalette }
          : {}),
        // Every persona made through the API is authored, not generated — the
        // generation endpoint returns DRAFTS and the caller creates from them,
        // so provenance is a property of the create call, not of the content.
        source: "manual",
        ...(idempotencyKey ? { idempotencyKey } : {}),
      } as never
    )) as PersonaRow;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Persona" });
  }

  return v1Resource(c, toPersonaDto(row, projectId), 201);
});

// PATCH /v1/projects/:projectId/personas/:personaId
personas.patch("/projects/:projectId/personas/:personaId", async (c) => {
  const projectId = c.req.param("projectId");
  const personaId = c.req.param("personaId");
  const body = await parseBody(c, updatePersonaSchema);
  const client = createConvexClient(await getConvexBearerForRequest(c));
  await requirePersonaInProject(client, projectId, personaId);

  let row: PersonaRow;
  try {
    row = (await client.mutation(
      "personas:updatePersona" as never,
      {
        personaRefId: personaId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.role !== undefined ? { role: body.role } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.avatarShape !== undefined
          ? { avatarShape: body.avatarShape }
          : {}),
        ...(body.avatarPalette !== undefined
          ? { avatarPalette: body.avatarPalette }
          : {}),
      } as never
    )) as PersonaRow;
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Persona" });
  }

  return v1Resource(c, toPersonaDto(row, projectId));
});

// DELETE /v1/projects/:projectId/personas/:personaId
//
// A SOFT delete: the persona stops appearing in listings and cannot be used
// for new journeys, but historical runs and sessions keep resolving it, so a
// completed run does not lose the character it ran as. Documented rather than
// hidden — "deleted" that leaves data behind is the kind of thing a caller
// should learn from the docs and not from a support thread.
//
// NOT idempotent, and the reason is the scoping preflight rather than a
// choice: an archived persona is filtered out of `listPersonas`, so the second
// DELETE cannot prove the id belongs to this project and answers 404. That is
// the honest response — from the project's point of view the persona is gone —
// but a cleanup script must treat 404 here as success, not as an error.
//
// NOT flag-gated: removing something reduces exposure, and an org that has just
// lost the beta must still be able to clean up what it authored.
personas.delete("/projects/:projectId/personas/:personaId", async (c) => {
  const projectId = c.req.param("projectId");
  const personaId = c.req.param("personaId");
  const client = createConvexClient(await getConvexBearerForRequest(c));
  await requirePersonaInProject(client, projectId, personaId);

  try {
    await client.mutation(
      "personas:deletePersona" as never,
      { personaRefId: personaId } as never
    );
  } catch (error) {
    throw translateConvexWriteError(error, { resource: "Persona" });
  }

  return v1Resource(c, { id: personaId, projectId, deleted: true });
});

export default personas;
