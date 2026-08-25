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
 *
 * THE MESSAGE BUDGET IS EXACTLY FULL, which is why the pre-run disclosure
 * (`disclosureLine`) rides INSIDE a proposal's own section rather than in a
 * `context` block after it. Worst case on the replay path
 * (`events/run-and-reply.js`): 1 reply section + 40 created-resource blocks +
 * 1 resource overflow + 5 proposal sections + 1 proposal overflow + 1 replay
 * note + 1 feedback = 50, dead on Slack's ceiling. One extra block per
 * disclosed proposal would make that 55 and reject the post — losing the
 * answer, the suite links and every approval button, to add a hint. So the
 * disclosure costs zero blocks and spends section characters instead, of
 * which there are 3,000 and roughly 2,200 spare.
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
 * Escape first, then trim — budgeting in ESCAPED characters.
 *
 * Capping before escaping bounds the wrong string: `&` becomes `&amp;`, so a
 * description of 215 ampersands passes a 215-character cap and arrives as 1,075
 * characters. That fails the block, and a failed block takes the whole message
 * down — the answer, the links, and every approval button with it.
 *
 * Escaping each code point and accumulating whole escaped units is what makes
 * this safe in both directions: the budget is measured on what Slack actually
 * receives, and a cut can never land inside an entity like `&amp;`.
 *
 * @param {string} text
 * @param {number} max budget in escaped characters, ellipsis included
 */
function capEscaped(text, max) {
  if (max <= 0) return '';
  let out = '';
  for (const char of text) {
    const escaped = escapeSlackText(char);
    if (out.length + escaped.length > max - 1) return `${out}…`;
    out += escaped;
  }
  return out;
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
 *   - `external` — it leaves MCPJam entirely, and we cannot undo it;
 *   - `none` — it costs NOTHING, so the default's claim that it does is wrong.
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
    const preview = description ? capEscaped(String(description), room) : '';
    return preview && room > 24 ? `${warning}\n\n${preview}` : warning;
  }
  if (severity === 'spend') {
    return capChars(
      "This changes a RECURRING setting and will keep using your organization's quota until someone turns it off.",
      MAX_CONFIRM_TEXT,
    );
  }
  if (severity === 'none') {
    // The default below asserts a cost. For an action that stops spending —
    // clearing a schedule — that is simply false, and a confirmation dialog is
    // the last place to tell someone the opposite of what the click does.
    return 'This runs as *you*. It does not use any quota.';
  }
  return "This runs as *you* and uses your organization's quota.";
}

/**
 * Budget for the pre-run disclosure line, in ESCAPED characters.
 *
 * Shares the section's 3,000-character ceiling with the description (400) and
 * the severity note, so this is generous headroom rather than a tight fit. It
 * exists because the disclosure is SERVER-derived text entering mrkdwn, and an
 * unbounded string in a section is how one long provider list takes down a
 * whole reply.
 */
const MAX_DISCLOSURE_CHARS = 300;

/**
 * One line saying what a run of this proposal would disclose.
 *
 * ABSENT MEANS UNKNOWN, NEVER SAFE — the whole point of the field. Every
 * clause below is emitted only from a field that is actually PRESENT: a
 * proposal with no `disclosure` gets no line at all, and one whose disclosure
 * could not name an engine says nothing about the engine rather than
 * "emulated". A default line here would be the one failure mode a disclosure
 * must not have, because the reassuring reading is exactly the one absence
 * would become.
 *
 * `sandbox.engaged: false` IS rendered ("no sandbox"): the field is present,
 * so that is a fact the contract answered, not a guess standing in for one.
 *
 * Wording tracks `run-disclosure-hint.tsx` / the CLI's disclosure block, so a
 * person who has seen this in the app reads the same claims here.
 *
 * @param {{ engine?: string, sandbox?: { engaged?: boolean, vendor?: string },
 *   runProviders?: string[], judgeProviders?: string[], byok?: boolean,
 *   retention?: { policyDays?: number | null, effectiveToday?: string } } | undefined} disclosure
 * @returns {string} escaped mrkdwn, or '' when there is nothing honest to say
 */
