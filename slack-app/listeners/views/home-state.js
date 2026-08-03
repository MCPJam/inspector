/**
 * Resolve the App Home's state for one user.
 *
 * The distinction that matters: "we asked and they are not linked" versus "we
 * could not ask". Collapsing them shows a linked user a Connect button, which
 * they will click — starting a second link flow and learning nothing about why
 * the bot was actually unavailable.
 */
import { mintConnectUrl } from '../../agent/connect-link.js';
import { listProjects } from '../../agent/mcpjam-client.js';
import { fetchAccountLink, hasPerUserAuth } from '../../agent/turn-target.js';

/** Deep links and "create a project" prompts must point at the deployment in use. */
export function resolveAppUrl() {
  const base = process.env.MCPJAM_APP_URL || process.env.MCPJAM_BASE_URL || 'https://app.mcpjam.com';
  return base.replace(/\/+$/, '');
}

/**
 * @param {import('../../agent/slack-context.js').SlackContext} ctx
 * @param {{ logger?: { warn?: Function } }} [opts]
 * @returns {Promise<Parameters<typeof import('./app-home-builder.js').buildAppHomeView>[0]>}
 */
export async function resolveHomeState(ctx, opts = {}) {
  const appUrl = resolveAppUrl();

  // Legacy/dev deployments have no per-user auth at all — a connect button
  // would lead nowhere, so show the connected shape with an empty picker.
  if (!hasPerUserAuth()) {
    return { connected: true, projects: [], appUrl };
  }

  let link;
  try {
    link = await fetchAccountLink(ctx.teamId, ctx.slackUserId);
  } catch (error) {
    opts.logger?.warn?.(`Could not resolve the account link for App Home: ${error}`);
    return { connected: false, unavailable: true, appUrl };
  }

  if (!link) {
    // Minted per render so the 10-minute clock starts when the user is
    // actually looking at the button. A failed mint renders an explicit
    // unavailable state rather than a dead button (see the builder).
    let connectUrl;
    try {
      connectUrl = await mintConnectUrl(ctx);
    } catch (error) {
      opts.logger?.warn?.(`Could not mint a connect URL: ${error}`);
    }
    return { connected: false, ...(connectUrl ? { connectUrl } : {}), appUrl };
  }

  // The project list comes from the USER's credentials, so it is exactly what
  // they may act in — never a superset borrowed from the bot, which would
  // offer projects the picker could not actually save.
  try {
    const projects = await listProjects({
      ...ctx,
      mode: 'user',
      projectId: link.defaultProjectId ?? undefined,
    });
    return {
      connected: true,
      projects,
      defaultProjectId: link.defaultProjectId ?? null,
      appUrl,
    };
  } catch (error) {
    opts.logger?.warn?.(`Could not list projects for the App Home picker: ${error}`);
    return {
      connected: true,
      projectsError: true,
      defaultProjectId: link.defaultProjectId ?? null,
      appUrl,
    };
  }
}
