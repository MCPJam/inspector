/**
 * Blocks for an agent reply: one "Run it" button per created eval suite.
 * Running is deliberately NOT something the agent turn can do — the button
 * click is the human approval that spends eval quota.
 */

export const RUN_SUITE_ACTION_ID = 'mcpjam_run_suite';

/**
 * @param {Array<{ type: string, id: string, name?: string, url: string }>} createdResources
 * @returns {Array<Record<string, unknown>>}
 */
export function buildCreatedResourceBlocks(createdResources) {
  const suites = createdResources.filter((resource) => resource.type === 'eval_suite');
  if (suites.length === 0) return [];
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  for (const suite of suites) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:test_tube: *<${suite.url}|${suite.name ?? 'Eval suite'}>* is ready to run.`,
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
  return blocks;
}
