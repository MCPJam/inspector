/**
 * Web proxy for the backend Swarm generation endpoints.
 *
 * Mounted under `/api/web/swarm` next to swarm-runs (same bearer +
 * guest-rate-limit middleware). Pure pass-through: validates the body, mints
 * the Convex bearer, forwards to `/swarms/*`, and maps backend 4xx (including
 * the 429 quota copy) onto WebRouteError so the client sees the backend's
 * user-facing message with the original status. No MCPClientManager — the
 * backend grounds generation in stored server inspections, not live connects.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  handleRoute,
  parseWithSchema,
  readJsonBody,
} from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { getRequestLogger } from "../../utils/request-logger.js";
import { SwarmAgentError } from "../../services/swarm-agent.js";
import {
  generateSwarmJourneys,
  generateSwarmPersona,
} from "../../services/swarm-generate.js";

const swarmGenerate = new Hono();

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

/**
 * Grounding source: exactly one of `serverAttachmentId` (legacy clients mode)
 * / `environmentId` (Project Environments). The XOR is enforced HERE, not
 * just backend-side: `z.object` strips unknown keys silently, so without the
 * refine a both-or-neither body would sail through to the backend and come
 * back with its (correct but less local) 400 copy.
 */
const generateBaseSchema = z.object({
  projectId: z.string().min(1),
  // `.trim()` so a whitespace-only "id" fails HERE (the point of validating
  // grounding locally) instead of reaching the backend as a non-empty string.
  serverAttachmentId: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
  journeyCount: z.number().int().min(1).max(5).default(3),
});

const exactlyOneGroundingSource = {
  check: (body: { serverAttachmentId?: string; environmentId?: string }) =>
    (body.serverAttachmentId === undefined) !==
    (body.environmentId === undefined),
  params: {
    message: "Exactly one of serverAttachmentId or environmentId is required",
  },
};

const generatePersonaSchema = generateBaseSchema.refine(
  exactlyOneGroundingSource.check,
  exactlyOneGroundingSource.params
);

const generateJourneysSchema = generateBaseSchema
  .extend({
    persona: z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      notes: z.string().optional(),
    }),
  })
  .refine(exactlyOneGroundingSource.check, exactlyOneGroundingSource.params);

/** Error codes for the 4xx statuses the backend generation routes return, so
 * code-based clients get the standard handling for each (a 429 quota rejection
 * must read as RATE_LIMITED, not a malformed request). Anything else keeps
 * VALIDATION_ERROR. */
const FORWARDED_ERROR_CODES: Record<
  number,
  (typeof ErrorCode)[keyof typeof ErrorCode]
> = {
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
};

/**
 * Backend 4xx → WebRouteError preserving the status (429 quota included) so
 * the backend's user-facing `error` copy reaches the dialog verbatim.
 *
 * A backend 5xx is NOT user-facing: its message carries the Convex deployment
 * URL and upstream status, which the default error mapper would echo into the
 * response body. Log it and return a generic 500 instead.
 */
function rethrowAsRouteError(c: Context, err: unknown): never {
  if (err instanceof SwarmAgentError && err.status >= 400 && err.status < 500) {
    throw new WebRouteError(
      err.status,
      FORWARDED_ERROR_CODES[err.status] ?? ErrorCode.VALIDATION_ERROR,
      err.message || "Generation request was rejected."
    );
  }
  if (err instanceof SwarmAgentError) {
    getRequestLogger(c, "routes.web.swarm-generate").event(
      "swarm.generation.upstream_failed",
      { statusCode: err.status, errorCode: "upstream_server_error" }
    );
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Generation is temporarily unavailable. Please try again."
    );
  }
  throw err;
}

swarmGenerate.post("/generate/persona", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = await getConvexBearerForRequest(c);
    const body = parseWithSchema(
      generatePersonaSchema,
      await readJsonBody<unknown>(c)
    );
    const convexHttpUrl = requireConvexHttpUrl();
    try {
      return await generateSwarmPersona(convexHttpUrl, bearerToken, {
        projectId: body.projectId,
        ...(body.serverAttachmentId
          ? { serverAttachmentId: body.serverAttachmentId }
          : {}),
        ...(body.environmentId ? { environmentId: body.environmentId } : {}),
        journeyCount: body.journeyCount,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      rethrowAsRouteError(c, err);
    }
  })
);

swarmGenerate.post("/generate/journeys", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = await getConvexBearerForRequest(c);
    const body = parseWithSchema(
      generateJourneysSchema,
      await readJsonBody<unknown>(c)
    );
    const convexHttpUrl = requireConvexHttpUrl();
    try {
      return await generateSwarmJourneys(convexHttpUrl, bearerToken, {
        projectId: body.projectId,
        ...(body.serverAttachmentId
          ? { serverAttachmentId: body.serverAttachmentId }
          : {}),
        ...(body.environmentId ? { environmentId: body.environmentId } : {}),
        journeyCount: body.journeyCount,
        persona: body.persona,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      rethrowAsRouteError(c, err);
    }
  })
);

export default swarmGenerate;
