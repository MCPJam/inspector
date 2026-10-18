// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../../scripts/eng/cli.mjs';

const ROOT = resolve(__dirname, '../../..');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A checkout using this repo's git hooks, so commits go through commit-msg. */
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-trailer-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Pat');
  cpSync(join(ROOT, 'scripts/eng'), join(dir, 'scripts/eng'), {
    recursive: true,
  });
  cpSync(
    join(ROOT, 'scripts/git-hooks/commit-msg'),
    join(dir, 'hooks/commit-msg')
  );
  git('config', 'core.hooksPath', 'hooks');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const commit = (file: string, ...message: string[]) => {
    writeFileSync(join(dir, file), `${file}\n`);
    git('add', file);
    git('commit', '-q', ...message.flatMap((m) => ['-m', m]));
    return git('log', '-1', '--format=%B');
  };
  return { dir, git, commit, eng: (...argv: string[]) => run(argv, dir) };
}

describe('Kestral trailers', () => {
  test('commits on a linked branch carry one trailer beside existing ones', () => {
    const { git, commit, eng } = repo();
    expect(commit('a.txt', 'before linking')).not.toMatch(/Kestral:/);
    eng('link', 'PP-5');
    expect(
      commit('b.txt', 'add b', 'Co-Authored-By: Sam <sam@example.com>')
    ).toBe('add b\n\nCo-Authored-By: Sam <sam@example.com>\nKestral: PP-5');
    git('commit', '-q', '--amend', '--no-edit');
    expect(git('log', '-1', '--format=%B').match(/Kestral:/g)).toHaveLength(1);
  });

  test('a commit is never refused when the trailer cannot be added', () => {
    const { dir, git, commit, eng } = repo();
    eng('link', 'PP-5');
    rmSync(join(dir, 'scripts/eng/state.mjs'));
    expect(commit('c.txt', 'still commits')).toBe('still commits');
    expect(git('log', '-1', '--format=%s')).toBe('still commits');
  });

  test('a checkout with no record recovers the task from its commits', () => {
    const { dir, commit, eng } = repo();
    eng('link', 'PP-5');
    commit('b.txt', 'add b');
    rmSync(join(dir, '.git/eng'), { recursive: true, force: true });
    expect(eng('status')).toMatch(
      /Commits on this branch name Kestral task PP-5, .*restore/
    );
    const start = spawnSync(
      'node',
      [join(ROOT, 'scripts/eng/hook.mjs'), 'claude'],
      {
        encoding: 'utf8',
        input: JSON.stringify({
          hook_event_name: 'SessionStart',
          session_id: 's',
          cwd: dir,
        }),
      }
    );
    expect(
      JSON.parse(start.stdout).hookSpecificOutput.additionalContext
    ).toMatch(/^eng: Commits on this branch name Kestral task PP-5/);
  });
});

describe('eng why', () => {
  test('follows a line to its commit, task and recorded decisions', () => {
    const { dir, commit, eng } = repo();
    commit('plain.txt', 'no task here');
    eng('link', 'PP-5', '--url', 'https://app.kestral.ai/w/task/PP-5');
    eng('decision', '--what', 'Store b', '--why', 'Needed by c');
    commit('b.txt', 'add b');
    expect(eng('why', 'b.txt:1')).toMatch(
      /^b\.txt:1 last changed in \w{9} "add b" \(Pat, [\d-]+\), on Kestral task PP-5 \(https:\/\/app\.kestral\.ai\/w\/task\/PP-5\)\.\nDecisions recorded locally: D1 Store b\./
    );
    expect(eng('why', 'plain.txt:1')).toMatch(
      /has no Kestral trailer, so no task records why/
    );
    writeFileSync(join(dir, 'b.txt'), 'changed\n');
    expect(eng('why', 'b.txt:1')).toBe('b.txt:1 is not committed yet.');
    expect(() => eng('why', 'b.txt')).toThrow(/<file>:<line>/);
  });
});