export function disclosureLine(disclosure) {
  if (!disclosure || typeof disclosure !== 'object') return '';
  /** @type {string[]} */
  const parts = [];
  if (typeof disclosure.engine === 'string' && disclosure.engine) {
    parts.push(`runs via ${disclosure.engine}`);
  }
  const sandbox = disclosure.sandbox;
  if (sandbox && typeof sandbox === 'object' && typeof sandbox.engaged === 'boolean') {
    parts.push(sandbox.engaged ? `sandboxed${sandbox.vendor ? ` (${sandbox.vendor})` : ''}` : 'no sandbox');
  }
  // Only when TRUE. `false` is the managed rail every approver already assumes,
  // and a clause restating the default would crowd out the ones that do not.
  if (disclosure.byok === true) parts.push("on your organization's own API key");
  const runProviders = Array.isArray(disclosure.runProviders) ? disclosure.runProviders : [];
  if (runProviders.length > 0) parts.push(`models reach ${runProviders.join(', ')}`);
  const judgeProviders = Array.isArray(disclosure.judgeProviders) ? disclosure.judgeProviders : [];
  if (judgeProviders.length > 0) {
    // The surprise worth stating: the server already subtracted the run's own
    // providers, so anything left is somewhere the approver did not choose.
    parts.push(`judges also send evidence to ${judgeProviders.join(', ')}`);
  }
  const retention = disclosure.retention;
  if (retention && typeof retention === 'object') {
    // Straight from `effectiveToday` — NEVER re-derived from `policyDays`, an
    // unenforced policy keeps data indefinitely whatever its number says.
    if (retention.effectiveToday === 'kept-indefinitely') {
      parts.push('kept indefinitely');
    } else if (retention.effectiveToday === 'swept-after-policy-days') {
      parts.push(
        typeof retention.policyDays === 'number'
          ? `swept after ${retention.policyDays} day${retention.policyDays === 1 ? '' : 's'}`
          : 'swept after the plan policy',
      );
    }
  }
  if (parts.length === 0) return '';
  return capEscaped(parts.join(' · '), MAX_DISCLOSURE_CHARS);
}

/**
 * The line under the description, chosen by the SAME severity the confirm
 * dialog reads.
 *
 * These two are claims about one click, and a person sees the section before
 * they ever open the dialog. Letting only the dialog know that clearing a
 * schedule costs nothing means the message still tells them it costs — and the
 * first of the two they read is the one they believe.
 *
 * @param {string | undefined} severity
 */
function sectionNote(severity) {
  if (severity === 'none') return 'This one costs nothing — it takes effect when you approve it.';
  if (severity === 'external') return 'This one leaves MCPJam — it runs when you approve it.';
  return 'This one costs — it runs when you approve it.';
}

/**
 * Will an approval control for running THIS suite actually be rendered?
 *
 * Lives here because this module owns both rules that decide it: the
 * `MAX_PROPOSAL_BLOCKS` cap and the `actionId` skip. Asking "does the envelope
 * contain a run proposal?" is the wrong question twice over — a run proposal
 * sitting at index six is not rendered, and one targeting a DIFFERENT suite is
 * no substitute: "make a suite for X and rerun smoke" would strip X's only run
 * affordance on the strength of smoke's button.
 *
 * @param {Array<import('../../agent/mcpjam-client.js').ProposedAction> | undefined} proposals
 * @param {{ id?: string, name?: string } | undefined} resource the created suite
 */
export function rendersRunProposalFor(proposals, resource) {
  if (!Array.isArray(proposals)) return false;
  return proposals.slice(0, MAX_PROPOSAL_BLOCKS).some((proposal) => {
    if (!proposal?.actionId || proposal.operation !== 'run_eval_suite') return false;
    const target = proposal.target;
    // No target: an older server. Match-unknown must SUPPRESS — two buttons
    // for one billed run is the costlier mistake, and stripping every suite
    // is exactly the pre-target behavior this falls back to.
    if (!target || typeof target.selector !== 'string' || !target.selector) {
      return true;
    }
    if (target.type !== 'eval_suite') return false;
    // The server's own post-create offer selects by id; a model-authored
    // proposal may have selected by name. Match both, so "make a suite for X
    // and rerun smoke" keeps X's run button while smoke's proposal renders.
    if (target.selector === resource?.id) return true;
    const name = typeof resource?.name === 'string' ? resource.name : '';
    return Boolean(name) && target.selector.toLowerCase() === name.toLowerCase();
  });
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
    // Already escaped and capped. Empty for a proposal the server did not
    // disclose — an older server, an operation that carries no disclosure, or
    // a fetch that failed — and an empty string renders NOTHING, never a
    // stand-in line.
    const disclosure = disclosureLine(proposal.disclosure);
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // Capped, then escaped: raw `<`/`>` in mrkdwn can forge a mention or a
        // link, and an uncapped section fails the whole post.
        text: `:hourglass_flowing_sand: *${toDescription(String(proposal.description || 'Action'))}*\n${sectionNote(proposal.confirmSeverity)}${
          disclosure ? `\n_${disclosure}_` : ''
        }`,
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
