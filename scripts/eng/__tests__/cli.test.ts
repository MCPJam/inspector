// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { parseArgs, run } from '../../../scripts/eng/cli.mjs';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo(branch = 'feature') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-cli-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', branch);
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Pat Engineer');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const eng = (...argv: string[]) => run(argv, dir);
  const status = () => JSON.parse(eng('status', '--json'));
  return { dir, git, eng, status };
}

function file(dir: string, name: string, value: unknown) {
  const path = join(dir, name);
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value)
  );
  return path;
}

describe('eng CLI', () => {
  test('parses positionals, valued flags and bare flags', () => {
    expect(parseArgs(['plan', '--by', 'Pat', '--none'])).toEqual({
      positional: ['plan'],
      flags: { by: 'Pat', none: true },
    });
  });

  test('walks an effort from link to an approved plan', () => {
    const { dir, eng, status } = repo();
    expect(status()).toMatchObject({ task: null, offer: 'not offered' });
    expect(() => eng('approve', 'specs')).toThrow(/Link a Kestral task first/);
    expect(() => eng('link', 'not-a-key')).toThrow(/not a Kestral task key/);

    eng('link', 'PP-7', '--url', 'https://app.kestral.ai/w/task/PP-7');
    eng('doc', 'product-spec', '--ref', 'd1', '--revision', '3');
    eng(
      'doc',
      'engineering-spec',
      '--ref',
      'd2',
      '--file',
      file(dir, 'e.md', 'spec')
    );
    expect(eng('approve', 'specs')).toMatch(/approved by Pat Engineer/);

    eng('doc', 'plan', '--ref', 'd3', '--revision', 'v1');
    expect(() => eng('approve', 'plan')).toThrow(/plan review/);
    const findings = [{ text: 'No rollback', disposition: 'accepted' }];
    eng('review', '--file', file(dir, 'f.json', findings));
    eng('doc', 'plan', '--ref', 'd3', '--revision', 'v2');
    eng('approve', 'plan', '--by', 'Sam Lead');
    expect(status()).toMatchObject({ task: 'PP-7', stage: 'build' });

    eng('reopen', 'plan', '--reason', 'New endpoint needed');
    expect(status().stage).toBe('plan');
  });

  test('decline keeps the flow off for the branch only', () => {
    const { git, eng, status } = repo();
    expect(eng('decline')).toMatch(/stays off for feature/);
    expect(status().offer).toBe('declined');
    git('checkout', '-q', '-b', 'other');
    expect(status().offer).toBe('not offered');
  });

  test('stacked branches share one task', () => {
    const { git, eng, status } = repo();
    eng('link', 'PP-7');
    eng('doc', 'product-spec', '--ref', 'd1', '--revision', '1');
    git('checkout', '-q', '-b', 'feature-2');
    eng('link', 'PP-7');
    expect(JSON.parse(eng('checkpoint')).task).toMatchObject({
      docs: { 'product-spec': { revision: '1' } },
      branches: [
        { repo: expect.any(String), branch: 'feature' },
        { repo: expect.any(String), branch: 'feature-2' },
      ],
    });
    expect(status().task).toBe('PP-7');
  });

  test('a checkpoint restores the effort in a fresh checkout', () => {
    const first = repo();
    first.eng('link', 'PP-7');
    first.eng('doc', 'product-spec', '--ref', 'd1', '--revision', '1');
    first.eng('doc', 'engineering-spec', '--ref', 'd2', '--revision', '1');
    first.eng('approve', 'specs');
    const saved = file(first.dir, 'cp.json', first.eng('checkpoint'));

    const second = repo();
    expect(second.eng('restore', '--file', saved)).toMatch(/Restored PP-7/);
    expect(second.status()).toMatchObject({ task: 'PP-7', stage: 'plan' });

    second.eng('reopen', 'specs', '--reason', 'Scope changed');
    expect(() => second.eng('restore', '--file', saved)).toThrow(/newer/);
    second.eng('restore', '--file', saved, '--force');
    expect(second.status().stage).toBe('plan');
  });

  test('rejects an unknown command with the list of commands', () => {
    expect(() => repo().eng('ship')).toThrow(/Unknown command "ship"/);
  });
});
