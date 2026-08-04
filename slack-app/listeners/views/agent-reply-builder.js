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
 *
 * Coerces first: the name rides an envelope this build does not control, and a
 * numeric `name` throwing in here would take down the whole reply — against
 * this module's own "nothing here may drop a resource" charter.
 * @param {unknown} name
 */
export function toSuiteLabel(name) {
  const text = typeof name === 'string' ? name : String(name ?? 'Eval suite');
  const chars = Array.from(text);
  const capped = chars.length > MAX_SUITE_NAME_CHARS ? `${chars.slice(0, MAX_SUITE_NAME_CHARS - 1).join('')}…` : text;
  return escapeSlackText(capped);
}

/**
 * A resource url safe to interpolate into an mrkdwn link.
 *
 * The url comes from the same trusted-server envelope as the names — which
 * already get escaped, so trusting the url verbatim was this module's one
 * asymmetry. `https:` only (matching the stance run-evidence takes on the
 * same envelope's artifact urls), and `|` — mrkdwn's own label separator —
 * is the one character that could smuggle display text, so it is encoded.
 * Returns null for anything unparseable; callers render the name unlinked
 * rather than dropping the resource.
 * @param {unknown} url
 */
export function toSafeResourceUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    if (new URL(url).protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return url.replaceAll('|', '%7C');
}

/**
 * An mrkdwn link when the url passes `toSafeResourceUrl`, the bare (already
 * escaped) label when it does not — a resource with a bad url is still shown.
 * @param {unknown} url
 * @param {string} escapedLabel
 */
function linkedLabel(url, escapedLabel) {
  const safeUrl = toSafeResourceUrl(url);
  return safeUrl ? `<${safeUrl}|${escapedLabel}>` : escapedLabel;
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
 * @param {{ suiteAccessory?: boolean | ((resource: { type: string, id: string, name?: string, url: string }) => boolean) }} [opts]
 *   `suiteAccessory: false` omits the legacy Run-it button; a FUNCTION decides
 *   per suite, which is what target-aware suppression needs — a proposal that
 *   runs suite B must not cost suite A its only run affordance. Pass false (or
 *   a function answering false) only when an approval control for running THAT
 *   suite will be rendered — `rendersRunProposalFor` in `proposal-builder.js`
 *   is what answers it, because it owns the block cap that decides. Both
 *   buttons is one hazard; zero is the other.
 * @returns {Array<Record<string, unknown>>}
 */
export function buildCreatedResourceBlocks(createdResources, opts = {}) {
  const resources = (Array.isArray(createdResources) ? createdResources : []).filter(
    (resource) => resource && typeof resource.url === 'string' && resource.url,
  );
  if (resources.length === 0) return [];

  /** @param {{ type: string, id: string, name?: string, url: string }} resource */
  const accessoryFor = (resource) =>
    typeof opts.suiteAccessory === 'function'
      ? opts.suiteAccessory(resource) !== false
      : opts.suiteAccessory !== false;
  const shown = resources.slice(0, MAX_SUITE_BLOCKS);
  /** @type {Array<Record<string, unknown>>} */
  const blocks = [];
  for (const resource of shown) {
    if (resource.type === 'eval_suite') {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:test_tube: *${linkedLabel(resource.url, toSuiteLabel(resource.name ?? 'Eval suite'))}* is ready to run.`,
        },
        ...(accessoryFor(resource)
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
        text: `:package: *${linkedLabel(resource.url, resource.name ? toSuiteLabel(resource.name) : toResourceKindLabel(resource.type))}* — ${toResourceKindLabel(resource.type).toLowerCase()}.`,
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
