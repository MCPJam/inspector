#!/usr/bin/env node
/**
 * The engineering flow's hook entry point, shared by every host:
 *
 *   node scripts/eng/hook.mjs <claude|codex|cursor>   (payload on stdin)
 *
 * Hooks keep local bookkeeping and hand the agent context: the offer, where
 * the effort stands, and, once per turn at most, what to reconcile or sync.
 * They never call Kestral, never block an edit or a PR, and exit 0 whatever
 * happens, so a broken hook cannot wedge a session.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadEffort, now, updateBranch } from './effort.mjs';
import { INJECTS, normalize, render } from './hosts.mjs';
import { isBuildPrompt, isSourceEdit, offerText } from './nudge.mjs';
import { noteHostRun } from './setup.mjs';
import { hashKey, update } from './state.mjs';
import { nextStep, stage } from './workflow.mjs';

export const sessionRecord = (host, sessionId) =>
  `sessions/${host}-${hashKey(sessionId)}.json`;

/** The offer text the first time a trigger fires on this branch, else null. */
function offer({ co, task }, trigger) {
  if (task || !co.branch) return null;
  let first = false;
  // Checked under the branch lock: two sessions on one branch offer once.
  updateBranch(co, (record) => {
    if (record.task || record.offer) return record;
    first = true;
    return { ...record, offer: 'offered', offeredAt: now() };
  });
  return first ? offerText(co.branch, trigger) : null;
}

function resume({ co, task }) {
  const link = task.url ? ` (${task.url})` : '';
  return `eng: ${co.branch} is on Kestral task ${task.key}${link}, stage ${stage(task)}. Next: ${nextStep(task)}`;
}

function noteEdits(event, effort, session) {
  const files = event.files.filter((file) =>
    isSourceEdit(file, effort.co.root)
  );
  const names = files.map((file) => relative(effort.co.root, file));
  session.turnFiles = [...new Set([...session.turnFiles, ...names])];
  return files.length ? offer(effort, 'a first source edit') : null;
}

/** One handler per event kind. Each returns context text, a result or null. */
export const handlers = {
  start: (event, effort) => (effort.task ? resume(effort) : null),
  prompt: (event, effort, session) => {
    session.turn += 1;
    session.turnStartedAt = now();
    session.turnFiles = [];
    return isBuildPrompt(event.prompt)
      ? offer(effort, 'a build request')
      : null;
  },
  edit: noteEdits,
  tool: noteEdits,
  stop: () => null,
  end: () => null,
};

/**
 * Run the handler for `event` against its session record. Context for a
 * host that cannot read it at this event waits for the next one that can.
 */
export function handle(event) {
  if (!event.kind) return {};
  const effort = loadEffort(event.cwd);
  if (!effort) return {};
  noteHostRun(effort.co, event.host);
  let result = {};
  const fresh = { turn: 0, turnFiles: [], startedAt: now() };
  update(
    effort.co.dir,
    sessionRecord(event.host, event.sessionId),
    (session) => {
      Object.assign(session, {
        host: event.host,
        sessionId: event.sessionId,
        repo: effort.co.repo,
        branch: effort.co.branch,
        task: effort.task?.key ?? null,
        transcriptPath: event.transcriptPath ?? session.transcriptPath ?? null,
        seenAt: now(),
      });
      const out = handlers[event.kind](event, effort, session) ?? {};
      const { context, followup } =
        typeof out === 'string' ? { context: out } : out;
      const waiting = [session.pendingContext, context]
        .filter(Boolean)
        .join('\n\n');
      if (INJECTS[event.host].has(event.kind)) {
        session.pendingContext = null;
        result = { context: waiting || undefined, followup };
      } else {
        session.pendingContext = waiting || null;
        result = { followup };
      }
      return session;
    },
    fresh
  );
  return result;
}

function main() {
  const host = process.argv[2];
  let event = null;
  try {
    event = normalize(host, JSON.parse(readFileSync(0, 'utf8')));
    process.stdout.write(render(event, handle(event)));
  } catch (error) {
    // Bookkeeping failed; the agent's work must not. Cursor still needs JSON.
    process.stderr.write(`eng hook skipped: ${error.message}\n`);
    if (host === 'cursor') {
      process.stdout.write(
        event?.kind === 'prompt' ? '{"continue":true}' : '{}'
      );
    }
  }
  process.exitCode = 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
