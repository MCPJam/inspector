/**
 * The CLI side of the outbox: list what waits for Kestral, mark it saved,
 * and queue the workflow checkpoint whenever the task record changes.
 */
import { requireTask, updateTask } from './effort.mjs';
import { describePending, enqueue, markSynced, pending } from './outbox.mjs';
import { CLI } from './workflow.mjs';

/** The checkpoint lives in one Kestral document per task, updated in place. */
export function queueCheckpoint(co, task) {
  const saved = { kind: 'eng-checkpoint', version: 1, task };
  return enqueue(co, {
    key: `checkpoint:${task.key}`,
    kind: 'checkpoint',
    task: task.key,
    title: `eng checkpoint for ${task.key}`,
    body: ['```json', JSON.stringify(saved, null, 2), '```'].join('\n'),
  });
}

/** Change the linked task and queue its checkpoint for Kestral. */
export function changeTask(effort, change) {
  const task = updateTask(effort.co, requireTask(effort), change);
  queueCheckpoint(effort.co, task);
  return task;
}

export function syncInstructions(items) {
  if (!items.length) return null;
  return [
    `${items.length} record(s) wait to go to Kestral:`,
    ...describePending(items),
    `Save each with your Kestral connector: "create" as a new comment or document on its task, "update" on the one named. If an earlier attempt may have landed, search the task for the eng marker at the end of the body first. Then run \`${CLI} synced <id> --ref <kestral id>\`.`,
    'If Kestral is unavailable, tell the engineer; the records stay queued for the next session.',
  ].join('\n');
}

export const syncCommands = {
  pending: (effort, { flags }) => {
    const items = pending(effort.co, flags.all ? null : requireTask(effort));
    return syncInstructions(items) ?? 'Nothing waits to sync.';
  },
  synced: (effort, { positional, flags }) => {
    const item = markSynced(effort.co, positional[0], flags.ref);
    return `${item.title} is saved as ${item.ref}.`;
  },
};
