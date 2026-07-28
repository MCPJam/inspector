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
import { Hono } from "hono";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  handleRoute,
  parseWithSchema,
  readJsonBody,
} from "./auth.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
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

const generatePersonaSchema = z.object({
  projectId: z.string().min(1),
  serverAttachmentId: z.string().min(1),
  journeyCount: z.number().int().min(1).max(5).default(3),
});

const generateJourneysSchema = generatePersonaSchema.extend({
  persona: z.object({
    name: z.string().min(1),
    role: z.string().min(1),
    notes: z.string().optional(),
  }),
});

/** Backend 4xx → WebRouteError preserving the status (429 quota included) so
 * the backend's user-facing `error` copy reaches the dialog verbatim. */
function rethrowAsRouteError(err: unknown): never {
  if (err instanceof SwarmAgentError && err.status >= 400 && err.status < 500) {
    throw new WebRouteError(
      err.status,
      ErrorCode.VALIDATION_ERROR,
      err.message || "Generation request was rejected."
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
        serverAttachmentId: body.serverAttachmentId,
        journeyCount: body.journeyCount,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      rethrowAsRouteError(err);
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
        serverAttachmentId: body.serverAttachmentId,
        journeyCount: body.journeyCount,
        persona: body.persona,
        signal: c.req.raw.signal,
      });
    } catch (err) {
      rethrowAsRouteError(err);
    }
  })
);

export default swarmGenerate;
