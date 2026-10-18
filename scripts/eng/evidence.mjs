/**
 * Acceptance evidence. Each acceptance scenario from the product spec gets
 * a result: passed or failed only with evidence (a test run, a log, an
 * artifact), or unverified. Every result records the commit it was taken at
 * and whether the tree was clean, so the review page can tell evidence for
 * the code under review from evidence for something older.
 */
import { requireTask } from './effort.mjs';
import { git } from './state.mjs';
import { changeTaskFor } from './sync.mjs';
import { CLI } from './workflow.mjs';

export const RESULTS = ['passed', 'failed', 'unverified'];

/** The commit the tree is at, and whether it has uncommitted changes. */
export function provenance(root) {
  return {
    commit: git(['rev-parse', '--short', 'HEAD'], root),
    dirty: git(['status', '--porcelain'], root) !== '',
  };
}

export function addScenario(task, text) {
  if (!text) {
    throw new Error('Describe the scenario: eng scenario add "<scenario>".');
  }
  task.scenarios ??= [];
  const scenario = {
    id: `S${task.scenarios.length + 1}`,
    text,
    result: 'unverified',
    evidence: null,
    note: '',
  };
  task.scenarios.push(scenario);
  return scenario;
}

export function setResult(task, id, result, fields) {
  const { evidence, note, at, commit, dirty } = fields;
  const scenario = (task.scenarios ?? []).find((s) => s.id === id);
  if (!scenario) {
    throw new Error(
      `No scenario ${id} on ${task.key}. \`${CLI} scenario list\` shows them.`
    );
  }
  if (!RESULTS.includes(result)) {
    throw new Error(`Use one of ${RESULTS.join(', ')}.`);
  }
  if (result !== 'unverified' && !evidence) {
    throw new Error(
      `A ${result} result needs --evidence: the test, log or artifact that shows it.`
    );
  }
  Object.assign(scenario, {
    result,
    evidence:
      result === 'unverified' ? null : { ref: evidence, commit, dirty, at },
    note: note ?? '',
  });
  return scenario;
}

function scenario(effort, { positional, flags }) {
  const [action, ...rest] = positional;
  requireTask(effort);
  if (action === 'list' || !action) {
    const rows = (effort.task.scenarios ?? []).map(
      (s) =>
        `${s.id} ${s.result}: ${s.text}${s.evidence ? ` (evidence: ${s.evidence.ref} at ${s.evidence.commit})` : ''}`
    );
    return (
      rows.join('\n') ||
      `No scenarios yet. Add each from the product spec with \`${CLI} scenario add "<scenario>"\`.`
    );
  }
  if (action === 'add') {
    const row = changeTaskFor(effort, (t) => addScenario(t, rest.join(' ')));
    return `Added ${row.id}.`;
  }
  const proof = provenance(effort.co.root);
  const at = new Date().toISOString();
  const row = changeTaskFor(effort, (t) =>
    setResult(t, action, rest[0], { ...flags, ...proof, at })
  );
  const dirty = proof.dirty
    ? ' The tree had uncommitted changes, so the review page flags this result.'
    : '';
  return `${row.id} is ${row.result} at ${proof.commit}.${dirty}`;
}

export const evidenceCommands = { scenario };
