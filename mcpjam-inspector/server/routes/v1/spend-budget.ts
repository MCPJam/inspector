/**
 * GET / PUT /v1/organizations/:organizationId/spend-budget — the
 * organization's ceiling on MCPJam-billed spend per billing window.
 *
 * A separate file from `organizations.ts` on purpose. That route is read-only
 * by design, and its docblock states the rule this must not appear to break:
 * organization, member, invite, role and BILLING writes stay off every
 * machine surface, because the enterprise path for those is SCIM with its own
 * admin credential.
 *
 * The spend budget is not one of those writes. It moves no money, buys
 * nothing, and changes no one's access — it is a governance CEILING, and
 * "cap what this workspace can spend this month, from our own tooling" is the
 * exact thing an enterprise buyer wants to script. Authorization is the
 * backend's: `setOrganizationSpendBudget` requires org admin and refuses
 * guests at the boundary, so a read-only API key gets the same refusal here
 * as a member would in the console.
 */
import { Hono } from "hono";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { getConvexBearerForRequest } from "../../utils/v1-convex-token.js";
import { parseWithSchema, ErrorCode, WebRouteError } from "../web/errors.js";
import { translateConvexReadError } from "./convex-read-errors.js";
import { translateConvexWriteError } from "./convex-errors.js";
import { v1Resource } from "./envelope.js";

const spendBudget = new Hono();

function convexClient(token: string): ConvexHttpClient {
  const url = process.env.CONVEX_URL;
  if (!url) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "Server missing CONVEX_URL configuration",
    );
  }
  const client = new ConvexHttpClient(url);
  client.setAuth(token);
  return client;
}

/**
 * Dollars on the wire, credits in the store.
 *
 * The public surface speaks the unit the buyer budgets in; the ledger debits
 * whole credits (1 credit = 1¢) and the backend validates in that unit. Both
 * are reported so a caller never has to know the conversion to check its own
 * arithmetic.
 */
const putSchema = z
  .object({
    /** The ceiling, in USD. Rounded to the cent. */
    capUsd: z.number().finite().nonnegative(),
    /**
     * Whole percents of the cap to alert on. Reaching the cap always alerts,
     * so 100 is not accepted here — it would show the same threshold twice.
     *
     * The count bound and the uniqueness rule mirror the backend's
     * `normalizeSpendBudgetAlertPercents`, which is still the authority. They
     * are restated here so a caller gets a field-level validation error
     * naming what was wrong, instead of a generic platform refusal after a
     * round trip.
     */
    alertPercents: z
      .array(z.number().int().min(1).max(99))
      .max(5)
      .refine((values) => new Set(values).size === values.length, {
        message: "alertPercents must not repeat a threshold",
      })
      .optional(),
  })
  .strict();

type BudgetView = {
  capCredits: number | null;
  alertPercents: number[];
  consumedCredits: number;
  windowStartAt: number;
  windowEndsAt: number;
  alertedPercents: number[];
  capReachedAt: number | null;
  updatedAt: number | null;
  minCapCredits: number;
  maxCapCredits: number;
  supported: boolean;
};

const creditsToUsd = (credits: number) => Math.round(credits) / 100;

/**
 * The public projection. Hand-written rather than a pass-through: the caller
 * who set the budget is reported as an id only by the console, and a public
 * response has no reason to carry it.
 */
function toBudgetDto(view: BudgetView) {
  return {
    capUsd: view.capCredits === null ? null : creditsToUsd(view.capCredits),
    capCredits: view.capCredits,
    alertPercents: view.alertPercents,
    spentUsd: creditsToUsd(view.consumedCredits),
    spentCredits: view.consumedCredits,
    windowStartAt: view.windowStartAt,
    windowEndsAt: view.windowEndsAt,
    alertedPercents: view.alertedPercents,
    capReachedAt: view.capReachedAt,
    updatedAt: view.updatedAt,
    minCapUsd: creditsToUsd(view.minCapCredits),
    maxCapUsd: creditsToUsd(view.maxCapCredits),
    /** False for a personal organization, which cannot have a budget. */
    supported: view.supported,
  };
}

// GET — members and above may read the budget. A member who cannot raise the
// ceiling still needs to know it exists, because it is what refused their run.
spendBudget.get("/organizations/:organizationId/spend-budget", async (c) => {
  const organizationId = c.req.param("organizationId");
  const client = convexClient(await getConvexBearerForRequest(c));

  let view: BudgetView;
  try {
    view = (await client.query(
      "billing/spendBudgetSettings:getOrganizationSpendBudget" as any,
      { organizationId } as any,
    )) as BudgetView;
  } catch (error) {
    throw translateConvexReadError(error, { scope: "v1.spendBudget" });
  }

  return v1Resource(c, toBudgetDto(view));
});

// PUT — set or replace the budget. Org admin only; the backend enforces that.
spendBudget.put("/organizations/:organizationId/spend-budget", async (c) => {
  const organizationId = c.req.param("organizationId");
  const raw = await c.req.text();
  let parsedBody: unknown;
  try {
    parsedBody = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    throw new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "Request body must be valid JSON.",
    );
  }
  const body = parseWithSchema(putSchema, parsedBody);
  const client = convexClient(await getConvexBearerForRequest(c));

  try {
    await client.mutation(
      "billing/spendBudgetSettings:setOrganizationSpendBudget" as any,
      {
        organizationId,
        // The typed decimal is already gone by the time JSON parsing hands
        // this over — float64 has no exact 1.005 — so this rounds the value
        // that actually arrived and cannot recover one that never did. The
        // console converts from the typed STRING instead, where the intended
        // decimal still exists (`usdStringToCredits`).
        capCredits: Math.round(body.capUsd * 100),
        ...(body.alertPercents ? { alertPercents: body.alertPercents } : {}),
      } as any,
    );
  } catch (error) {
    throw translateConvexWriteError(error, {
      resource: "spend budget",
      fallbackMessage: "Spend budget rejected by the platform",
      adminFailureIsForbidden: true,
    });
  }

  // Read back rather than echoing the request: the stored value is the
  // authority, and a caller that sent $50.004 should see what was kept.
  let view: BudgetView;
  try {
    view = (await client.query(
      "billing/spendBudgetSettings:getOrganizationSpendBudget" as any,
      { organizationId } as any,
    )) as BudgetView;
  } catch (error) {
    throw translateConvexReadError(error, { scope: "v1.spendBudget" });
  }

  return v1Resource(c, toBudgetDto(view));
});

// DELETE — remove the ceiling, leaving the organization uncapped. The window
// counter survives on the backend: it is a record of spend, not of the budget.
spendBudget.delete("/organizations/:organizationId/spend-budget", async (c) => {
  const organizationId = c.req.param("organizationId");
  const client = convexClient(await getConvexBearerForRequest(c));

  try {
    await client.mutation(
      "billing/spendBudgetSettings:clearOrganizationSpendBudget" as any,
      { organizationId } as any,
    );
  } catch (error) {
    throw translateConvexWriteError(error, {
      resource: "spend budget",
      fallbackMessage: "Spend budget removal rejected by the platform",
      adminFailureIsForbidden: true,
    });
  }

  let view: BudgetView;
  try {
    view = (await client.query(
      "billing/spendBudgetSettings:getOrganizationSpendBudget" as any,
      { organizationId } as any,
    )) as BudgetView;
  } catch (error) {
    throw translateConvexReadError(error, { scope: "v1.spendBudget" });
  }

  return v1Resource(c, toBudgetDto(view));
});

export default spendBudget;
