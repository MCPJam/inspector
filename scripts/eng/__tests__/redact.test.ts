// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { bodyOf, enqueue } from '../../../scripts/eng/outbox.mjs';
import { redact } from '../../../scripts/eng/redact.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';

/** Built at run time so no token-shaped literal sits in the source. */
const fake = (prefix: string, body: string) => `${prefix}${body}`;

describe('redact', () => {
  test.each([
    ['Authorization: Bearer abc.def.ghi', 'Authorization: Bearer [REDACTED]'],
    [
      '"authorization": "Basic dXNlcjpwYXNz"',
      '"authorization": "Basic [REDACTED]"',
    ],
    [
      'curl -H "Proxy-Authorization: token t0ken"',
      'curl -H "Proxy-Authorization: token [REDACTED]"',
    ],
    ['Cookie: session=abc; csrf=def', 'Cookie: [REDACTED]'],
    ['set-cookie: sid=123; HttpOnly', 'set-cookie: [REDACTED]'],
    [
      'postgres://admin:hunter2@db:5432/app',
      'postgres://admin:[REDACTED]@db:5432/app',
    ],
    [
      'mongodb+srv://svc:p%40ss@cluster0.example.net',
      'mongodb+srv://svc:[REDACTED]@cluster0.example.net',
    ],
    [
      'Server=db;User Id=app;Password=pw1;',
      'Server=db;User Id=app;Password=[REDACTED];',
    ],
    ['STRIPE_WEBHOOK_SECRET=whsec123', 'STRIPE_WEBHOOK_SECRET=[REDACTED]'],
    ['export GITHUB_TOKEN="abc 123"', 'export GITHUB_TOKEN=[REDACTED]'],
    ['password: hunter2', 'password: "[REDACTED]"'],
    [
      '{"api_key": "abc", "client_secret": "def"}',
      '{"api_key": "[REDACTED]", "client_secret": "[REDACTED]"}',
    ],
    [
      'npx convex env set --token abc123',
      'npx convex env set --token [REDACTED]',
    ],
  ])('%s', (input, expected) => {
    expect(redact(input)).toBe(expected);
  });

  test('removes token formats wherever they appear in tool output', () => {
    const output = [
      `gh auth token → ${fake('gh' + 'p_', 'a'.repeat(36))}`,
      `slack ${fake('xox' + 'b-', '1111111111-aaaaaaaaaaaa')}`,
      `aws ${fake('AKIA', 'A'.repeat(16))}`,
      `anthropic ${fake('sk-' + 'ant-', 'a'.repeat(24))}`,
      `stripe ${fake('sk_' + 'live_', 'a'.repeat(24))}`,
      `google ${fake('AIza', 'a'.repeat(35))}`,
      `jwt ${fake('eyJ', 'aaaaaaaaaa.eyJaaaaaaaaaa.aaaaaaaaaaaa')}`,
      `STRIPE_KEY=${fake('sk_' + 'test_', 'a'.repeat(24))}`,
    ].join('\n');
    const clean = redact(output);
    for (const kind of [
      'github token',
      'slack token',
      'aws key id',
      'api key',
      'google key',
      'jwt',
    ]) {
      expect(clean).toContain(`[REDACTED ${kind}]`);
    }
    expect(clean).not.toMatch(
      /p_aaa|b-111|AKIAA|ant-aaa|live_aaa|test_aaa|AIzaa|eyJa/
    );
    expect(clean).toContain('STRIPE_KEY=[REDACTED stripe key]');
  });

  test('removes a private key block, even one cut off mid-output', () => {
    const pem =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(`key:\n${pem}\ndone`)).toBe(
      'key:\n[REDACTED private key]\ndone'
    );
    expect(redact('-----BEGIN RSA PRIVATE KEY-----\nMIIEow')).toBe(
      '[REDACTED private key]'
    );
  });

  test('leaves ordinary text and references to secrets readable', () => {
    for (const text of [
      'max_tokens: 1000',
      'the token budget is 5',
      'const apiKey = process.env.STRIPE_KEY;',
      'token = ${TOKEN}',
      'https://example.com/path?q=1',
      'the authorization flow redirects',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  test('the outbox redacts every body and title it queues', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-redact-')));
    try {
      execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: dir });
      const item = enqueue(checkout(dir), {
        key: 'session:x',
        kind: 'session',
        task: 'PP-1',
        title: 'ran with DB_PASSWORD=pw',
        body: 'printenv\nDB_PASSWORD=hunter2\n',
      });
      expect(item.title).toBe('ran with DB_PASSWORD=[REDACTED]');
      expect(bodyOf(item)).not.toContain('hunter2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
