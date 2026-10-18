// @vitest-environment node
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  branchRecord,
  checkout,
  list,
  read,
  taskRecord,
  update,
} from '../../../scripts/eng/state.mjs';

const STATE = resolve(__dirname, '../../../scripts/eng/state.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo({ origin = true } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-state-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  if (origin)
    git('remote', 'add', 'origin', 'git@github.com:MCPJam/mcpjam-backend.git');
  return { dir, git };
}

describe('checkout', () => {
  test('worktrees share one state directory and keep their own branch', () => {
    const { dir, git } = repo();
    const tree = join(dir, '.worktrees/feature');
    git('worktree', 'add', '-q', '-b', 'feature', tree);
    const main = checkout(dir);
    const other = checkout(tree);
    expect(other.dir).toBe(main.dir);
    expect(main.dir).toBe(join(dir, '.git/eng'));
    expect([main.branch, other.branch]).toEqual(['main', 'feature']);
    expect(main.repo).toBe('mcpjam/mcpjam-backend');
    // Branch records are per repository and branch.
    expect(branchRecord(main.repo, 'main')).not.toBe(
      branchRecord(main.repo, 'feature')
    );
  });

  test('records outlive the worktree that wrote them', () => {
    const { dir, git } = repo();
    const tree = join(dir, '.worktrees/feature');
    git('worktree', 'add', '-q', '-b', 'feature', tree);
    const { dir: state, repo: id } = checkout(tree);
    update(state, branchRecord(id, 'feature'), (record) => ({
      ...record,
      task: 'PP-1',
    }));
    git('worktree', 'remove', tree);
    expect(read(checkout(dir).dir, branchRecord(id, 'feature'))).toEqual({
      task: 'PP-1',
    });
  });

  test('worktrees without an origin share one repository id', () => {
    const { dir, git } = repo({ origin: false });
    const tree = join(dir, '.worktrees/feature');
    git('worktree', 'add', '-q', '-b', 'feature', tree);
    expect(checkout(tree).repo).toBe(basename(dir).toLowerCase());
    expect(checkout(dir).repo).toBe(checkout(tree).repo);
  });

  test('distinct task keys get distinct records', () => {
    expect(taskRecord('PP-6')).toBe('tasks/PP-6.json');
    expect(taskRecord('PP/1')).not.toBe(taskRecord('PP_1'));
  });

  test('is null outside git and has no branch when detached', () => {
    expect(
      checkout(realpathSync(mkdtempSync(join(tmpdir(), 'eng-none-'))))
    ).toBeNull();
    const { dir, git } = repo();
    git('checkout', '-q', '--detach');
    expect(checkout(dir).branch).toBeNull();
  });
});

describe('update', () => {
  test('concurrent writers from separate processes all land', async () => {
    const { dir } = repo();
    const state = checkout(dir).dir;
    const writer = `
      import { update } from ${JSON.stringify(STATE)};
      for (let i = 0; i < 20; i++) {
        update(process.argv[1], 'tasks/PP-1.json', (task) => ({ count: (task.count ?? 0) + 1 }));
      }`;
    await Promise.all(
      Array.from(
        { length: 4 },
        () =>
          new Promise((done, fail) => {
            const child = spawn('node', [
              '--input-type=module',
              '-e',
              writer,
              state,
            ]);
            child.on('exit', (code) => (code === 0 ? done(code) : fail(code)));
          })
      )
    );
    expect(read(state, 'tasks/PP-1.json')).toEqual({ count: 80 });
    expect(list(state, 'tasks')).toEqual(['tasks/PP-1.json']);
  });

  /** A lock on tasks/PP-1.json held by `pid` since a minute ago. */
  function heldLock(state: string, pid: number) {
    const lockDir = join(state, 'tasks/PP-1.json.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, 'owner'), `${hostname()} ${pid}`);
    const minuteAgo = new Date(Date.now() - 60_000);
    utimesSync(lockDir, minuteAgo, minuteAgo);
  }

  test('takes over a lock whose holder exited', () => {
    const { dir } = repo();
    const state = checkout(dir).dir;
    heldLock(state, spawnSync('node', ['-e', '']).pid as number);
    update(state, 'tasks/PP-1.json', () => ({ count: 1 }));
    expect(read(state, 'tasks/PP-1.json')).toEqual({ count: 1 });
  });

  test('never takes over a lock whose holder is still running', () => {
    const { dir } = repo();
    const state = checkout(dir).dir;
    heldLock(state, process.pid);
    expect(() => update(state, 'tasks/PP-1.json', () => ({}))).toThrow(
      /State is locked/
    );
  }, 15_000);
});
