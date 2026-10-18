// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { building } from './helpers';

describe('acceptance evidence', () => {
  test('a result needs evidence and records the commit it was verified at', () => {
    const { dir, eng, status, head } = building();
    expect(eng('scenario', 'list')).toMatch(/No scenarios yet/);
    eng('scenario', 'add', 'Upload', 'retries', 'three', 'times');
    eng('scenario', 'add', 'A fourth failure shows an error');
    expect(() => eng('scenario', 'S1', 'passed')).toThrow(/needs --evidence/);
    expect(() => eng('scenario', 'S9', 'passed', '--evidence', 'x')).toThrow(
      /No scenario S9/
    );
    expect(
      eng(
        'scenario',
        'S1',
        'passed',
        '--evidence',
        'vitest upload.test.ts: 4 passed'
      )
    ).toBe(`S1 is passed at ${head}.`);
    writeFileSync(join(dir, 'wip.ts'), 'x');
    expect(
      eng('scenario', 'S2', 'failed', '--evidence', 'screenshot U1')
    ).toMatch(/uncommitted changes/);
    expect(eng('scenario', 'list')).toBe(
      `S1 passed: Upload retries three times (evidence: vitest upload.test.ts: 4 passed at ${head})\nS2 failed: A fourth failure shows an error (evidence: screenshot U1 at ${head})`
    );
    expect(status()).toMatchObject({
      stage: 'build',
      next: expect.stringMatching(/^Scenario S2 failed: fix the build/),
    });
  });

  test('review waits until every scenario passed or is unverified on purpose', () => {
    const { eng, status } = building();
    expect(status().stage).toBe('build');
    eng('scenario', 'add', 'Upload retries');
    eng('scenario', 'add', 'Works offline');
    eng('scenario', 'S1', 'passed', '--evidence', 'test run');
    expect(status().stage).toBe('build');
    eng('scenario', 'S2', 'unverified', '--note', 'No offline harness yet');
    expect(status()).toMatchObject({
      stage: 'review',
      next: expect.stringMatching(/Review package/),
    });
  });
});
