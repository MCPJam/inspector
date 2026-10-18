// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../../scripts/eng/cli.mjs';

const ROOT = resolve(__dirname, '../../..');
const config = (path: string) =>
  JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A checkout carrying this repo's eng scripts and hook configs. */
function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-setup-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  cpSync(join(ROOT, 'scripts/eng'), join(dir, 'scripts/eng'), {
    recursive: true,
  });
  for (const file of [
    '.claude/settings.json',
    '.codex/hooks.json',
    '.cursor/hooks.json',
  ]) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    cpSync(join(ROOT, file), join(dir, file));
  }
  return dir;
}

/** Run a configured hook command the way the host would: a shell in the project. */
function runConfigured(
  dir: string,
  command: string,
  payload: object,
  env = {}
) {
  const out = spawnSync('sh', ['-c', command], {
    cwd: dir,
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: {
      ...process.env,
      CI: '',
      GITHUB_ACTIONS: '',
      CLAUDE_PROJECT_DIR: dir,
      ...env,
    },
  });
  expect(out.status).toBe(0);
  return JSON.parse(out.stdout || '{}');
}

describe('hook configs', () => {
  test('Codex wires every event to the shared hook within its limits', () => {
    const { hooks } = config('.codex/hooks.json');
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'PostToolUse',
      'Stop',
      'SessionEnd',
    ]) {
      expect(hooks[event][0].hooks[0].command).toMatch(
        /scripts\/eng\/hook\.mjs" codex$/
      );
    }
    expect(hooks.PostToolUse[0].matcher).toContain('apply_patch');
    // Codex caps SessionEnd hooks at three seconds.
    expect(hooks.SessionEnd[0].hooks[0].timeout).toBeLessThanOrEqual(3);
  });

  test('Cursor wires every event and caps stop follow-ups at one', () => {
    const { version, hooks } = config('.cursor/hooks.json');
    expect(version).toBe(1);
    for (const event of [
      'sessionStart',
      'beforeSubmitPrompt',
      'afterFileEdit',
      'postToolUse',
      'stop',
      'sessionEnd',
    ]) {
      expect(hooks[event][0].command).toMatch(
        /scripts\/eng\/hook\.mjs cursor$/
      );
    }
    expect(hooks.stop[0].loop_limit).toBe(1);
  });

  test('each configured command offers the flow in its host format', () => {
    const prompt = 'Add an export button';
    const claude = repo();
    const claudeCommand = config(
      '.claude/settings.json'
    ).hooks.UserPromptSubmit[0].hooks.at(-1).command;
    expect(
      runConfigured(claude, claudeCommand, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'a',
        cwd: claude,
        prompt,
      }).hookSpecificOutput.additionalContext
    ).toMatch(/eng flow once/);

    const codex = repo();
    const codexCommand =
      config('.codex/hooks.json').hooks.UserPromptSubmit[0].hooks[0].command;
    expect(
      runConfigured(codex, codexCommand, {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'b',
        cwd: codex,
        prompt,
      }).hookSpecificOutput.additionalContext
    ).toMatch(/eng flow once/);

    const cursor = repo();
    const cursorHooks = config('.cursor/hooks.json').hooks;
    const payload = { conversation_id: 'c', workspace_roots: [cursor] };
    runConfigured(cursor, cursorHooks.beforeSubmitPrompt[0].command, {
      ...payload,
      hook_event_name: 'beforeSubmitPrompt',
      prompt,
    });
    expect(
      runConfigured(cursor, cursorHooks.postToolUse[0].command, {
        ...payload,
        hook_event_name: 'postToolUse',
        tool_name: 'Read',
      }).additional_context
    ).toMatch(/eng flow once/);
  });

  test('the CI guard keeps hooks silent in CI', () => {
    const dir = repo();
    const command =
      config('.codex/hooks.json').hooks.UserPromptSubmit[0].hooks[0].command;
    const out = spawnSync('sh', ['-c', command], {
      cwd: dir,
      encoding: 'utf8',
      input: '{}',
      env: { ...process.env, CI: 'true' },
    });
    expect([out.status, out.stdout]).toEqual([0, '']);
  });
});

describe('eng hooks', () => {
  test('reports hosts that never ran or ran an older config', () => {
    const dir = repo();
    const status = () => run(['hooks'], dir);
    expect(status()).toMatch(
      /codex: hooks have not run in this checkout\. Codex runs them only in a trusted project/
    );
    const command =
      config('.codex/hooks.json').hooks.SessionStart[0].hooks[0].command;
    runConfigured(dir, command, {
      hook_event_name: 'SessionStart',
      session_id: 'b',
      cwd: dir,
    });
    expect(status()).toMatch(/codex: hooks running/);
    writeFileSync(join(dir, '.codex/hooks.json'), '{"hooks":{}}\n');
    expect(status()).toMatch(
      /codex: hooks last ran at .* from an older \.codex\/hooks\.json\. .*trust it again with \/hooks/
    );
    expect(status()).toMatch(/cursor: hooks have not run/);
  });
});
