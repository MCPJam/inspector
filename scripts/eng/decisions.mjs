/**
 * Decision entries, and the end-of-turn check that asks for them.
 *
 * A turn that changed source after the plan was approved should leave a
 * decision entry or an explicit "nothing material changed". The Stop hook
 * asks for that, and for syncing what the turn queued, in one continuation
 * at most per turn. It is a reminder, not a gate: a second stop always ends
 * the turn, and nothing here blocks an edit, a commit or a PR.
 */
import { now, requireTask, updateBranch, whoami } from './effort.mjs';
import { enqueue, pending } from './outbox.mjs';
import { changeTask, syncInstructions } from './sync.mjs';
import { CLI, isApproved } from './workflow.mjs';

export function recordDecision(task, fields) {
  const { what, why, alternatives, by, at, supersedes, longLived } = fields;
  if (!what || !why) throw new Error('A decision needs --what and --why.');
  task.decisions ??= [];
  const replaced = supersedes
    ? task.decisions.find((entry) => entry.id === supersedes)
    : null;
  if (supersedes && !replaced) {
    throw new Error(`No decision ${supersedes} on ${task.key} to supersede.`);
  }
  const entry = {
    id: `D${task.decisions.length + 1}`,
    what,
    why,
    alternatives: alternatives || 'None recorded',
    by,
    at,
    supersedes: supersedes ?? null,
    longLived: Boolean(longLived),
  };
  if (replaced) replaced.supersededBy = entry.id;
  task.decisions.push(entry);
  return entry;
}

/** The task comment for one entry. Reversals name what they replace. */
export function decisionComment(task, entry) {
  const replaced = task.decisions.find((d) => d.id === entry.supersedes);
  return [
    `**Decision ${entry.id}: ${entry.what}**`,
    '',
    `- Why: ${entry.why}`,
    `- Alternatives considered: ${entry.alternatives}`,
    `- Decided by: ${entry.by}, ${entry.at}`,
    replaced && `- Supersedes: ${replaced.id} (${replaced.what})`,
    entry.longLived &&
      '- Flagged as long-lived: a person decides whether to promote it to a lasting document.',
  ]
    .filter((line) => typeof line === 'string')
    .join('\n');
}

/** A counter, not a time: two reconciles in one millisecond still differ. */
const markReconciled = (co) =>
  updateBranch(co, (record) => ({
    ...record,
    reconciled: (record.reconciled ?? 0) + 1,
  }));

const queuedKeys = (co, task) =>
  pending(co, task.key).map((item) => `${item.id}:${item.revision}`);

/** What the end of the turn compares against, taken as the turn begins. */
export function turnBaseline({ co, branch, task }) {
  if (!task) return null;
  return { reconciled: branch.reconciled ?? 0, queued: queuedKeys(co, task) };
}

export const decisionCommands = {
  decision: (effort, { flags }) => {
    let entry;
    const by = flags.by ?? whoami(effort.co.root);
    const task = changeTask(effort, (t) => {
      entry = recordDecision(t, {
        what: flags.what,
        why: flags.why,
        alternatives: flags.alternatives,
        by,
        at: now(),
        supersedes: flags.supersedes,
        longLived: flags['long-lived'],
      });
      return t;
    });
    enqueue(effort.co, {
      key: `decision:${task.key}:${entry.id}`,
      kind: 'decision',
      task: task.key,
      title: `${entry.id}: ${entry.what}`,
      body: decisionComment(task, entry),
    });
    markReconciled(effort.co);
    return `Recorded ${entry.id}. Post it on ${task.key}; \`${CLI} pending\` lists it.`;
  },
  reconcile: (effort, { flags }) => {
    requireTask(effort);
    if (!flags.none) {
      throw new Error(
        `Record each material decision with \`${CLI} decision\`, or pass --none if nothing material changed.`
      );
    }
    markReconciled(effort.co);
    return 'Noted: no material decision changed this turn.';
  },
};

function reconcileText(task, files) {
  const shown = files.slice(0, 8).join(', ');
  const more = files.length > 8 ? ` and ${files.length - 8} more` : '';
  return [
    `eng: this turn changed ${files.length} file(s) under ${task.key}: ${shown}${more}.`,
    'Before you finish, reconcile them with the approved plan.',
    `Record each consequential decision with \`${CLI} decision --what "..." --why "..." --alternatives "..."\` (--supersedes D<n> to reverse one, --long-lived to flag it for a person to promote),`,
    `or run \`${CLI} reconcile --none\` if nothing material changed.`,
    `A change to approved behavior, scope or architecture reopens an approval instead: \`${CLI} reopen\`.`,
  ].join(' ');
}

/** The one continuation this turn earns, or null. Marks the turn as used. */
export function stopFollowup(event, effort, session) {
  const { task, branch, co } = effort;
  const baseline = session.turnBaseline;
  // No baseline means no turn boundary was seen (hooks enabled mid-session).
  if (!task || !baseline || event.continued) return null;
  if (session.continuedTurn === session.turn) return null;
  const asks = [];
  const reconciled = (branch.reconciled ?? 0) !== baseline.reconciled;
  if (session.turnFiles.length && isApproved(task, 'plan') && !reconciled) {
    asks.push(reconcileText(task, session.turnFiles));
  }
  const queued = pending(co, task.key);
  if (queuedKeys(co, task).some((key) => !baseline.queued.includes(key))) {
    asks.push(syncInstructions(queued));
  }
  if (!asks.length) return null;
  session.continuedTurn = session.turn;
  return { followup: asks.join('\n\n') };
}
