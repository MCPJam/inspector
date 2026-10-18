// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../../scripts/eng/cli.mjs';

const ROOT = resolve(__dirname, '../../..');
const HOOK = join(ROOT, 'scripts/eng/hook.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-hook-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const hook = (host: string, payload: Record<string, unknown>) => {
    const out = spawnSync('node', [HOOK, host], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's1', cwd: dir, ...payload }),
    });
    expect(out.status).toBe(0);
    return out.stdout;
  };
  const context = (stdout: string) =>
    stdout
      ? JSON.parse(stdout).hookSpecificOutput?.additionalContext
      : undefined;
  return { dir, git, hook, context };
}

const prompt = (text: string) => ({
  hook_event_name: 'UserPromptSubmit',
  prompt: text,
});
const edit = (file: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: file },
});

describe('offer', () => {
  test('fires once per branch, across both triggers and sessions', () => {
    const { dir, git, hook, context } = repo();
    expect(context(hook('claude', prompt('Why is CI red?')))).toBeUndefined();
    expect(context(hook('claude', prompt('Add a retry to uploads')))).toMatch(
      /Offer the engineer the eng flow once/
    );
    expect(
      context(hook('claude', prompt('Add another thing')))
    ).toBeUndefined();
    expect(
      context(hook('codex', { ...edit(join(dir, 'a.ts')), session_id: 's2' }))
    ).toBeUndefined();
    git('checkout', '-q', '-b', 'next');
    expect(context(hook('claude', edit(join(dir, 'a.ts'))))).toMatch(
      /first source edit/
    );
  });

  test('a decline silences both triggers; docs edits never trigger', () => {
    const { dir, hook, context } = repo();
    expect(
      context(hook('claude', edit(join(dir, 'notes.md'))))
    ).toBeUndefined();
    run(['decline'], dir);
    expect(context(hook('claude', prompt('Fix the bug')))).toBeUndefined();
    expect(context(hook('claude', edit(join(dir, 'a.ts'))))).toBeUndefined();
  });

  test('Cursor gets the offer on the next event that can carry it', () => {
    const { dir, hook } = repo();
    const cursor = { conversation_id: 'c1', workspace_roots: [dir] };
    const submit = hook('cursor', {
      ...cursor,
      hook_event_name: 'beforeSubmitPrompt',
      prompt: 'Implement the export',
    });
    expect(JSON.parse(submit)).toEqual({ continue: true });
    const tool = hook('cursor', {
      ...cursor,
      hook_event_name: 'postToolUse',
      tool_name: 'Read',
    });
    expect(JSON.parse(tool).additional_context).toMatch(/eng flow once/);
    const again = hook('cursor', {
      ...cursor,
      hook_event_name: 'postToolUse',
      tool_name: 'Read',
    });
    expect(JSON.parse(again)).toEqual({});
  });
});

describe('resume and failure', () => {
  test('session start resumes a linked effort', () => {
    const { dir, hook, context } = repo();
    run(['link', 'PP-9', '--url', 'https://app.kestral.ai/w/task/PP-9'], dir);
    expect(
      context(hook('claude', { hook_event_name: 'SessionStart' }))
    ).toMatch(/feature is on Kestral task PP-9 .*stage specs\. Next: Draft/);
  });

  test('bad input exits 0, and Cursor still gets JSON', () => {
    const bad = spawnSync('node', [HOOK, 'cursor'], {
      encoding: 'utf8',
      input: '{',
    });
    expect([bad.status, bad.stdout]).toEqual([0, '{}']);
    const outside = spawnSync('node', [HOOK, 'claude'], {
      encoding: 'utf8',
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: tmpdir() }),
    });
    expect([outside.status, outside.stdout]).toEqual([0, '']);
  });
});

describe('Claude Code settings', () => {
  test('add the eng hook beside the existing slop hooks', () => {
    const { hooks } = JSON.parse(
      readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')
    );
    const commands = (event: string) =>
      hooks[event].flatMap((group: { hooks: { command: string }[] }) =>
        group.hooks.map((h) => h.command)
      );
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]) {
      expect(
        commands(event).some((c: string) =>
          c.endsWith('scripts/eng/hook.mjs" claude')
        )
      ).toBe(true);
    }
    expect(
      commands('Stop').some((c: string) => c.includes('scripts/slop/hook.mjs'))
    ).toBe(true);
  });
});
