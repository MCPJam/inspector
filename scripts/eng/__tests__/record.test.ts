// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { renderSession } from '../../../scripts/eng/record.mjs';
import { parseTranscript } from '../../../scripts/eng/transcripts.mjs';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/claude.jsonl'), 'utf8');
const session = (capture: object) => ({
  host: 'claude',
  sessionId: 'abcdef123456',
  branch: 'feature',
  repo: 'mcpjam/mcpjam-backend',
  startedAt: '2026-10-18T02:00:00.000Z',
  capture: {
    status: 'complete',
    unknown: 0,
    untimed: 0,
    note: null,
    ...capture,
  },
});
const task = { key: 'PP-8', decisions: [] };
const at = '2026-10-18T03:00:00.000Z';

describe('session record', () => {
  test('states an unavailable or partial capture, and missing timestamps, at the top', () => {
    const [none] = renderSession({
      session: session({
        status: 'unavailable',
        note: 'the host gave no transcript path',
      }),
      events: [],
      task,
      at,
    });
    expect(none).toMatch(
      /Capture: unavailable, because the host gave no transcript path\. This record holds no transcript events/
    );
    expect(none).toMatch(/No events captured\./);
    const [partial] = renderSession({
      session: session({ status: 'partial', unknown: 2, untimed: 3 }),
      events: [{ at: null, kind: 'prompt', text: 'hi' }],
      task,
      at,
    });
    expect(partial).toMatch(
      /Capture: partial\. 2 transcript line\(s\) could not be read/
    );
    expect(partial).toMatch(
      /Timestamps: missing for 3 event\(s\)[\s\S]*--:--:-- \*\*Prompt\*\* hi/
    );
  });

  test('lists files, checks and decisions, with output folded under its command', () => {
    const { events } = parseTranscript('claude', FIXTURE);
    const decided = {
      ...task,
      decisions: [
        { id: 'D1', what: 'Three retries', at: '2026-10-18T02:09:47.000Z' },
      ],
    };
    const [body] = renderSession({
      session: session({}),
      events,
      task: decided,
      at,
    });
    expect(body).toMatch(
      /^# Session record: Claude Code session abcdef12\n\n- Task: PP-8 · Branch: feature in mcpjam\/mcpjam-backend/
    );
    expect(body).toMatch(/## Files changed\n- `\/repo\/convex\/upload\.ts`/);
    expect(body).toMatch(/## Checks and tests run\n- `npm test -- upload`/);
    expect(body).toMatch(
      /02:09:35 \*\*Command\*\* `npm test -- upload`\n {2}<details><summary>Output: error: 1 failed/
    );
    expect(body).toMatch(
      /02:09:45 \*\*Edit\*\*[\s\S]*02:09:47 \*\*Decision\*\* D1: Three retries[\s\S]*02:09:50 \*\*Answer\*\*/
    );
    expect(body).not.toMatch(/\*\*Output\*\*/);
  });

  test('long text is folded and long sessions split into parts', () => {
    const long = 'x'.repeat(500);
    const events = Array.from({ length: 301 }, (_, n) => ({
      at,
      kind: 'answer',
      text: n ? `step ${n}` : long,
    }));
    const parts = renderSession({ session: session({}), events, task, at });
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(
      /\*\*Answer\*\* x{200}…\n {2}<details><summary>Full text/
    );
    expect(parts[1]).toMatch(
      /^# Session record, part 2 of 2\n\nContinues the chronology of PP-8's claude session abcdef12\.\n\n- 03:00:00 \*\*Answer\*\* step 300$/
    );
  });

  test('shows paths inside the checkout relative to it, and only real checks and commits', () => {
    const events = [
      { at, kind: 'edit', text: '/repo/convex/a.ts' },
      { at, kind: 'edit', text: '/tmp/notes/spec.md' },
      {
        at,
        kind: 'command',
        text: "cat > /tmp/spec.md <<'EOF'\nrun npm run typecheck and git commit\nEOF",
      },
      { at, kind: 'command', text: 'git add a.ts && git commit -m "add a"' },
      { at, kind: 'command', text: 'npx vitest run tests/a.test.ts' },
    ];
    const [body] = renderSession({
      session: session({}),
      events,
      task,
      at,
      root: '/repo',
    });
    expect(body).toMatch(
      /## Files changed\n- `convex\/a\.ts`\n- `\/tmp\/notes\/spec\.md \(outside the checkout\)`/
    );
    expect(body).toMatch(
      /## Commits\n- `git add a\.ts && git commit -m "add a"`\n\n/
    );
    expect(body).toMatch(
      /## Checks and tests run\n- `npx vitest run tests\/a\.test\.ts`\n\n/
    );
  });
});
