// @vitest-environment node
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { describeCounterpart, discover } from '../../../scripts/eng/repos.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';

const SOURCE = resolve(__dirname, '../../../scripts/eng/repos.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function gitRepo(path: string, remote: string) {
  mkdirSync(path, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: path, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  git('remote', 'add', 'origin', `git@github.com:${remote}.git`);
  return git;
}

/** A home folder holding a backend checkout and, optionally, the inspector. */
function machine({ inspector = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'eng-home-')));
  dirs.push(home);
  gitRepo(join(home, 'code/MCPJam/mcpjam-backend'), 'MCPJam/mcpjam-backend');
  // A fork with the right folder name is not the repository.
  gitRepo(join(home, 'code/inspector'), 'someone/inspector');
  let inspectorGit = null;
  if (inspector) {
    inspectorGit = gitRepo(join(home, 'src/inspector'), 'MCPJam/inspector');
    const tree = join(home, 'src/inspector-wt');
    inspectorGit('worktree', 'add', '-q', '-b', 'wt', tree);
  }
  const co = checkout(join(home, 'code/MCPJam/mcpjam-backend'));
  const calls: string[][] = [];
  const quiet = { encoding: 'utf8', stdio: 'pipe' } as const;
  const git = (cwd: string, args: string[]) => {
    calls.push(args);
    return execFileSync('git', args, { cwd, ...quiet }).trim();
  };
  const find = (options = {}) =>
    discover(co, { home, platform: 'linux', env: {}, git, ...options });
  return { home, co, find, calls, inspectorGit };
}

describe('counterpart discovery', () => {
  test('finds the main checkout by remote, skipping forks, and caches it', () => {
    const { home, find } = machine();
    expect(find()).toMatchObject({
      name: 'inspector',
      status: 'found',
      path: join(home, 'src/inspector'),
      source: 'search',
      branch: 'main',
    });
    expect(find({ fast: true })).toMatchObject({ source: 'cache' });
  });

  test('an explicit directory wins, resolved to its main checkout', () => {
    const { home, find } = machine();
    const env = { MCPJAM_INSPECTOR_DIR: join(home, 'src/inspector-wt') };
    expect(find({ env })).toMatchObject({
      path: join(home, 'src/inspector'),
      source: 'MCPJAM_INSPECTOR_DIR',
    });
    const wrong = find({
      env: { MCPJAM_INSPECTOR_DIR: join(home, 'code/inspector') },
    });
    expect(describeCounterpart(wrong)).toMatch(
      /unavailable \(MCPJAM_INSPECTOR_DIR=.* is not a checkout of mcpjam\/inspector\)\. Nothing was cloned/
    );
  });

  test('a stale cache falls back to the search', () => {
    const { home, find } = machine();
    find();
    rmSync(join(home, 'src'), { recursive: true, force: true });
    gitRepo(join(home, 'work/inspector'), 'MCPJam/inspector');
    expect(find()).toMatchObject({
      path: join(home, 'work/inspector'),
      source: 'search',
    });
  });

  test('Spotlight results are checked like any other candidate', () => {
    const { home, find } = machine({ inspector: false });
    gitRepo(join(home, 'deep/a/b/inspector'), 'MCPJam/inspector');
    const run = (cmd: string) =>
      cmd === 'mdfind' ? join(home, 'deep/a/b/inspector') : '';
    expect(find({ platform: 'darwin', run })).toMatchObject({
      path: join(home, 'deep/a/b/inspector'),
    });
  });

  test('a missing checkout is unavailable, and hooks only read the cache', () => {
    const { find } = machine({ inspector: false });
    expect(describeCounterpart(find({ fast: true }))).toMatch(
      /not located yet; run `node scripts\/eng\/cli\.mjs repos`/
    );
    expect(describeCounterpart(find())).toMatch(
      /unavailable \(not found on this machine\)\. Nothing was cloned\. .*set MCPJAM_INSPECTOR_DIR/
    );
  });

  test('reports divergence from the local origin/main without fetching', () => {
    const { home, find, inspectorGit } = machine();
    inspectorGit!('update-ref', 'refs/remotes/origin/main', 'HEAD');
    inspectorGit!('commit', '-q', '--allow-empty', '-m', 'local');
    expect(find()).toMatchObject({
      path: join(home, 'src/inspector'),
      behind: 0,
      ahead: 1,
    });
    expect(describeCounterpart(find())).toMatch(
      /0 behind and 1 ahead of origin\/main as of the last fetch; nothing was fetched/
    );
  });

  test('never runs a git command that changes or fetches a checkout', () => {
    const { find, calls } = machine({ inspector: false });
    find();
    find({ env: { MCPJAM_INSPECTOR_DIR: '/nowhere' } });
    const readOnly = new Set([
      'rev-parse',
      'remote',
      'symbolic-ref',
      'rev-list',
    ]);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((args) => !readOnly.has(args[0]))).toEqual([]);
    expect(
      calls
        .filter((args) => args[0] === 'remote')
        .every((args) => args[1] === 'get-url')
    ).toBe(true);
    // The module has no path to those commands at all.
    expect(readFileSync(SOURCE, 'utf8')).not.toMatch(
      /'(?:clone|fetch|pull|reset|checkout|switch)'/
    );
  });
});
