/**
 * App Home account actions: pick a default project, and disconnect.
 *
 * Both re-render the Home tab afterwards. Slack does not re-publish a view on
 * its own, so without that the user would click, see nothing change, and click
 * again — which for "disconnect" is a confusing (if harmless) second call.
 */
import { mintConnectUrl } from '../../agent/connect-link.js';
import { listProjects } from '../../agent/mcpjam-client.js';
import { tryslackContextFrom } from '../../agent/slack-context.js';
import { fetchAccountLink, revokeAccountLink } from '../../agent/turn-target.js';
import { buildAppHomeView } from '../views/app-home-builder.js';

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The default-project write goes through the backend route, which re-verifies
 * that the project belongs to the LINK's organization. That check is not
 * optional politeness: the picker's options come from a list the user can see,
 * but the interaction payload that follows is just an id, and a stale or
 * crafted one must not bind a Slack user to a project outside their org.
 *
 * @param {import('../../agent/slack-context.js').SlackContext} ctx
 * @param {string | undefined} projectId
 */
async function setDefaultProject(ctx, projectId) {
  const baseUrl = (process.env.MCPJAM_CONVEX_HTTP_URL || '').replace(/\/+$/, '');
  const serviceToken = process.env.INSPECTOR_SERVICE_TOKEN;
  if (!baseUrl || !serviceToken) throw new Error('Backend config is required to set a default project.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${baseUrl}/slack/links/set-default-project`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-inspector-service-token': serviceToken,
      },
      body: JSON.stringify({
        teamId: ctx.teamId,
        slackUserId: ctx.slackUserId,
        ...(projectId ? { projectId } : {}),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.reason || `set-default-project failed (${response.status})`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Re-publish the Home tab from current state.
 * @param {Record<string, any>} args
 * @param {import('../../agent/slack-context.js').SlackContext} ctx
 */
async function republishHome(args, ctx) {
  const { client, logger } = args;
  const link = await fetchAccountLink(ctx.teamId, ctx.slackUserId).catch(() => null);
  if (!link) {
    const connectUrl = await mintConnectUrl(ctx).catch(() => undefined);
    await client.views.publish({
      user_id: ctx.slackUserId,
      view: buildAppHomeView({ connected: false, ...(connectUrl ? { connectUrl } : {}) }),
    });
    return;
  }
  /** @type {Array<{ id: string, name: string }>} */
  let projects = [];
  let projectsError = false;
  try {
    projects = await listProjects({ ...ctx, mode: 'user', projectId: link.defaultProjectId ?? undefined });
  } catch (error) {
    logger?.warn?.(`Could not list projects while re-rendering App Home: ${error}`);
    projectsError = true;
  }
  await client.views.publish({
    user_id: ctx.slackUserId,
    view: buildAppHomeView({
      connected: true,
      projects,
      defaultProjectId: link.defaultProjectId ?? null,
      projectsError,
    }),
  });
}

/**
 * Static-select: set the user's default project.
 * @param {Record<string, any>} args
 */
export async function handleProjectPicker(args) {
  const { ack, action, body, context, logger } = args;
  await ack();

  const ctx = tryslackContextFrom({ body, context });
  if (!ctx) return;

  const projectId = action?.selected_option?.value;
  if (!projectId) return;

  try {
    await setDefaultProject(ctx, projectId);
  } catch (error) {
    logger.error(`Could not set the default project: ${error}`);
  }
  // Re-render either way: on success it shows the new selection, and on
  // failure it shows the OLD one — which is the truth, and better than a
  // picker that appears to have accepted a value it did not save.
  await republishHome(args, ctx).catch((error) => {
    logger.warn(`Could not re-publish App Home: ${error}`);
  });
}

/**
 * Disconnect the account.
 *
 * The link is revoked but nothing the user created is touched — suites and
 * runs belong to their MCPJam account, not to the Slack connection, and
 * deleting them would be a wildly disproportionate response to "stop acting
 * as me in Slack".
 *
 * @param {Record<string, any>} args
 */
export async function handleUnlink(args) {
  const { ack, body, context, logger } = args;
  await ack();

  const ctx = tryslackContextFrom({ body, context });
  if (!ctx) return;

  try {
    await revokeAccountLink(ctx.teamId, ctx.slackUserId);
  } catch (error) {
    logger.error(`Could not unlink the Slack account: ${error}`);
  }
  await republishHome(args, ctx).catch((error) => {
    logger.warn(`Could not re-publish App Home after unlink: ${error}`);
  });
}

/**
 * The "Connect MCPJam" button carries a `url`, so Slack opens it directly.
 * Bolt still delivers the interaction and logs an "unhandled request" warning
 * without a listener, so this exists purely to ack it.
 * @param {Record<string, any>} args
 */
export async function handleConnectClick({ ack }) {
  await ack();
}
