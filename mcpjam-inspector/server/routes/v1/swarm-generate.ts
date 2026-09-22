/**
 * Public v1 GENERATION surface — drafting personas and journeys with an LLM.
 *
 * DRAFT-ONLY. Nothing here persists anything. The backend grounds a model in
 * the project's stored server inspections and returns candidate personas and
 * journeys; the caller decides what to keep and creates it through
 * `./personas.ts` / `./journeys.ts`. That separation is deliberate and worth
 * keeping: generation is the step most likely to produce something nobody
 * wanted, and a route that both invented and saved would make "let me see what
 * you'd suggest" indistinguishable from "fill my project with these".
 *
 * It is also why there is NO idempotency key here. An idempotency key promises
 * that a retry does not duplicate an effect; a call with no effect has nothing
 * to duplicate, and offering one would imply the drafts are stable across
 * retries when they are not — the same request twice returns different
 * personas, which is the nature of the thing.
 *
 * These forward to the same backend endpoints and reuse the same service
 * functions as `../web/swarm-generate.ts`, sharing that module's grounding
 * schema so the two surfaces cannot drift on what a valid grounding source is.
 * The difference is shape: the project is in the PATH here, as it is
 * everywhere in `/v1`, rather than in the body.
 *
 * ROUTE ORDER MATTERS. `/personas/generate` must be registered before
 * `/personas/:personaId` or Hono matches "generate" as a persona id and the
 * request 404s. Mount order in `./index.ts` handles it; this file existing
 * separately from `./personas.ts` is what makes that ordering visible rather
 * than an accident of where someone pasted a route.
 *
 * SPENDS. Generation runs a model on the org's account and the backend
 * enforces its own quota, arriving here as a 429 with the backend's own copy.
 * A 5xx is masked with a correlation id — the upstream message carries the
 * Convex deployment URL.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { v1Resource } from "./envelope.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import {
  exactlyOneGroundingSource,
  generateBaseSchema,
  rethrowAsRouteError,
} from "../web/swarm-generate.js";
import {
  generateSwarmJourneys,
  generateSwarmPersona,
  generateSwarmPersonaBatch,
} from "../../services/swarm-generate.js";

const swarmGenerateV1 = new Hono();

/**
 * The web body minus `projectId`, which is in the path on this surface.
 *
 * `.omit` rather than a fresh declaration: the grounding fields, their caps
 * and their trimming are the shared rule, and re-typing them here is how the
 * two surfaces would end up disagreeing about (say) the description cap.
 */
const v1GenerateBase = generateBaseSchema.omit({ projectId: true });

const generatePersonasSchema = v1GenerateBase
  .extend({
    /**
     * Ask for a SLATE of N personas rather than one. Optional with no default,
     * matching the web surface: defaulting would switch the response shape
     * under a caller that only knows the single-persona one.
     */
    personaCount: z.number().int().min(1).max(12).optional(),
  })
  .refine(exactlyOneGroundingSource.check, exactlyOneGroundingSource.params);

const generateJourneysSchema = v1GenerateBase
  .extend({
    /**
     * The persona to draft journeys FOR, passed by value rather than by id.
     * That is not an oversight: the create flow drafts a persona and its
     * journeys before either exists, so requiring a persisted persona here
     * would force a caller to save a draft it may discard.
     */
    persona: z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      notes: z.string().optional(),
    }),
  })
  .refine(exactlyOneGroundingSource.check, exactlyOneGroundingSource.params);

function requireConvexHttpUrl(): string {
  const url = process.env.CONVEX_HTTP_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_HTTP_URL configuration"
    );
  }
  return url;
}

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

// POST /v1/projects/:projectId/personas/generate
//
// Returns DRAFTS. Nothing is created; feed what you want to keep to
// `POST /projects/:projectId/personas`.
swarmGenerateV1.post("/projects/:projectId/personas/generate", async (c) => {
  const projectId = c.req.param("projectId");
  const bearerToken = await getConvexBearerForRequest(c);
  const body = await parseBody(c, generatePersonasSchema);
  const convexHttpUrl = requireConvexHttpUrl();

  const grounding = {
    projectId,
    ...(body.serverAttachmentId
      ? { serverAttachmentId: body.serverAttachmentId }
      : {}),
    ...(body.environmentId ? { environmentId: body.environmentId } : {}),
    journeyCount: body.journeyCount,
    ...(body.description ? { description: body.description } : {}),
    ...(body.existingPersonas?.length
      ? { existingPersonas: body.existingPersonas }
      : {}),
    // The CALLER's abort reaches the model call. A generation that outlives
    // the request it was asked for is spend nobody is waiting for.
    signal: c.req.raw.signal,
  };

  try {
    const result =
      body.personaCount === undefined
        ? await generateSwarmPersona(convexHttpUrl, bearerToken, grounding)
        : await generateSwarmPersonaBatch(convexHttpUrl, bearerToken, {
            ...grounding,
            personaCount: body.personaCount,
          });
    return v1Resource(c, result);
  } catch (err) {
    rethrowAsRouteError(c, err);
  }
});

// POST /v1/projects/:projectId/journeys/generate
//
// Registered before `/journeys/:journeyId` — see the header.
swarmGenerateV1.post("/projects/:projectId/journeys/generate", async (c) => {
  const projectId = c.req.param("projectId");
  const bearerToken = await getConvexBearerForRequest(c);
  const body = await parseBody(c, generateJourneysSchema);
  const convexHttpUrl = requireConvexHttpUrl();

  try {
    const result = await generateSwarmJourneys(convexHttpUrl, bearerToken, {
      projectId,
      ...(body.serverAttachmentId
        ? { serverAttachmentId: body.serverAttachmentId }
        : {}),
      ...(body.environmentId ? { environmentId: body.environmentId } : {}),
      journeyCount: body.journeyCount,
      persona: body.persona,
      ...(body.description ? { description: body.description } : {}),
      signal: c.req.raw.signal,
    });
    return v1Resource(c, result);
  } catch (err) {
    rethrowAsRouteError(c, err);
  }
});

export default swarmGenerateV1;
