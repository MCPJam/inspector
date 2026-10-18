// @vitest-environment node
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { run } from '../../../scripts/eng/cli.mjs';
import {
  decisionComment,
  recordDecision,
} from '../../../scripts/eng/decisions.mjs';
import { pending } from '../../../scripts/eng/outbox.mjs';
import { checkout } from '../../../scripts/eng/state.mjs';
import { newTask } from '../../../scripts/eng/workflow.mjs';

const HOOK = resolve(__dirname, '../../../scripts/eng/hook.mjs');
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A checkout whose effort has an approved plan, ready to build. */
function building() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'eng-decide-')));
  dirs.push(dir);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'feature');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Pat');
  git('commit', '-q', '--allow-empty', '-m', 'base');
  const eng = (...argv: string[]) => run(argv, dir);
  eng('link', 'PP-3');
  eng('doc', 'product-spec', '--ref', 'p', '--revision', '1');
  eng('doc', 'engineering-spec', '--ref', 'e', '--revision', '1');
  eng('approve', 'specs');
  eng('doc', 'plan', '--ref', 'plan', '--revision', '1');
  eng('review', '--none');
  eng('approve', 'plan');
  const co = checkout(dir);
  for (const item of pending(co)) eng('synced', item.id, '--ref', 'cp');
  const hook = (payload: Record<string, unknown>) => {
    const out = spawnSync('node', [HOOK, 'claude'], {
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's', cwd: dir, ...payload }),
    });
    return out.stdout ? JSON.parse(out.stdout) : {};
  };
  const turn = (files: string[]) => {
    hook({ hook_event_name: 'UserPromptSubmit', prompt: 'go on' });
    for (const file of files) {
      hook({
        hook_event_name: 'PostToolUse',
        tool_name: 'Write',
        tool_input: { file_path: join(dir, file) },
      });
    }
  };
  const stop = (active = false) =>
    hook({ hook_event_name: 'Stop', stop_hook_active: active });
  return { dir, eng, turn, stop, co };
}

describe('decision entries', () => {
  test('need what and why; reversals and long-lived flags show in the comment', () => {
    const task = newTask('PP-3');
    const at = 'now';
    expect(() => recordDecision(task, { what: 'x', by: 'Pat', at })).toThrow(
      /--why/
    );
    recordDecision(task, { what: 'Poll', why: 'Simple', by: 'Pat', at });
    expect(() =>
      recordDecision(task, {
        what: 'x',
        why: 'y',
        supersedes: 'D9',
        by: 'Pat',
        at,
      })
    ).toThrow(/No decision D9/);
    const entry = recordDecision(task, {
      what: 'Push',
      why: 'Polling missed events',
      alternatives: 'Faster polling',
      supersedes: 'D1',
      longLived: true,
      by: 'Sam',
      at,
    });
    expect(task.decisions[0].supersededBy).toBe('D2');
    expect(decisionComment(task, entry)).toBe(
      [
        '**Decision D2: Push**',
        '',
        '- Why: Polling missed events',
        '- Alternatives considered: Faster polling',
        '- Decided by: Sam, now',
        '- Supersedes: D1 (Poll)',
        '- Flagged as long-lived: a person decides whether to promote it to a lasting document.',
      ].join('\n')
    );
  });

  test('the CLI queues the comment for Kestral', () => {
    const { eng, co } = building();
    expect(
      eng('decision', '--what', 'Use a lock dir', '--why', 'Atomic on every OS')
    ).toMatch(/Recorded D1/);
    const comment = pending(co, 'PP-3').find(
      (i: { kind: string }) => i.kind === 'decision'
    );
    expect(readFileSync(comment.bodyPath, 'utf8')).toMatch(/Decided by: Pat/);
    expect(() => eng('reconcile')).toThrow(/--none/);
  });
});

describe('end-of-turn reconciliation', () => {
  test('asks once per work-bearing turn and never loops', () => {
    const { eng, turn, stop } = building();
    turn(['a.ts']);
    expect(stop().reason).toMatch(
      /changed 1 file\(s\) under PP-3: a\.ts\. .*reconcile --none/
    );
    expect(stop(true)).toEqual({});
    expect(stop()).toEqual({});

    turn(['b.ts']);
    eng('reconcile', '--none');
    expect(stop()).toEqual({});
  });

  test('read-only turns and unapproved plans are left alone', () => {
    const { eng, turn, stop } = building();
    turn([]);
    expect(stop()).toEqual({});
    eng('reopen', 'plan', '--reason', 'Scope changed');
    // The checkpoint the reopen queued predates the turn, so nothing is asked.
    turn(['a.ts']);
    expect(stop()).toEqual({});
  });

  test('a decision logged this turn also lists what waits to sync', () => {
    const { eng, turn, stop } = building();
    turn(['a.ts']);
    eng('decision', '--what', 'Retry three times', '--why', 'Matches the SLA');
    const { reason } = stop();
    expect(reason).not.toMatch(/reconcile them/);
    expect(reason).toMatch(
      /record\(s\) wait to go to Kestral[\s\S]*decision {2}create {2}D1: Retry three times/
    );
  });
});
