/**
 * Blocks for an agent reply: one "Run it" button per created eval suite.
 * Running is deliberately NOT something the agent turn can do — the button
 * click is the human approval that spends eval quota.
 */

export const RUN_SUITE_ACTION_ID = 'mcpjam_run_suite';

/**
 * Slack allows 50 blocks per message, and the reply appends a feedback
 * block after these — so leave headroom rather than letting `streamer.stop`
 * reject and drop the whole reply.
 */
const MAX_SUITE_BLOCKS = 40;

/**
 * Slack rejects a section whose `mrkdwn` text exceeds 3,000 characters, and
 * a rejected block takes the WHOLE reply down. Suite names are agent output
 * over user input, so cap the display label — before escaping, since
 * escaping can quintuple length (`&` → `&amp;`).
 */
const MAX_SUITE_NAME_CHARS = 150;

/**
 * Suite names come from user-influenced agent output. In `mrkdwn`, raw `&`,
 * `<` and `>` are parsed as markup, so a name could break the link or forge
 * a mention. Slack's documented escaping is these three, in this order.
 * @param {string} text
 */
export function escapeSlackText(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Display label for a suite: length-capped on code-point boundaries, then
 * escaped. Order matters — capping after escaping could slice an entity
 * like `&amp;` in half.
 * @param {string} name
 */
export function toSuiteLabel(name) {
  const chars = Array.from(name);
  const capped = chars.length > MAX_SUITE_NAME_CHARS ? `${chars.slice(0, MAX_SUITE_NAME_CHARS - 1).join('')}…` : name;
  return escapeSlackText(capped);
}

/**
 * @param {Array<{ type: string, id: string, name?: string, url: string }>} createdResources
 * @returns {Array<Record<string, unknown>>}
 */
export function buildCreatedResourceBlocks(createdResources) {
  const suites = createdResources.filter((resource) => resource.type === 'eval_suite');
  if (suites.length === 0) return [];

  const shown = suites.slice(0, MAX_SUITE_BLOCKS);
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  for (const suite of shown) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:test_tube: *<${suite.url}|${toSuiteLabel(suite.name ?? 'Eval suite')}>* is ready to run.`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Run it' },
        style: 'primary',
        action_id: RUN_SUITE_ACTION_ID,
        value: suite.id,
      },
    });
  }
  if (suites.length > shown.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${suites.length - shown.length} more — open MCPJam to run them._`,
        },
      ],
    });
  }
  return blocks;
}
