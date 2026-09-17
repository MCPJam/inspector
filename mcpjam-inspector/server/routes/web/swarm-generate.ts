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
import { upstreamRefusalRouteError } from "../../services/upstream-refusal.js";
import {
  generateSwarmJourneys,
  generateSwarmPersona,
  generateSwarmPersonaBatch,
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
export const generateBaseSchema = z.object({
  projectId: z.string().min(1),
  // `.trim()` so a whitespace-only "id" fails HERE (the point of validating
  // grounding locally) instead of reaching the backend as a non-empty string.
  serverAttachmentId: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
  journeyCount: z.number().int().min(1).max(5).default(3),
  // Free-text audience description from the create flow. Capped to match the
  // backend's own slice so an over-long body fails here with a local 400
  // instead of being silently truncated upstream.
  description: z.string().trim().min(1).max(2000).optional(),
  existingPersonas: z
    .array(
      z.object({
        name: z.string().trim().min(1),
        role: z.string().trim().min(1),
      })
    )
    .max(30)
    .optional(),
});

export const exactlyOneGroundingSource = {
  check: (body: { serverAttachmentId?: string; environmentId?: string }) =>
    (body.serverAttachmentId === undefined) !==
    (body.environmentId === undefined),
  params: {
    message: "Exactly one of serverAttachmentId or environmentId is required",
  },
};

/**
 * Exported for the `/api/v1` generation routes, which forward to the same
 * backend endpoints under project-scoped paths (`./v1/swarm-generate.ts`).
 * Shared rather than re-declared so the two surfaces cannot drift on what a
 * valid grounding source is — the XOR below is the rule most likely to be
 * copied wrong.
 */

/**
 * `personaCount` selects the batch response shape (a slate of N personas, each
 * with journeys) over the legacy single-persona one. Optional with NO default:
 * a default here would switch every legacy caller onto a response shape it
 * can't read.
 */
const generatePersonaSchema = generateBaseSchema
  .extend({
    personaCount: z.number().int().min(1).max(12).optional(),
  })
  .refine(exactlyOneGroundingSource.check, exactlyOneGroundingSource.params);

const generateJourneysSchema = generateBaseSchema
  .extend({
    swarmRefId: z.string().trim().min(1).optional(),
    persona: z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      notes: z.string().optional(),
    }),
  })
  .refine(exactlyOneGroundingSource.check, exactlyOneGroundingSource.params);

/** Redacted copy for a masked 5xx. Carries no transport detail; the
 * correlation id appended below is what makes it actionable. */
const MASKED_UPSTREAM_MESSAGE =
  "Generation is temporarily unavailable. Please try again.";

/**
 * The backend's own error `code` off its JSON envelope
 * (`mcpjam_config_error`, `provider_error`, …), which says WHICH 5xx happened
 * without carrying any of the detail the mask exists to withhold. Shape-gated:
 * a body that is not that envelope (WAF interstitial, proxy error page) yields
 * nothing rather than putting an arbitrary upstream string into a log
 * dimension.
 */
const UPSTREAM_ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

function upstreamErrorCode(bodyText: string): string | undefined {
  try {
    const parsed = JSON.parse(bodyText) as { code?: unknown };
    return typeof parsed.code === "string" &&
      UPSTREAM_ERROR_CODE_PATTERN.test(parsed.code)
      ? parsed.code
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Backend 4xx → WebRouteError preserving the status (429 quota included) so
 * the backend's user-facing `error` copy reaches the dialog verbatim.
 *
 * A backend 5xx is NOT user-facing: its message carries the Convex deployment
 * URL and upstream status, which the default error mapper would echo into the
 * response body. Log it and return a generic 500 instead.
 *
 * The redaction stays, but it no longer discards diagnosability: the request
 * id `requestLogContextMiddleware` already minted (and reflects as
 * `x-request-id`) is appended to the user-facing copy and repeated in
 * `details.requestId`, so a SCREENSHOT of the error is enough to find the
 * `swarm.generation.upstream_failed` row for it — that event's envelope
 * carries the same `requestId`. Absent only when the middleware did not run,
 * in which case there is nothing to correlate and the copy stays bare.
 */
export function rethrowAsRouteError(c: Context, err: unknown): never {
  if (err instanceof SwarmAgentError && err.status >= 400 && err.status < 500) {
    // Shared with the eval generation adapters, which had the same bug in a
    // worse form (no forwarding at all). It owns the status -> code table, the
    // `Retry-After` the 429 arrived with — the backend's burst brake and its
    // daily cap both tell us when they lift, and a code that means "retry"
    // with nothing to say when leaves every client to hammer or give up — and
    // the refusal `code` in `details`, which a caller needs to tell MCPJam's
    // own exhausted budget (`platform_capacity`, nothing to buy) from the
    // caller's allowance (`user_rate_limit`, top-up offered).
    //
    // `err.message` is passed rather than re-derived: `services/swarm-generate.ts`
    // already chose between the backend's copy and a generic sentence, and
    // that choice is its redaction policy, not a default.
    const routeError = upstreamRefusalRouteError({
      status: err.status,
      bodyText: err.bodyText,
      message: err.message || undefined,
      fallbackMessage: "Generation request was rejected.",
      retryAfter: err.retryAfter,
    });
    // Only `undefined` outside 4xx, which the guard above already excluded.
    if (routeError) throw routeError;
  }
  if (err instanceof SwarmAgentError) {
    const requestId = c.var.requestLogContext?.requestId;
    getRequestLogger(c, "routes.web.swarm-generate").event(
      "swarm.generation.upstream_failed",
      {
        statusCode: err.status,
        // The upstream code when the backend sent one: a masked failure whose
        // log row only ever said "upstream_server_error" still needed the
        // deployment's own logs to tell a provider outage from a
        // misconfigured deployment.
        errorCode: upstreamErrorCode(err.bodyText) ?? "upstream_server_error",
      }
    );
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      requestId
        ? `${MASKED_UPSTREAM_MESSAGE} (reference: ${requestId})`
        : MASKED_UPSTREAM_MESSAGE,
      requestId ? { requestId } : undefined
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
    const grounding = {
      projectId: body.projectId,
      ...(body.serverAttachmentId
        ? { serverAttachmentId: body.serverAttachmentId }
        : {}),
      ...(body.environmentId ? { environmentId: body.environmentId } : {}),
      journeyCount: body.journeyCount,
      ...(body.description ? { description: body.description } : {}),
      ...(body.existingPersonas?.length
        ? { existingPersonas: body.existingPersonas }
        : {}),
      signal: c.req.raw.signal,
    };
    try {
      return body.personaCount === undefined
        ? await generateSwarmPersona(convexHttpUrl, bearerToken, grounding)
        : await generateSwarmPersonaBatch(convexHttpUrl, bearerToken, {
            ...grounding,
            personaCount: body.personaCount,
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
        ...(body.swarmRefId ? { swarmRefId: body.swarmRefId } : {}),
        ...(body.serverAttachmentId
          ? { serverAttachmentId: body.serverAttachmentId }
          : {}),
        ...(body.environmentId ? { environmentId: body.environmentId } : {}),
        journeyCount: body.journeyCount,
        persona: body.persona,
        ...(body.description ? { description: body.description } : {}),
        signal: c.req.raw.signal,
      });
    } catch (err) {
      rethrowAsRouteError(c, err);
    }
  })
);

export default swarmGenerate;
