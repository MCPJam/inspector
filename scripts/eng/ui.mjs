/**
 * The UI diff ledger: which states a user-visible change must show, and
 * each screenshot of them, labeled current, proposed or actual. An actual
 * screenshot records the commit it was taken at, whether the tree was
 * clean, and how to reproduce it, and is queued for upload with its label.
 */
import { requireTask } from './effort.mjs';
import { provenance } from './evidence.mjs';
import { enqueue } from './outbox.mjs';
import { changeTaskFor } from './sync.mjs';

export const UI_STATES = [
  'default',
  'loading',
  'empty',
  'error',
  'permission',
  'narrow',
];
const PHASES = ['current', 'proposed', 'actual'];
const LABEL = { current: 'Current', proposed: 'Proposed', actual: 'Actual' };

const emptyUi = (impact) => ({
  impact,
  applicable: ['default'],
  shots: [],
  deviations: [],
});

export function addShot(
  task,
  { path, phase, state, steps, commit, dirty, at }
) {
  if (!PHASES.includes(phase)) {
    throw new Error(`--phase is one of ${PHASES.join(', ')}.`);
  }
  if (!UI_STATES.includes(state)) {
    throw new Error(`--state is one of ${UI_STATES.join(', ')}.`);
  }
  if (phase === 'actual' && !steps) {
    throw new Error(
      'An actual screenshot needs --steps: how to reproduce what it shows.'
    );
  }
  task.ui ??= emptyUi('user-visible');
  task.ui.impact = 'user-visible';
  const shot = {
    id: `U${task.ui.shots.length + 1}`,
    path,
    phase,
    state,
    at,
    ...(phase === 'actual' ? { commit, dirty, steps } : {}),
  };
  task.ui.shots.push(shot);
  return shot;
}

/** What the UI diff still lacks: a missing state per phase, or a shot from a dirty tree. */
export function uiGaps(task) {
  const ui = task.ui;
  if (!ui || ui.impact === 'none') return [];
  const gaps = [];
  for (const state of ui.applicable) {
    for (const phase of ['proposed', 'actual']) {
      if (!ui.shots.some((s) => s.state === state && s.phase === phase)) {
        gaps.push(`no ${phase} screenshot of the ${state} state`);
      }
    }
  }
  for (const shot of ui.shots.filter((s) => s.dirty)) {
    gaps.push(
      `${shot.id} (${shot.state}) was taken with uncommitted changes on ${shot.commit}`
    );
  }
  return gaps;
}

function ui(effort, { positional, flags }) {
  const [action, value] = positional;
  const key = requireTask(effort);
  const at = new Date().toISOString();
  if (action === 'none') {
    changeTaskFor(effort, (task) => {
      task.ui = { ...emptyUi('none'), applicable: [] };
    });
    return 'Recorded: None: no UI change.';
  }
  if (action === 'states') {
    const states = String(value ?? '')
      .split(',')
      .filter(Boolean);
    const unknown = states.filter((s) => !UI_STATES.includes(s));
    if (!states.length || unknown.length) {
      throw new Error(`Name states from ${UI_STATES.join(', ')}.`);
    }
    changeTaskFor(effort, (task) => {
      task.ui ??= emptyUi('user-visible');
      task.ui.applicable = states;
    });
    return `UI states to cover: ${states.join(', ')}.`;
  }
  if (action === 'deviation') {
    if (!value) {
      throw new Error('Describe how the build differs from the proposal.');
    }
    changeTaskFor(effort, (task) => {
      task.ui ??= emptyUi('user-visible');
      task.ui.deviations.push({ text: value, at });
    });
    return 'Recorded the deviation; log the decision behind it too.';
  }
  if (action === 'shot') {
    const proof = provenance(effort.co.root);
    const shot = changeTaskFor(effort, (t) =>
      addShot(t, { path: value, ...flags, ...proof, at })
    );
    const label = `${LABEL[shot.phase]}: ${shot.state}`;
    enqueue(effort.co, {
      key: `asset:${key}:${shot.id}`,
      kind: 'asset',
      task: key,
      title: `${label} (${shot.id})`,
      body: [
        `Upload ${value} to ${key} as an image and place it in the UI diff, labeled "${label}".`,
        shot.steps ? `Steps: ${shot.steps}` : '',
        shot.commit && shot.phase === 'actual'
          ? `Tested commit: ${shot.commit}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return `Recorded ${shot.id} (${label}).`;
  }
  const gaps = uiGaps(effort.task);
  return gaps.length
    ? `The UI diff still needs:\n- ${gaps.join('\n- ')}`
    : 'The UI diff covers every applicable state.';
}

export const uiCommands = { ui };
