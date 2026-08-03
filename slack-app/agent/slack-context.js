/**
 * The per-event tenancy context every downstream call must carry.
 *
 * The bot used to be single-tenant: one workspace, one env-configured API key,
 * one project. Every cache key, dedupe key, and credential lookup was
 * process-global, which is exactly the set of things that silently CROSS
 * workspaces once a second team installs the app. This module makes the
 * tenant explicit at the boundary — nothing downstream may reach for
 * `process.env` or a bare `channelId` key again.
 *
 * `teamId` is the tenant. `slackUserId` is the ACTOR — the human whose
 * identity the turn runs as once per-user auth lands. Both are extracted from
 * the Slack payload rather than passed around implicitly, so a listener that
 * forgets one fails loudly here instead of quietly acting as the wrong tenant.
 */

/**
 * @typedef {Object} SlackContext
 * @property {string} teamId       Slack workspace id (the tenant).
 * @property {string} slackUserId  Slack user id of the event's actor.
 */

export class SlackContextError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SlackContextError';
  }
}

/**
 * Pull the tenancy context out of a Bolt listener's arguments.
 *
 * Sources differ by payload shape, so all three are consulted in priority
 * order rather than trusting one: Bolt's `context` is populated for events,
 * `body` carries `team`/`team_id` for interactive payloads, and the event
 * itself carries `user`/`team` for a few event types. An
 * enterprise-grid-installed app can also report the team under
 * `body.team.id` only.
 *
 * @param {{ context?: Record<string, any>, body?: Record<string, any>, event?: Record<string, any>, payload?: Record<string, any> }} args
 * @returns {SlackContext}
 */
export function slackContextFrom(args) {
  const context = args.context ?? {};
  const body = args.body ?? {};
  const event = args.event ?? args.payload ?? {};

  const teamId =
    firstString(
      context.teamId,
      body.team_id,
      body.team?.id,
      event.team,
      event.user_team,
      // `authorizations` is what the Events API sends for a shared channel:
      // the installing team is the one whose token we must act with.
      body.authorizations?.[0]?.team_id,
    ) ?? '';

  const slackUserId = firstString(context.userId, event.user, body.user?.id, body.user_id, event.user_id) ?? '';

  if (!teamId) {
    throw new SlackContextError('Slack payload carried no team id — refusing to run a turn without a tenant.');
  }
  if (!slackUserId) {
    throw new SlackContextError('Slack payload carried no user id — refusing to run a turn without an actor.');
  }
  return { teamId, slackUserId };
}

/**
 * Same extraction, but returns null instead of throwing. For listeners whose
 * correct response to a malformed payload is to drop it silently (Slack will
 * not benefit from an error, and there is nowhere safe to post one).
 *
 * @param {Parameters<typeof slackContextFrom>[0]} args
 * @returns {SlackContext | null}
 */
export function tryslackContextFrom(args) {
  try {
    return slackContextFrom(args);
  } catch (error) {
    if (error instanceof SlackContextError) return null;
    throw error;
  }
}

/**
 * Namespace an arbitrary key by tenant. Every process-global map in this app
 * goes through here so a workspace can never observe or evict another's
 * entries.
 *
 * @param {SlackContext | { teamId: string }} ctx
 * @param {string} key
 */
export function tenantKey(ctx, key) {
  return `${ctx.teamId}:${key}`;
}

/** @param {...unknown} values */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}
