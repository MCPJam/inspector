// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import {
  captureSession,
  checkpoint,
  readLog,
} from '../../../scripts/eng/capture.mjs';
import { run } from '../../../scripts/eng/cli.mjs';
import { bodyOf, pending } from '../../../scripts/eng/outbox.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';

const HOOK = resolve(__dirname, '../../../scripts/eng/hook.mjs');
const FIXTURE = readFileSync(join(__dirname, 'fixtures/claude.jsonl'), 'utf8');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function repo() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-capture-')));
  dirs.push(dir);
  execFileSync('git', ['init', '-q', '-b', 'feature'], { cwd: dir });
  const transcript = join(dir, '.git/transcript.jsonl');
  const session = {
    host: 'claude',
    sessionId: 'abcdef123456',
    branch: 'feature',
    repo: 'r',
    startedAt: '2026-01-01',
    transcriptPath: transcript,
  } as Record<string, unknown>;
  return { dir, co: checkout(dir), transcript, session };
}

const task = { key: 'PP-8', decisions: [] };

describe('checkpoint', () => {
  test('reads only complete new lines, so an interrupted session keeps what it had', () => {
    const { co, transcript, session } = repo();
    const lines = FIXTURE.split('\n');
    writeFileSync(
      transcript,
      `${lines.slice(0, 4).join('\n')}\n${lines[4].slice(0, 30)}`
    );
    expect(checkpoint(co, session)).toMatchObject({
      status: 'complete',
      events: 2,
    });
    appendFileSync(
      transcript,
      `${lines[4].slice(30)}\n${lines.slice(5).join('\n')}`
    );
    expect(checkpoint(co, session)).toMatchObject({
      status: 'complete',
      events: 6,
      unknown: 0,
    });
    expect(readLog(co, session).map((e: { kind: string }) => e.kind)).toEqual([
      'prompt',
      'command',
      'output',
      'edit',
      'output',
      'answer',
    ]);
  });

  test('redacts before anything is written to the log', () => {
    const { co, transcript, session } = repo();
    writeFileSync(
      transcript,
      FIXTURE.replace('npm test -- upload', 'DB_PASSWORD=hunter2 npm test')
    );
    checkpoint(co, session);
    expect(JSON.stringify(readLog(co, session))).not.toContain('hunter2');
  });

  test('a rewritten transcript is read again from the start, and says so', () => {
    const { co, transcript, session } = repo();
    writeFileSync(transcript, FIXTURE);
    checkpoint(co, session);
    writeFileSync(transcript, `${FIXTURE.split('\n')[1]}\n`);
    expect(checkpoint(co, session)).toMatchObject({
      events: 1,
      note: expect.stringMatching(/rewrote its transcript/),
    });
  });
});

describe('queued session record', () => {
  test('a long session splits into parts that update in place', () => {
    const { co, transcript, session } = repo();
    const prompt = (n: number) =>
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: `step ${n}` },
        timestamp: `2026-10-18T02:00:00.${String(n).padStart(3, '0')}Z`,
      });
    writeFileSync(
      transcript,
      `${Array.from({ length: 450 }, (_, n) => prompt(n)).join('\n')}\n`
    );
    captureSession(co, session, task, '2026-12-01');
    captureSession(co, session, task, '2026-12-01');
    const titles = pending(co, 'PP-8').map((i: { title: string }) => i.title);
    expect(titles).toEqual([
      'Session record: claude abcdef12 (part 1 of 2)',
      'Session record: claude abcdef12 (part 2 of 2)',
    ]);
  });
});

describe('hooks', () => {
  test('Stop and SessionEnd checkpoint the session without asking to sync it', () => {
    const { dir, transcript } = repo();
    writeFileSync(transcript, FIXTURE);
    run(['link', 'PP-8'], dir);
    const hook = (payload: object) =>
      spawnSync('node', [HOOK, 'claude'], {
        encoding: 'utf8',
        input: JSON.stringify({
          session_id: 's9',
          cwd: dir,
          transcript_path: transcript,
          ...payload,
        }),
      });
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'status?' });
    expect(hook({ hook_event_name: 'Stop' }).stdout).toBe('');
    hook({ hook_event_name: 'SessionEnd' });
    const record = pending(checkout(dir), 'PP-8').find(
      (i: { kind: string }) => i.kind === 'session'
    );
    expect(bodyOf(record)).toMatch(
      /Session record: Claude Code session s9[\s\S]*Capture: complete/
    );
  });
});
