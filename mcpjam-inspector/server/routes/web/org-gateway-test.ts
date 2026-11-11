/**
 * POST /api/web/org-gateway-test: the connection Test for a gateway whose
 * calls come from each user's Inspector, run by this process because
 * MCPJam's servers never call such a gateway. The editor labels the result
 * "Tested from your Inspector".
 *
 * Testing takes the same role as saving: an organization admin or owner.
 * Before dialing anything the route asks the backend, as the caller and with
 * the caller's bearer, whether they may manage the named organization's
 * providers. A "no" is a 403, and a question the backend could not answer is
 * an error, so the gateway is only dialed after a "yes". Beyond that, what
 * bounds it is the same as for every route here that dials a caller-named
 * address: a signed-in, verified caller (mounted in `index.ts`), the hosted
 * egress guard on every request, no redirects, and short, truncated answers.
 * Hosted, each probe dials only the address the guard checked, so a name that
 * answers public for the check and private for the connection cannot reach a
 * private service. Nothing is read from the organization beyond that
 * question, and nothing is written to it.
 */
import { Hono, type Context } from "hono";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";
import {
  ErrorCode,
  WebRouteError,
  parseWithSchema,
  readJsonBody,
} from "./errors.js";
import { handleRoute } from "./auth.js";
import { createConvexClient } from "../../services/evals/route-helpers.js";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";
import { createCheckedAddressFetch } from "../../utils/checked-address-fetch.js";
import { probeGatewayConnection } from "../../utils/gateway-connection-probe.js";
import { GATEWAY_APIS } from "@/shared/gateway-connection";
import { hostedModelDefinitionsFromSnapshot } from "@/shared/types";

const canTestProviderConnection = makeFunctionReference<
  "query",
  { organizationId: string },
  boolean
>("organizationModelProviderTest:canTestProviderConnection");

const GATEWAY_TEST_ADMINS_ONLY =
  "Only organization admins and owners can test a custom provider. Ask an admin to add it.";
const GATEWAY_TEST_ROLE_UNCHECKED =
  "Couldn't check your role in this organization. Try again.";

const testSchema = z.strictObject({
  organizationId: z.string().trim().min(1).max(64),
  baseUrl: z.string().trim().url().max(2048),
  secret: z.string().max(4096).optional(),
  apis: z.array(z.enum(GATEWAY_APIS)).max(GATEWAY_APIS.length).optional(),
});

/** Throws unless the backend says the caller manages the org's providers. */
async function assertMayTestGateway(
  c: Context,
  organizationId: string,
): Promise<void> {
  const bearer = await getConvexBearerForRequest(c);
  let allowed: boolean;
  try {
    allowed = await createConvexClient(bearer, c.req.raw.signal).query(
      canTestProviderConnection,
      { organizationId },
    );
  } catch (error) {
    reportRouteFailure("Gateway test role check failed", error, {
      source: "org-gateway-test.role-check",
      hop: "mcpjam_internal",
    });
    throw new WebRouteError(
      502,
      ErrorCode.SERVER_UNREACHABLE,
      GATEWAY_TEST_ROLE_UNCHECKED,
    );
  }
  if (allowed !== true) {
    throw new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      GATEWAY_TEST_ADMINS_ONLY,
    );
  }
}

const orgGatewayTest = new Hono();

orgGatewayTest.post("/", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(testSchema, await readJsonBody(c));
    await assertMayTestGateway(c, body.organizationId);
    return await probeGatewayConnection({
      baseUrl: body.baseUrl,
      ...(body.secret?.trim() ? { secret: body.secret.trim() } : {}),
      ...(body.apis ? { apis: body.apis } : {}),
      fetch: createCheckedAddressFetch(),
      catalogIds: hostedModelDefinitionsFromSnapshot().map((model) =>
        String(model.id),
      ),
    });
  }),
);

export default orgGatewayTest;
