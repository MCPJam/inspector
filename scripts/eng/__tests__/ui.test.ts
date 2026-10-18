// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { bodyOf, pending } from '../../../scripts/eng/outbox.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';
import { building } from './helpers';

describe('UI diff ledger', () => {
  test('labels shots by phase, ties actual ones to a commit and their steps', () => {
    const { dir, eng, head } = building();
    expect(() =>
      eng('ui', 'shot', 'a.png', '--phase', 'actual', '--state', 'default')
    ).toThrow(/needs --steps/);
    expect(() =>
      eng('ui', 'shot', 'a.png', '--phase', 'final', '--state', 'default')
    ).toThrow(/--phase is one of/);
    eng('ui', 'states', 'default,error');
    eng('ui', 'shot', 'p.png', '--phase', 'proposed', '--state', 'default');
    eng(
      'ui',
      'shot',
      'a.png',
      '--phase',
      'actual',
      '--state',
      'default',
      '--steps',
      'Open Uploads'
    );
    const assets = pending(checkout(dir), 'PP-4').filter(
      (i: { kind: string }) => i.kind === 'asset'
    );
    expect(assets.map((i: { title: string }) => i.title)).toEqual([
      'Proposed: default (U1)',
      'Actual: default (U2)',
    ]);
    expect(bodyOf(assets[1])).toMatch(
      `Steps: Open Uploads\nTested commit: ${head}`
    );
    expect(eng('ui')).toBe(
      'The UI diff still needs:\n- no proposed screenshot of the error state\n- no actual screenshot of the error state'
    );
  });

  test('flags an actual shot taken from uncommitted changes; no UI change needs nothing', () => {
    const { dir, eng } = building();
    writeFileSync(join(dir, 'wip.ts'), 'x');
    eng('ui', 'shot', 'p.png', '--phase', 'proposed', '--state', 'default');
    eng(
      'ui',
      'shot',
      'a.png',
      '--phase',
      'actual',
      '--state',
      'default',
      '--steps',
      'Open it'
    );
    expect(eng('ui')).toMatch(
      /U2 \(default\) was taken with uncommitted changes/
    );
    expect(eng('ui', 'none')).toBe('Recorded: None: no UI change.');
    expect(eng('ui')).toBe('The UI diff covers every applicable state.');
  });
});
