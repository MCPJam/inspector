/**
 * Where an approval is collected — the one seam between the agent and whatever
 * chat product a human clicks in.
 *
 * A proposal is only usable if there is somewhere to render its control and
 * somebody identifiable to click it. That is four facts (product, tenant,
 * actor, conversation) plus the MCPJam org the spend is attributed to, and
 * until now they were read directly off Slack-named context vars at each call
 * site. This module is where they are resolved instead, from the CANONICAL
 * context trio the auth middleware sets.
 *
 * The point is what it costs to add the second wrapper: a new auth branch sets
 * `surfaceKind`/`surfaceTenantId`/`surfaceActorId`, adds its `authMethod` to
 * the set below, and every route that gates on or resolves a surface already
 * works. No route surgery, and nothing Slack-shaped left in the routes to
 * mistake for a general rule.
 */
import type { Context } from "hono";

/**
 * Auth methods that identify a person on a chat surface.
 *
 * A set rather than an equality check because this is the list that grows —
 * and because the routes gating on it are the ones that SPEND, so what belongs
 * here deserves to be a visible, reviewable edit rather than an `||`.
 *
 * An `sk_` key or a JWT is deliberately absent: those name a MCPJam identity
 * but no surface, so there is no control to render and no clicker to
 * attribute an approval to.
 */
export const SURFACE_AUTH_METHODS: ReadonlySet<string> = new Set([
  "slack_service",
]);

export function isSurfaceAuthenticated(c: Context): boolean {
  const method = c.get("authMethod");
  return typeof method === "string" && SURFACE_AUTH_METHODS.has(method);
}

/** Who is acting, and where — without the conversation. */
export interface SurfaceActor {
  surfaceKind: string;
  tenantId: string;
  actorId: string;
  /** The MCPJam org the actor resolved to; what a spend is attributed to. */
  organizationId: string;
}

/** A surface complete enough to render an approval control on. */
export interface ProposalSurface extends SurfaceActor {
  conversationId: string;
}

/**
 * The acting surface identity, or undefined when this caller has none.
 *
 * All four fields or nothing: a partial identity is how a proposal ends up
 * attributed to a tenant with no actor, or a spend to an actor with no org.
 */
export function resolveSurfaceActor(c: Context): SurfaceActor | undefined {
  if (!isSurfaceAuthenticated(c)) return undefined;
  const surfaceKind = c.get("surfaceKind");
  const tenantId = c.get("surfaceTenantId");
  const actorId = c.get("surfaceActorId");
  const organizationId = c.get("mcpjamOrganizationId");
  if (!surfaceKind || !tenantId || !actorId || !organizationId) {
    return undefined;
  }
  return { surfaceKind, tenantId, actorId, organizationId };
}

/**
 * The surface a turn may propose onto, or undefined.
 *
 * `conversationId` is what makes the gated tools available at all: without
 * somewhere to render the control, the tools are omitted from the turn rather
 * than offered and then refused, so the model never plans around an action it
 * cannot take.
 *
 * @param body the turn request body; `conversationId` wins over the legacy
 *   `slackChannelId`, and both keep working
 */
export function resolveProposalSurface(
  c: Context,
  body: { conversationId?: string; slackChannelId?: string }
): ProposalSurface | undefined {
  const actor = resolveSurfaceActor(c);
  const conversationId = body.conversationId ?? body.slackChannelId;
  if (!actor || !conversationId) return undefined;
  return { ...actor, conversationId };
}
