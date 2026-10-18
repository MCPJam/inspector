// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../../scripts/eng/cli.mjs';
import {
  bodyOf,
  enqueue,
  markSynced,
  pending,
} from '../../../scripts/eng/outbox.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-outbox-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  return { dir, git };
}

const record = {
  key: 'decision:PP-1:D1',
  kind: 'decision',
  task: 'PP-1',
  title: 'D1',
};

describe('outbox', () => {
  test('a retry updates the synced document instead of adding another', () => {
    const co = checkout(repo().dir);
    const item = enqueue(co, { ...record, body: 'Use a queue' });
    expect(bodyOf(item)).toBe('Use a queue\n\n<!-- eng:decision:PP-1:D1 -->\n');
    expect(pending(co, 'PP-1').map((i: { id: string }) => i.id)).toEqual([
      item.id,
    ]);

    markSynced(co, item.id, 'comment-9');
    enqueue(co, { ...record, body: 'Use a queue' });
    expect(pending(co)).toEqual([]);

    enqueue(co, { ...record, body: 'Use a queue, bounded' });
    expect(pending(co)).toMatchObject([{ id: item.id, ref: 'comment-9' }]);
    expect(() => markSynced(co, item.id, undefined)).toThrow(/--ref/);
    expect(() => markSynced(co, 'nope', 'x')).toThrow(/No queued record/);
  });

  test('queued records survive removing the worktree that queued them', () => {
    const { dir, git } = repo();
    const tree = join(dir, '.worktrees/other');
    git('worktree', 'add', '-q', '-b', 'other', tree);
    enqueue(checkout(tree), { ...record, body: 'From the worktree' });
    git('worktree', 'remove', tree);
    expect(pending(checkout(dir))).toHaveLength(1);
  });
});

describe('checkpoint sync', () => {
  test('task changes queue one checkpoint document that later updates', () => {
    const { dir } = repo();
    const eng = (...argv: string[]) => run(argv, dir);
    expect(() => eng('pending')).toThrow(/Link a Kestral task first/);
    eng('link', 'PP-1');
    expect(eng('pending')).toMatch(
      /1 record\(s\) wait.*\n\w+ {2}checkpoint {2}create {2}eng checkpoint for PP-1/
    );
    const [item] = pending(checkout(dir), 'PP-1');
    eng('synced', item.id, '--ref', 'doc-cp');
    expect(eng('pending')).toBe('Nothing waits to sync.');

    eng('doc', 'product-spec', '--ref', 'd1', '--revision', '1');
    expect(eng('pending')).toMatch(/checkpoint {2}update doc-cp/);

    // The synced body is what a fresh checkout restores from.
    const fresh = repo();
    expect(run(['restore', '--file', item.bodyPath], fresh.dir)).toMatch(
      /Restored PP-1/
    );
  });
});
