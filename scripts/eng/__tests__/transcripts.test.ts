// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { parseTranscript } from '../../../scripts/eng/transcripts.mjs';

const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures', name), 'utf8');

/** kind and text only, which is what the session record shows. */
const shape = (events: { kind: string; text: string }[]) =>
  events.map(({ kind, text }) => [kind, text]);

const SAME_TURN = [
  ['prompt', 'Add a retry to the upload'],
  ['command', 'npm test -- upload'],
];

describe('transcript adapters', () => {
  test('Claude Code: conversation in order, metadata lines skipped', () => {
    const { events, unknown } = parseTranscript(
      'claude',
      fixture('claude.jsonl')
    );
    expect(unknown).toBe(0);
    expect(shape(events)).toEqual([
      ...SAME_TURN,
      ['output', 'error: 1 failed'],
      ['edit', '/repo/convex/upload.ts'],
      ['output', 'The file was updated.'],
      ['answer', 'Added three retries with backoff.'],
    ]);
    expect(events[0].at).toBe('2026-10-18T02:09:31.000Z');
    expect(events[2]).toMatchObject({
      ref: 'toolu_1',
      detail: '1 failed\nupload retries once',
    });
  });

  test('Codex: one prompt and answer each, shell argv unwrapped, patch files read', () => {
    const { events, unknown } = parseTranscript(
      'codex',
      fixture('codex.jsonl')
    );
    expect(unknown).toBe(0);
    expect(shape(events)).toEqual([
      ...SAME_TURN,
      ['output', 'exit 1'],
      ['edit', 'convex/upload.ts'],
      ['output', 'exit 0'],
      ['answer', 'Added three retries.'],
    ]);
    expect(events[2]).toMatchObject({
      ref: 'call_1',
      detail: 'exit 1\n1 failed',
    });
  });

  test('Cursor: content blocks without timestamps, which stay null', () => {
    const { events, unknown } = parseTranscript(
      'cursor',
      fixture('cursor.jsonl')
    );
    expect(unknown).toBe(0);
    expect(shape(events)).toEqual([
      ['prompt', 'Add a retry to the upload'],
      ['answer', 'Running the tests first.'],
      ['command', 'npm test -- upload'],
      ['edit', 'convex/upload.ts'],
      ['answer', 'Added three retries.'],
    ]);
    expect(events.every((event: { at: unknown }) => event.at === null)).toBe(
      true
    );
  });

  test('unreadable lines are counted, never filled in', () => {
    const text = [
      fixture('claude.jsonl'),
      'user: plain text from some other format',
      '{"type":"assistant"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"hologram"}]}}',
    ].join('\n');
    const { events, unknown } = parseTranscript('claude', text);
    expect(unknown).toBe(3);
    expect(events).toHaveLength(6);
    expect(
      parseTranscript('codex', '{"type":"brand_new_item","payload":{}}').unknown
    ).toBe(1);
    expect(
      parseTranscript(
        'codex',
        '{"type":"response_item","payload":{"type":"new_call"}}'
      ).unknown
    ).toBe(1);
    expect(() => parseTranscript('vim', '')).toThrow(/No transcript parser/);
  });

  test('a partial last line, as during a running session, counts as unknown', () => {
    const lines = fixture('codex.jsonl').trimEnd().split('\n');
    const cut = `${lines.slice(0, -1).join('\n')}\n${lines.at(-1)!.slice(0, 20)}`;
    expect(parseTranscript('codex', cut).unknown).toBe(1);
  });
});
