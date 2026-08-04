/**
 * Blocks for the resources an agent reply created.
 *
 * Running is deliberately NOT something the agent turn can do — a human click
 * is the approval that spends eval quota.
 *
 * NOTHING HERE MAY DROP A RESOURCE. The envelope's `createdResources` is the
 * only record the user gets of what a turn persisted, and the server adds types
 * to it on its own schedule. A renderer that only understood the types it
 * shipped with would silently show nothing for the rest.
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
 * Human-readable label for a created-resource type the server invented after
 * this build shipped. `eval_suite` → "Eval suite".
 * @param {string} type
 */
function toResourceKindLabel(type) {
  const words = String(type)
    .split(/[_\-\s]+/)
    .filter(Boolean);
  if (words.length === 0) return 'Resource';
  const [first, ...rest] = words;
  const joined = [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
  return escapeSlackText(joined.slice(0, 40));
}

/**
 * Blocks for the resources a turn created.
 *
 * Suites get the Run-it accessory; ANY OTHER type gets a plain linked section.
 * The `filter(type === 'eval_suite')` this replaced was the highest-risk line
 * in the app: the server can start returning a new resource type at any deploy,
 * and the old filter dropped it silently — the user would be told a thing was
 * created and shown no link to it, with nothing anywhere reporting a problem.
 * Rendering an unknown type generically is strictly better than dropping it,
 * and it means a new resource type is a server-only change.
 *
 * @param {Array<{ type: string, id: string, name?: string, url: string }>} createdResources
 * @param {{ suiteAccessory?: boolean }} [opts] `suiteAccessory: false` omits the
 *   legacy Run-it button. Pass it only when an approval control for running the
 *   suite WILL be rendered — `rendersRunProposal` in `proposal-builder.js` is
 *   what answers that, because it owns the block cap that decides it. Both
 *   buttons is one hazard; zero is the other.
 * @returns {Array<Record<string, unknown>>}
 */
export function buildCreatedResourceBlocks(createdResources, opts = {}) {
  const resources = (Array.isArray(createdResources) ? createdResources : []).filter(
    (resource) => resource && typeof resource.url === 'string' && resource.url,
  );
  if (resources.length === 0) return [];

  const withAccessory = opts.suiteAccessory !== false;
  const shown = resources.slice(0, MAX_SUITE_BLOCKS);
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  for (const resource of shown) {
    if (resource.type === 'eval_suite') {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:test_tube: *<${resource.url}|${toSuiteLabel(resource.name ?? 'Eval suite')}>* is ready to run.`,
        },
        ...(withAccessory
          ? {
              accessory: {
                type: 'button',
                text: { type: 'plain_text', text: 'Run it' },
                style: 'primary',
                action_id: RUN_SUITE_ACTION_ID,
                value: resource.id,
              },
            }
          : {}),
      });
      continue;
    }
    // Unknown type: say what it is and link to it. No accessory — we do not
    // know what action would be appropriate, and guessing one is how a button
    // comes to do something nobody intended.
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        // The name goes through `toSuiteLabel` (cap + escape); the TYPE
        // fallback is already escaped by `toResourceKindLabel`, so passing it
        // through again would render `&amp;amp;` at the user.
        text: `:package: *<${resource.url}|${resource.name ? toSuiteLabel(resource.name) : toResourceKindLabel(resource.type)}>* — ${toResourceKindLabel(resource.type).toLowerCase()}.`,
      },
    });
  }
  if (resources.length > shown.length) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_…and ${resources.length - shown.length} more — open MCPJam to see them._`,
        },
      ],
    });
  }
  return blocks;
}
