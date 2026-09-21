/**
 * Slack's binding to the shared MCPJam API client.
 *
 * The transport — timeouts, the whole-exchange abort, the non-JSON body rule,
 * the error envelope, the run-link preference — lives in `@mcpjam/surface-core`
 * and is identical for every surface. What stays HERE is the part that is
 * genuinely Slack's: which credential a given Slack event may act with, and
 * under which headers the server should resolve the acting human.
 *
 * RETRY POLICY (enforced by the core client): never blind-retry a turn. The
 * endpoint is not idempotent — a lost response may still have persisted an
 * eval suite. Dedupe lives at the trigger, not here.
 *
 * Env:
 *   MCPJAM_API_KEY    — sk_… key minted in the MCPJam app (legacy workspace only)
 *   MCPJAM_PROJECT_ID — the project legacy-mode turns are scoped to
 *   MCPJAM_BASE_URL   — defaults to https://app.mcpjam.com
 *   MCPJAM_SLACK_SERVICE_TOKEN — slk_… , the per-user mode's bot credential
 */
import { createApiClient, McpjamApiError } from '@mcpjam/surface-core';

export { McpjamApiError };

const DEFAULT_BASE_URL = 'https://app.mcpjam.com';

/** @typedef {{ role: 'user' | 'assistant', content: string }} TurnMessage */
/**
 * @typedef {Object} AgentTurnResult
 * @property {string} reply
 * @property {Array<{ operation: string }>} toolCalls
 * @property {Array<{ type: string, id: string, name?: string, url: string }>} createdResources
 * @property {Array<ProposedAction>} [proposedActions]
 */
/**
 * An action the turn wants to take but is not allowed to take on its own.
 * Rendered as a button; the click is the approval that spends.
 *
 * Everything past `actionId` is RENDERING METADATA the server decided. It must
 * never be sent back: the click carries the id and nothing else, because the
 * server is what holds the meaning of that id.
 *
 * `buttonLabel`, `kind`, and `confirmSeverity` are optional on this type
 * because an older server does not send them — not because they are optional
 * on a current one. Every consumer falls back rather than assuming.
 *
 * @typedef {Object} ProposedAction
 * @property {string} actionId
 * @property {string} operation
 * @property {string} description
 * @property {string} [buttonLabel]
 * @property {'start' | 'cancel' | 'generate' | 'schedule' | 'external'} [kind]
 * @property {'spend' | 'external' | 'none'} [confirmSeverity]
 * @property {{ type: string, selector: string }} [target] what the proposal is
 *   about, in the operation's own selector vocabulary (id or name — match
 *   both). Absent on older servers and unTargeted operations: treat as
 *   match-unknown.
 */

/**
 * Resolve the credentials and project one Slack event should act with.
 *
 * TWO MODES, and the ctx says which:
 *
 *   'user'   — the actor has linked their MCPJam account. The bot presents its
 *              `slk_` service credential plus the Slack team/user headers, and
 *              the server resolves the LINKED USER's identity from them. The
 *              bot never holds a user token: delegated JWTs are portable
 *              2-hour org credentials, and a compromised bot must not be able
 *              to harvest them.
 *   'legacy' — the one pre-OAuth workspace, acting on the shared org-scoped
 *              `sk_` key. Gated on the tenant guard's verdict and re-asserted
 *              HERE, at the credential seam: this is the last point before a
 *              secret is handed out, and a call path that forgot the guard
 *              must fail closed rather than inherit our organization's key.
 *
 * @param {import('./slack-context.js').SlackContext & { mode?: 'user' | 'legacy', projectId?: string }} ctx
 */
export function getConfig(ctx) {
  if (!ctx?.teamId || !ctx?.slackUserId) {
    throw new McpjamApiError('MCPJam credentials were requested without a Slack tenant context.', { code: 'CONFIG' });
  }
  const baseUrl = (process.env.MCPJAM_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Deep links can point somewhere other than the API host — in local dev
  // the API is on :6274 while the app UI is served on :5173.
  const appUrl = (process.env.MCPJAM_APP_URL || baseUrl).replace(/\/+$/, '');

  if (ctx.mode === 'user') {
    const serviceToken = process.env.MCPJAM_SLACK_SERVICE_TOKEN;
    if (!serviceToken) {
      throw new McpjamApiError('MCPJAM_SLACK_SERVICE_TOKEN must be set to act as a linked user.', {
        code: 'CONFIG',
      });
    }
    if (!ctx.projectId) {
      throw new McpjamApiError('No project resolved for this turn.', { code: 'NO_PROJECT' });
    }
    return {
      apiKey: serviceToken,
      projectId: ctx.projectId,
      baseUrl,
      appUrl,
      // The identity. Without both, the server has no user to act as and
      // answers 401 — which is the correct outcome, not a fallback.
      headers: /** @type {Record<string, string>} */ ({
        'x-mcpjam-slack-team-id': ctx.teamId,
        'x-mcpjam-slack-user-id': ctx.slackUserId,
      }),
    };
  }

  if (ctx.isLegacyWorkspace !== true) {
    throw new McpjamApiError(
      `Workspace ${ctx.teamId} has no MCPJam credentials: the shared API key is scoped to the legacy workspace only.`,
      { code: 'UNAUTHORIZED' },
    );
  }
  const apiKey = process.env.MCPJAM_API_KEY;
  const projectId = ctx.projectId || process.env.MCPJAM_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new McpjamApiError('MCPJAM_API_KEY and MCPJAM_PROJECT_ID must be set (see .env.sample).', { code: 'CONFIG' });
  }
  return { apiKey, projectId, baseUrl, appUrl, headers: /** @type {Record<string, string>} */ ({}) };
}

/**
 * `slackChannelId` is the legacy spelling of the turn's conversation field; the
 * server accepts both and prefers `conversationId`. Slack keeps sending the old
 * name until the server-side generic headers ship, so this adoption is
 * byte-identical on the wire.
 *
 * `channelId` is also what makes the SPENDING tools available at all: the
 * server only offers them when it knows where an approval button can be
 * rendered, so omitting it means the model is never given a run/generate/cancel
 * tool to call. That is the intended degradation.
 */
const client = createApiClient({
  surfaceKind: 'slack',
  conversationField: 'slackChannelId',
  // Overrides ride on the context because Slack's credential resolution keys
  // off the context alone — `listProjects` leans on this to ask for a project
  // list before any project is chosen.
  getConfig: (ctx, overrides = {}) => getConfig({ ...ctx, ...overrides }),
});

export const {
  runAgentTurn,
  executeProposedAction,
  startSuiteRun,
  getEvalRun,
  // The run's decision summary — read once, on a terminal non-pass, so the
  // outcome message can name where the chain broke.
  getEvalRunDecisionSummary,
  listEvalRunIterations,
  getEvalRunSteps,
  // Journey (Swarms) runs — the watcher's status poll and its evidence reads.
  getJourneyRun,
  listJourneyRunSessions,
  getJourneyRunScorecard,
  listProjects,
} = client;
