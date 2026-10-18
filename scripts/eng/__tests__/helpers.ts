import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

import { run } from '../../../scripts/eng/cli.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A committed checkout on `feature`, removed after the test. */
export function tempRepo(prefix = 'eng-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Pat');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const eng = (...argv: string[]) => run(argv, dir);
  return { dir, git, eng };
}

/** A checkout whose effort `key` has approved specs and an approved plan. */
export function building(key = 'PP-4') {
  const repo = tempRepo('eng-build-');
  const { eng } = repo;
  eng('link', key);
  eng('doc', 'product-spec', '--ref', 'p', '--revision', '1');
  eng('doc', 'engineering-spec', '--ref', 'e', '--revision', '1');
  eng('approve', 'specs');
  eng('doc', 'plan', '--ref', 'plan', '--revision', '1');
  eng('review', '--none');
  eng('approve', 'plan');
  const status = () => JSON.parse(eng('status', '--json'));
  return { ...repo, status, head: repo.git('rev-parse', '--short', 'HEAD') };
}
