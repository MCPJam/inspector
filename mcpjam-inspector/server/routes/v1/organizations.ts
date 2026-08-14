/**
 * GET /v1/organizations — the organizations the caller belongs to.
 *
 * Closes an ergonomic hole rather than adding a capability: `/v1/projects`
 * takes an `organizationId` filter and `POST /v1/projects` takes one in its
 * body, but no machine surface could DISCOVER an organization id. `/v1/me`
 * returns none, and the only reader of `organizations:getMyOrganizations` was
 * the browser app shell.
 *
 * READ-ONLY, and deliberately the whole story: organization, member, invite,
 * role and billing WRITES stay off every machine surface. The enterprise path
 * for programmatic membership is SCIM with its own admin credential, not an
 * API key that also happens to be able to run evals.
 *
 * Not a Convex-public-API proxy like `catalog.ts` — the backing query has no
 * `/v1/*` route on the Convex side — so this is an Inspector Convex-client
 * route in the shape of `projects.ts`.
 */
import { Hono } from "hono";
import { ConvexHttpClient } from "convex/browser";
import {
  getConvexBearerForRequest,
  getDelegatedOrganizationId,
} from "../../utils/v1-convex-token.js";
import { ErrorCode, WebRouteError } from "../web/errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { v1PageJson } from "./envelope.js";

const organizations = new Hono();

function convexClient(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration"
    );
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

/**
 * The public projection.
 *
 * Hand-written, and NOT a pass-through of the query result: that payload is
 * shaped for the app shell's org switcher and carries Stripe ids, trial and
 * dunning clocks, billing intervals and seat counts. Listing the fields here
 * means a column added to the organizations table cannot silently become part
 * of a public API response.
 */
function toOrganizationDto(row: Record<string, unknown>) {
  return {
    id: String(row._id ?? row.id ?? ""),
    name: String(row.name ?? ""),
    plan: typeof row.plan === "string" ? row.plan : null,
    myRole: typeof row.myRole === "string" ? row.myRole : null,
    isCreator: row.isCreator === true,
    logoUrl: typeof row.logoUrl === "string" ? row.logoUrl : null,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : null,
  };
}

// GET /v1/organizations — organizations the caller belongs to.
//
// Guests are default-denied: no `guest-allowed-paths.ts` rule matches, which
// is the same treatment `/me` gets. A guest belongs to no organization worth
// naming, and the boundary check in `index.ts` rejects the request before it
// reaches this handler.
organizations.get("/organizations", async (c) => {
  const token = await getConvexBearerForRequest(c);
  let rows: Array<Record<string, unknown>>;
  try {
    // Direct Convex call, so the shared read-error classifier applies: Convex's
    // failure text is written for us and can quote function names and argument
    // validator output. It goes to the log, redacted; the caller gets a code.
    rows = ((await convexClient(token).query(
      "organizations:getMyOrganizations" as any,
      {} as any
    )) ?? []) as Array<Record<string, unknown>>;
  } catch (error) {
    throw translateConvexReadError(error, { scope: "v1.organizations" });
  }

  // THE CLAMP. `getMyOrganizations` answers for the acting HUMAN and takes no
  // organization argument, so a delegated token — which is org-scoped by
  // construction everywhere else — would carry every sibling organization of
  // whoever minted the `sk_` key straight through it. Intersect here, matching
  // how the Convex `/v1/projects` route rejects an `organizationId` filter
  // outside the key's scope (convex/publicApi/routes.ts).
  const delegatedOrganizationId = getDelegatedOrganizationId(c);
  const items = rows
    .map(toOrganizationDto)
    .filter(
      (organization) =>
        !delegatedOrganizationId || organization.id === delegatedOrganizationId
    );

  return v1PageJson(c, items);
});

export default organizations;
