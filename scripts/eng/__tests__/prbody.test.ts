// @vitest-environment node
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

import { reviewed } from './helpers';

/** pr-body reads the checkout's own template; give the test repo this one. */
function withTemplate(dir: string) {
  mkdirSync(join(dir, '.github'));
  const template = '.github/pull_request_template.md';
  cpSync(resolve(__dirname, '../../..', template), join(dir, template));
}

describe('PR body', () => {
  const fields = {
    'user-story':
      '**As an** engineer,\n**I want** retries,\n**so that** uploads survive blips.',
    'what-this-does': 'Retries uploads.',
    documentation: 'Nothing applicable',
    architecture: 'None: no new component or flow',
    deleted: 'Nothing',
    reused: 'Nothing applicable',
    'production-signal': 'None: not user-facing',
  };

  test('fills every section of the repository template and links the review page first', () => {
    const { dir, eng } = reviewed();
    eng('ui', 'none');
    writeFileSync(join(dir, 'fields.json'), JSON.stringify(fields));
    withTemplate(dir);
    const body = eng(
      'pr-body',
      '--review-url',
      'https://app.kestral.ai/w/doc/R1',
      '--fields',
      join(dir, 'fields.json')
    );
    expect(body.split('\n')[0]).toBe(
      '**Review page:** https://app.kestral.ai/w/doc/R1'
    );
    expect(body).not.toContain('<!--');
    expect(body).toMatch(
      /- \*\*Kestral task:\*\* PP-6\n- \*\*Spec:\*\* product spec p \(revision 1\) and engineering spec e \(revision 1\), approved by Pat/
    );
    expect(body).toMatch(
      /### Acceptance criteria\n\n- \[x\] Upload retries three times\n- \[ \] Works offline \(unverified: No offline harness\)/
    );
    // This template has no Verification section, so none is invented.
    expect(body).not.toMatch(/## Verification/);
    expect(body).toMatch(
      /## Documentation\n\nNothing applicable\n\n## Architecture/
    );
    expect(body).toMatch(
      /## Screenshots and recordings\n\nNone: no UI change\n\n## Deleted/
    );
    expect(body).toMatch(/## Checklist\n\n- \[ \] I can explain every line/);
  });

  test('refuses to leave a section empty, and needs the review page', () => {
    const { dir, eng } = reviewed();
    const { deleted: _deleted, ...partial } = fields;
    writeFileSync(join(dir, 'fields.json'), JSON.stringify(partial));
    withTemplate(dir);
    expect(() => eng('pr-body', '--fields', join(dir, 'fields.json'))).toThrow(
      /Save the review page first/
    );
    expect(() =>
      eng('pr-body', '--review-url', 'u', '--fields', join(dir, 'fields.json'))
    ).toThrow(
      /sections with no value: screenshots-and-recordings, deleted\./
    );
  });
});
