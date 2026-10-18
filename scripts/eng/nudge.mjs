/**
 * When to offer the engineering flow. Two triggers share one offer per
 * branch: a prompt that asks for a change, and the first source edit. The
 * second catches what the first misses, such as a pasted plan or "go ahead".
 */
import { CLI } from './workflow.mjs';

const BUILD_VERBS = new Set(
  (
    'add build change create delete disable enable extract fix implement ' +
    'integrate introduce make migrate move port refactor remove rename ' +
    'replace rewrite ship split support update upgrade wire'
  ).split(' ')
);

/** "Can you", "please", "let's" and similar do not change what is asked. */
const LEAD_IN =
  /^(?:(?:please|ok(?:ay)?|now|so|then|also)[,\s]+|let'?s\s+|(?:can|could|would|will) you\s+(?:please\s+)?|i(?:'d| would)? (?:want|need|like) (?:you )?to\s+|we (?:need|want|should) to\s+|go ahead and\s+)*/;

/** A prompt that asks for a code change, not a question, review or slash command. */
export function isBuildPrompt(prompt) {
  const text = String(prompt).trim().toLowerCase();
  if (!text || text.startsWith('/')) return false;
  const verb = /^(\w+)/.exec(text.replace(LEAD_IN, ''));
  return Boolean(verb && BUILD_VERBS.has(verb[1]));
}

const SOURCE =
  /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|css|scss|html|sql|sh|py|go|rs|swift|kt)$/;

/** An edit to code or configuration inside `root`, not to notes or docs. */
export function isSourceEdit(file, root) {
  const inside = file.startsWith(`${root}/`) && !file.includes('/.git/');
  return inside && SOURCE.test(file);
}

export function offerText(branch, trigger) {
  return [
    `eng: ${trigger} on branch ${branch}, which has no Kestral task.`,
    'Offer the engineer the eng flow once, in one sentence: they approve the specs and a reviewed plan; you build, and record decisions, sessions and evidence on a Kestral task.',
    'If they accept, follow .agents/skills/eng/SKILL.md.',
    `If they decline, run \`${CLI} decline\`; it will not be offered again on this branch.`,
    'Do not hold up their request for this.',
  ].join(' ');
}
