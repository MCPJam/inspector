/**
 * POST /api/web/org-gateway-test: the connection Test for a gateway whose
 * calls come from each user's Inspector, run by this process because
 * MCPJam's servers never call such a gateway. The editor labels the result
 * "Tested from your Inspector".
 *
 * The request carries only what the admin typed (base URL, optional key, the
 * APIs to try); nothing is read from or written to the organization, so no
 * org authorization is asked of the backend. What bounds it is the same as
 * for every route here that dials a caller-named address: a signed-in,
 * verified caller (mounted in `index.ts`), the hosted egress guard on every
 * request, no redirects, and short, truncated answers.
 */
import { Hono } from "hono";
import { z } from "zod";
import { parseWithSchema, readJsonBody } from "./errors.js";
import { handleRoute } from "./auth.js";
import { createGuardedFetch } from "../../utils/hosted-egress-guard.js";
import { probeGatewayConnection } from "../../utils/gateway-connection-probe.js";
import { GATEWAY_APIS } from "@/shared/gateway-connection";
import { hostedModelDefinitionsFromSnapshot } from "@/shared/types";

const testSchema = z.strictObject({
  baseUrl: z.string().trim().url().max(2048),
  secret: z.string().max(4096).optional(),
  apis: z.array(z.enum(GATEWAY_APIS)).max(GATEWAY_APIS.length).optional(),
});

const orgGatewayTest = new Hono();

orgGatewayTest.post("/", async (c) =>
  handleRoute(c, async () => {
    const body = parseWithSchema(testSchema, await readJsonBody(c));
    return await probeGatewayConnection({
      baseUrl: body.baseUrl,
      ...(body.secret?.trim() ? { secret: body.secret.trim() } : {}),
      ...(body.apis ? { apis: body.apis } : {}),
      fetch: createGuardedFetch(),
      catalogIds: hostedModelDefinitionsFromSnapshot().map((model) =>
        String(model.id),
      ),
    });
  }),
);

export default orgGatewayTest;
