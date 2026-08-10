/**
 * Translate Slack's own tenancy vocabulary into the generic
 * `{tenantId, actorId}` shape `@mcpjam/surface-core`'s factories read.
 *
 * Slack's `SlackContext` (`teamId`/`slackUserId`/`isLegacyWorkspace`) predates
 * the core and is used across dozens of files — renaming it everywhere would
 * be a much larger, riskier change for no behavioral gain. This is the one
 * seam where the two vocabularies meet.
 *
 * @param {import('./slack-context.js').SlackContext} ctx
 */
export function toSurfaceCtx(ctx) {
  return {
    tenantId: ctx.teamId,
    actorId: ctx.slackUserId,
    ...(ctx.isLegacyWorkspace === true ? { isLegacyTenant: true } : {}),
  };
}
