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
 * Slack caps a confirm dialog's `confirm`/`deny` labels at 30 characters —
 * a THIRD of what the button itself allows. Reusing the button label verbatim
 * would fail the block, and a failed block takes the whole message down.
 */
const MAX_CONFIRM_LABEL = 30;

/**
 * Slack caps a confirm dialog's `text` at 300 characters. This is the ceiling
 * the sterner copy has to fit inside, INCLUDING any parameter preview appended
 * to it — so the preview is what gives way, never the warning.
 */
const MAX_CONFIRM_TEXT = 300;

/**
 * Trim to a character budget on code-point boundaries.
 * @param {string} text
 * @param {number} max
 */
function capChars(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, Math.max(max - 1, 0)).join('')}…` : text;
}

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

/**
 * Verb for the button, per operation — the MIXED-VERSION FALLBACK only.
 *
 * The server now sends `buttonLabel` with every proposal, which is what makes a
 * new gated operation reach users properly labelled without a bot deploy. This
 * table exists for the window where a new bot is talking to an older server;
 * anything it does not recognise gets a neutral "Approve", which is honest
 * rather than wrong.
 */
const BUTTON_LABELS = {
  run_eval_suite: 'Run it',
  run_eval_case: 'Run it',
  generate_eval_cases: 'Generate them',
  cancel_eval_run: 'Cancel the run',
};

/**
 * Confirmation copy, chosen by the SEVERITY the server sent.
 *
 * The default already says the two things that always apply — it runs as you,
 * and it costs. A severity is the server saying that is not enough:
 *   - `spend` — it recurs, so the cost is not a one-off;
 *   - `external` — it leaves MCPJam entirely, and we cannot undo it.
 *
 * An unrecognised severity falls back to the default rather than to silence: a
 * missing warning is worse than a generic one.
 *
 * @param {string | undefined} severity
 * @param {string | undefined} description
 */
function confirmCopy(severity, description) {
  if (severity === 'external') {
    const warning = 'This runs a tool on a third-party server as *you*. MCPJam cannot undo what it does.';
    // The warning is never what gets truncated: budget the preview against
    // what is left of Slack's 300-character ceiling, and drop it entirely if
    // there is no room for anything meaningful.
    const room = MAX_CONFIRM_TEXT - warning.length - 2;
    const preview = description ? escapeSlackText(capChars(String(description), room)) : '';
    return preview && room > 24 ? `${warning}\n\n${preview}` : warning;
  }
  if (severity === 'spend') {
    return capChars(
      "This changes a RECURRING setting and will keep using your organization's quota until someone turns it off.",
      MAX_CONFIRM_TEXT,
    );
  }
  return "This runs as *you* and uses your organization's quota.";
}

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
    // Server first. It knows what the operation is; this bot only knows what
    // it knew at build time.
    const label = String(
      proposal.buttonLabel ||
        BUTTON_LABELS[/** @type {keyof typeof BUTTON_LABELS} */ (proposal.operation)] ||
        'Approve',
    ).slice(0, MAX_BUTTON_LABEL);
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
            text: confirmCopy(proposal.confirmSeverity, proposal.description),
          },
          // A THIRD of the button's allowance — see MAX_CONFIRM_LABEL.
          confirm: { type: 'plain_text', text: capChars(label, MAX_CONFIRM_LABEL) },
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
