// @vitest-environment node
import { describe, expect, test } from 'vitest';

import { normalize, patchFiles, render } from '../../../scripts/eng/hosts.mjs';
import { isBuildPrompt, isSourceEdit } from '../../../scripts/eng/nudge.mjs';

const base = { session_id: 's1', cwd: '/repo', transcript_path: '/t.jsonl' };

describe('normalize', () => {
  test('reads Claude Code edits and stop continuations', () => {
    const edit = normalize('claude', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/repo/convex/a.ts' },
    });
    expect(edit).toMatchObject({
      kind: 'edit',
      sessionId: 's1',
      files: ['/repo/convex/a.ts'],
      transcriptPath: '/t.jsonl',
    });
    const stop = normalize('claude', {
      ...base,
      hook_event_name: 'Stop',
      stop_hook_active: true,
    });
    expect(stop).toMatchObject({ kind: 'stop', continued: true });
  });

  test('reads the files a Codex apply_patch touched', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: convex/a.ts',
      '*** Move to: convex/b.ts',
      '*** Add File: /abs/c.ts',
      '*** End Patch',
    ].join('\n');
    expect(patchFiles(patch)).toEqual([
      'convex/a.ts',
      'convex/b.ts',
      '/abs/c.ts',
    ]);
    const event = normalize('codex', {
      ...base,
      hook_event_name: 'PostToolUse',
      tool_name: 'apply_patch',
      tool_input: { command: patch },
    });
    expect(event.files).toEqual([
      '/repo/convex/a.ts',
      '/repo/convex/b.ts',
      '/abs/c.ts',
    ]);
  });

  test('reads Cursor payloads, which name things differently', () => {
    const cursor = { conversation_id: 'c1', workspace_roots: ['/ws'] };
    expect(
      normalize('cursor', {
        ...cursor,
        hook_event_name: 'afterFileEdit',
        file_path: 'src/a.ts',
      })
    ).toMatchObject({
      kind: 'edit',
      sessionId: 'c1',
      cwd: '/ws',
      files: ['/ws/src/a.ts'],
    });
    expect(
      normalize(
        'cursor',
        { ...cursor, hook_event_name: 'stop', loop_count: 1 },
        {
          CURSOR_TRANSCRIPT_PATH: '/c.jsonl',
        }
      )
    ).toMatchObject({
      kind: 'stop',
      continued: true,
      transcriptPath: '/c.jsonl',
    });
    expect(
      normalize('cursor', {
        ...cursor,
        hook_event_name: 'postToolUse',
        tool_name: 'Shell',
      })
    ).toMatchObject({ kind: 'tool', files: [] });
  });

  test('rejects an unknown host', () => {
    expect(() => normalize('vim', {})).toThrow(/Unknown host/);
  });
});

describe('render', () => {
  const event = (host: string, name: string) =>
    normalize(host, { ...base, hook_event_name: name });

  test('Claude Code and Codex read hookSpecificOutput and a stop block', () => {
    for (const host of ['claude', 'codex']) {
      expect(
        JSON.parse(render(event(host, 'UserPromptSubmit'), { context: 'hi' }))
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit',
          additionalContext: 'hi',
        },
      });
      expect(
        JSON.parse(render(event(host, 'Stop'), { followup: 'go' }))
      ).toEqual({
        decision: 'block',
        reason: 'go',
      });
      expect(render(event(host, 'Stop'), {})).toBe('');
      expect(render(event(host, 'SessionEnd'), { context: 'x' })).toBe('');
    }
  });

  test('Cursor gets valid JSON for every event and context only where it reads it', () => {
    expect(
      JSON.parse(
        render(event('cursor', 'beforeSubmitPrompt'), { context: 'x' })
      )
    ).toEqual({
      continue: true,
    });
    expect(
      JSON.parse(render(event('cursor', 'postToolUse'), { context: 'x' }))
    ).toEqual({
      additional_context: 'x',
    });
    expect(
      JSON.parse(render(event('cursor', 'stop'), { followup: 'go' }))
    ).toEqual({
      followup_message: 'go',
    });
    expect(render(event('cursor', 'afterFileEdit'), { context: 'x' })).toBe(
      '{}'
    );
  });
});

describe('nudge triggers', () => {
  test.each([
    ['Add a retry to the upload', true],
    ['can you please fix the flaky test?', true],
    ["let's refactor the billing module", true],
    ['I want you to implement the export button', true],
    ['What does the upload retry do?', false],
    ['Why is CI red?', false],
    ['Explain how to add a column', false],
    ['review this PR', false],
    ['/eng', false],
    ['# Engineering plan\n\nImplement the workflow', false],
  ])('%s → %s', (prompt, expected) => {
    expect(isBuildPrompt(prompt)).toBe(expected);
  });

  test('only source edits inside the checkout count', () => {
    expect(isSourceEdit('/repo/convex/a.ts', '/repo')).toBe(true);
    expect(isSourceEdit('/repo/notes.md', '/repo')).toBe(false);
    expect(isSourceEdit('/other/a.ts', '/repo')).toBe(false);
    expect(isSourceEdit('/repo/.git/eng/x.json', '/repo')).toBe(false);
  });
});
