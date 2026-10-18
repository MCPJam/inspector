/**
 * Records waiting for the agent to put on Kestral: decision comments,
 * session documents, checkpoints and screenshots. Hooks cannot call
 * Kestral, so they queue here and the agent drains the queue.
 *
 * One item per key. Queuing a key again replaces its body but keeps the
 * Kestral id it was synced to, so a retry updates that document instead of
 * creating a second one. Each body ends with a marker the agent can search
 * the task for when it is unsure whether an earlier attempt landed. The
 * queue sits in the git common directory, so it survives worktree removal
 * and the next session in any worktree picks it up.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { now } from './effort.mjs';
import { hashKey, list, read, update } from './state.mjs';

export const marker = (key) => `<!-- eng:${key} -->`;

const itemName = (id) => `outbox/${id}.json`;

/** Queue `body` under `key`. Returns the item. */
export function enqueue(co, { key, kind, task, title, body }) {
  const id = hashKey(key).slice(0, 8);
  const text = `${body.trimEnd()}\n\n${marker(key)}\n`;
  const bodyPath = join(co.dir, 'outbox', `${id}.md`);
  const revision = createHash('sha256').update(text).digest('hex').slice(0, 12);
  return update(co.dir, itemName(id), (item) => {
    if (item.revision !== revision) writeFileSync(bodyPath, text);
    return {
      ...item,
      id,
      key,
      kind,
      task,
      title,
      bodyPath,
      revision,
      ref: item.ref ?? null,
      syncedRevision: item.syncedRevision ?? null,
      queuedAt: item.queuedAt ?? now(),
    };
  });
}

/** Items whose latest body is not on Kestral yet, oldest first. */
export function pending(co, task = null) {
  return list(co.dir, 'outbox')
    .map((name) => read(co.dir, name))
    .filter((item) => item.syncedRevision !== item.revision)
    .filter((item) => !task || item.task === task)
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export function markSynced(co, id, ref) {
  if (!ref) throw new Error('Pass the Kestral id it was saved as: --ref <id>.');
  if (!read(co.dir, itemName(id))) throw new Error(`No queued record ${id}.`);
  return update(co.dir, itemName(id), (item) => ({
    ...item,
    ref,
    syncedRevision: item.revision,
    syncedAt: now(),
  }));
}

export const bodyOf = (item) => readFileSync(item.bodyPath, 'utf8');

/** How to sync each item: create it, or update the document it already is. */
export function describePending(items) {
  return items.map((item) => {
    const action = item.ref ? `update ${item.ref}` : 'create';
    return `${item.id}  ${item.kind}  ${action}  ${item.title}  (${item.bodyPath})`;
  });
}
