/**
 * Blocks for actions the agent wants to take but may not take by itself.
 *
 * The agent turn can read the project and author suites; it cannot spend. When
 * it decides a suite should RUN, a case should run, cases should be generated,
 * or a run should be cancelled, it proposes — and this is what the person sees.
 *
 * The button carries ONLY the action id. Everything about what the click does
 * lives in the persisted proposal, because anyone who can post a Block Kit
 * message in the workspace can mint a button with any `value` they like. A
 * click may say WHICH action to run; it may never say what that action is.
 */
import { escapeSlackText } from './agent-reply-builder.js';

export const PROPOSAL_ACTION_ID = 'mcpjam_approve_action';

/**
 * Slack allows 50 blocks per message and this reply already carries suite
 * blocks and feedback blocks. Leave room rather than letting the post reject
 * and take the whole answer down with it.
 */
const MAX_PROPOSAL_BLOCKS = 5;

/** Slack caps a button label at 75 characters. */
const MAX_BUTTON_LABEL = 75;

/**
 * Slack rejects a section whose text exceeds 3,000 characters, and a rejected
 * block takes the WHOLE message down — the answer, the suite links, and every
 * approval button with it. The description is agent output, so it is capped
 * BEFORE escaping: escaping can quintuple length (`&` → `&amp;`), and capping
 * afterwards could slice an entity in half.
 */
const MAX_DESCRIPTION_CHARS = 400;

/** @param {string} text */
function toDescription(text) {
  const chars = Array.from(text);
  const capped = chars.length > MAX_DESCRIPTION_CHARS ? `${chars.slice(0, MAX_DESCRIPTION_CHARS - 1).join('')}…` : text;
  return escapeSlackText(capped);
}

/** Verb for the button, per operation. Falls back to a neutral "Approve". */
const BUTTON_LABELS = {
  run_eval_suite: 'Run it',
  run_eval_case: 'Run it',
  generate_eval_cases: 'Generate them',
  cancel_eval_run: 'Cancel the run',
};

/**
 * @param {Array<import('../../agent/mcpjam-client.js').ProposedAction> | undefined} proposals
 * @returns {Array<Record<string, unknown>>}
 */
export function buildProposalBlocks(proposals) {
  if (!Array.isArray(proposals) || proposals.length === 0) return [];

  const shown = proposals.slice(0, MAX_PROPOSAL_BLOCKS);
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  for (const proposal of shown) {
    if (!proposal?.actionId) continue;
    const label = (BUTTON_LABELS[/** @type {keyof typeof BUTTON_LABELS} */ (proposal.operation)] || 'Approve').slice(
      0,
      MAX_BUTTON_LABEL,
    );
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Capped, then escaped: raw `<`/`>` in mrkdwn can forge a mention or a
        // link, and an uncapped section fails the whole post.
        text: `:hourglass_flowing_sand: *${toDescription(String(proposal.description || 'Action'))}*\nThis one costs — it runs when you approve it.`,
      },
      accessory: {
        type: 'button',
        style: 'primary',
        text: { type: 'plain_text', text: label },
        action_id: PROPOSAL_ACTION_ID,
        value: proposal.actionId,
        // Spending is easy to click by accident and cannot be taken back.
        confirm: {
          title: { type: 'plain_text', text: 'Approve this action?' },
          text: {
            type: 'mrkdwn',
            text: "This runs as *you* and uses your organization's quota.",
          },
          confirm: { type: 'plain_text', text: label },
          deny: { type: 'plain_text', text: 'Not now' },
        },
      },
    });
  }
  if (proposals.length > shown.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${proposals.length - shown.length} more proposed — open MCPJam to review them._`,
        },
      ],
    });
  }
  return blocks;
}
