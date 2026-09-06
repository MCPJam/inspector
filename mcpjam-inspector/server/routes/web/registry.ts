/**
 * The org registry's server-side half: derive an entry from a pasted URL.
 *
 * One route, and the ORDER inside it is the whole design:
 *
 *   1. bearer → 2. authorize against the backend → 3. rate limit → 4. probe
 *
 * Step 2 is not a formality. `/api/web/*` bypasses `sessionAuthMiddleware`
 * (see `server/index.ts`), so a route in this family is only as authenticated
 * as it makes itself — and a derive endpoint that skipped it would be an SSRF
 * oracle with a nice JSON envelope, however well guarded the socket underneath
 * is. `bearerAuthMiddleware` proves there IS a session; the backend call
 * proves that session may add to THIS project's organization. Both, before
 * anything is dialed.
 *
 * Step 3 sits between them for the same reason it does on the handoff family:
 * membership entitles a person to add entries, not to spend our egress in a
 * loop.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import {
  assertBearerToken,
  ErrorCode,
  parseWithSchema,
  readJsonBody,
  WebRouteError,
} from "./errors.js";
import { handleRoute } from "./auth.js";
import { consumeRegistryDeriveRateLimit } from "../../middleware/registry-derive-rate-limit.js";
import { getInspectorClientRuntimeConfig } from "../../env.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import {
  deriveRegistryEntry,
  EGRESS_REFUSAL_MESSAGE,
} from "../../services/registry-derive.js";

const registry = new Hono();

const deriveSchema = z.strictObject({
  // Bounded before it reaches a URL parser or a socket. 2048 is the
  // conventional practical URL ceiling; a longer one is not a server address
  // anyone typed.
  url: z.string().trim().min(1).max(2048),
  projectId: z.string().trim().min(1),
});

/**
 * "May this caller add to this project's organization?" — asked of the
 * backend, with the caller's OWN bearer, so the answer is the backend's and
 * not this process's guess.
 */
async function assertCanAddToOrgRegistry(
  bearerToken: string,
  projectId: string
): Promise<void> {
  const { convexUrl } = getInspectorClientRuntimeConfig();
  if (!convexUrl) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing Convex configuration"
    );
  }

  const client = new ConvexHttpClient(convexUrl);
  client.setAuth(bearerToken);

  let context: { organizationId: string | null; canAdd: boolean };
  try {
    context = (await client.query(
      "registryServers:getOrgRegistryContext" as never,
      { projectId } as never
    )) as { organizationId: string | null; canAdd: boolean };
  } catch (error) {
    reportRouteFailure("Org registry authorization lookup failed", error, {
      source: "web.registry.authorization",
      hop: "mcpjam_internal",
    });
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      "Failed to reach the authorization service."
    );
  }

  if (!context?.canAdd) {
    // One answer for "not a member", "guest role" and "no such project". A
    // caller who cannot add has no business learning which of those it was.
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "You do not have permission to add servers to this organization's registry."
    );
  }
}

// POST /api/web/registry/derive
registry.post("/derive", async (c) =>
  handleRoute(c, async () => {
    const bearerToken = assertBearerToken(c);
    const body = parseWithSchema(deriveSchema, await readJsonBody(c));
    await assertCanAddToOrgRegistry(bearerToken, body.projectId);
    const rateLimitResponse = consumeRegistryDeriveRateLimit(c);
    if (rateLimitResponse) return rateLimitResponse;

    // Loopback is never allowed here, whatever the deployment is: an org entry
    // is shared with everyone in the org, and an address that only resolves on
    // one machine is not a thing to share. The backend refuses to store one
    // too — this just means the dialog says so before the probe rather than
    // after.
    const outcome = await deriveRegistryEntry({ url: body.url });

    switch (outcome.kind) {
      case "derived":
        return outcome.facts;
      case "refused":
        // 400, not 502: the URL is the problem and it will be the problem
        // next time. The client must not retry this.
        throw new WebRouteError(
          400,
          ErrorCode.VALIDATION_ERROR,
          EGRESS_REFUSAL_MESSAGE
        );
      case "not-mcp":
        throw new WebRouteError(
          422,
          ErrorCode.VALIDATION_ERROR,
          outcome.detail
        );
      case "unreachable":
        throw new WebRouteError(
          502,
          ErrorCode.SERVER_UNREACHABLE,
          outcome.detail
        );
    }
  })
);

export default registry;
