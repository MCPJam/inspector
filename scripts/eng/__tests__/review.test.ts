// @vitest-environment node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { pending } from '../../../scripts/eng/outbox.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';
import { building, reviewed } from './helpers';

describe('review page', () => {
  test('covers specs, decisions, plan versus actual, evidence, risks and gaps', () => {
    const { dir, eng, head } = reviewed();
    writeFileSync(join(dir, 'notes.md'), '- Step 1 built as planned.\n');
    const page = eng(
      'review-page',
      '--notes',
      join(dir, 'notes.md'),
      '--risk',
      'SSE through proxies is untested'
    );
    expect(page).toMatch(
      /^# Review: PP-6\n\nTask: PP-6 · Branches: eng-build-\w+:feature/
    );
    expect(page).toMatch(
      /- Product spec: p \(revision 1, approved by Pat on [\d-]+\)/
    );
    expect(page).toMatch(/- Fresh-agent plan review: 0 finding\(s\)/);
    expect(page).toMatch(
      /specs approved by Pat[\s\S]*D1 Poll every 5s: Simple \(Pat\), superseded by D2[\s\S]*D2 Push over SSE: Polling lagged \(Pat\), supersedes D1; flagged long-lived/
    );
    expect(page).toMatch(
      /1 file\(s\) changed against origin\/main\.\n- 1 standing decision\(s\)[\s\S]*- Step 1 built as planned\./
    );
    expect(page).toMatch(
      new RegExp(
        `\\| S1 Upload retries three times \\| passed \\| vitest upload: 4 passed \\| ${head}, 1 commit\\(s\\) before HEAD \\|`
      )
    );
    expect(page).toMatch(
      /\| S2 Works offline \| unverified \| No offline harness \| - \|/
    );
    expect(page).toMatch(
      /## Unresolved risks\n- SSE through proxies is untested\n- S2 is unverified: No offline harness\n- UI diff: no proposed screenshot of the default state/
    );
    expect(page).toMatch(
      /## Not synchronized or not captured\n- Not on Kestral yet: checkpoint/
    );
    expect(
      pending(checkout(dir), 'PP-6').some(
        (i: { kind: string }) => i.kind === 'review'
      )
    ).toBe(true);
  });

  test('says when it cannot compare with the base', () => {
    const { eng } = building('PP-6');
    expect(eng('review-page', '--base', 'nowhere')).toMatch(
      /could not compare with nowhere; pass --base <branch below>/
    );
  });
});
