#!/usr/bin/env node
/**
 * `Kestral: <task>` trailers tie a commit to the task that explains it.
 *
 * The commit-msg git hook runs this for every author, so commits from
 * Claude Code, Codex, Cursor and people all carry the trailer on a branch
 * linked to a task. Existing trailers stay, and an identical one is never
 * added twice. Reading the trailers back recovers a branch's task when the
 * local record is gone, and answers "why is this line here".
 *
 *   node scripts/eng/trailers.mjs <commit message file>
 */
import { pathToFileURL } from 'node:url';

import { CLI } from './workflow.mjs';
import { branchRecord, checkout, git, read, taskRecord } from './state.mjs';

export const TRAILER = 'Kestral';

export function addTrailer(file, key, cwd) {
  git(
    [
      'interpret-trailers',
      '--in-place',
      '--if-exists',
      'addIfDifferent',
      '--trailer',
      `${TRAILER}: ${key}`,
      file,
    ],
    cwd
  );
}

/** Task keys named by `Kestral:` trailers in `range`, newest first. */
export function trailerTasks(range, cwd) {
  const out = git(
    [
      'log',
      `--format=%(trailers:key=${TRAILER},valueonly,separator=%x2C)`,
      range,
    ],
    cwd
  );
  return [
    ...new Set(
      out
        .split(/[\n,]/)
        .map((key) => key.trim())
        .filter(Boolean)
    ),
  ];
}

/** The task this branch's own commits name, for a checkout with no record. */
export function recoverTask(co) {
  try {
    return trailerTasks('origin/main..HEAD', co.root)[0] ?? null;
  } catch {
    // No origin/main to compare with: the branch's own commits are unknown.
    return null;
  }
}

export const recoveryHint = (key) =>
  `Commits on this branch name Kestral task ${key}, but this checkout has no record of it. Restore its checkpoint from the task with \`${CLI} restore --file <saved checkpoint>\`, or \`${CLI} link ${key}\` to start fresh.`;

/** Blame one line, then follow the commit's trailer to its task. */
export function why(effort, target) {
  const match = /^(.+):(\d+)$/.exec(target ?? '');
  if (!match) throw new Error('Name a line as <file>:<line>.');
  const [, file, line] = match;
  const { root } = effort.co;
  const sha = git(
    ['blame', '--porcelain', '-L', `${line},${line}`, '--', file],
    root
  ).split(' ')[0];
  if (/^0+$/.test(sha)) return `${file}:${line} is not committed yet.`;
  const [subject, author, date] = git(
    ['log', '-1', '--format=%s%n%an%n%as', sha],
    root
  ).split('\n');
  const head = `${file}:${line} last changed in ${sha.slice(0, 9)} "${subject}" (${author}, ${date})`;
  const [key] = trailerTasks(`${sha}^!`, root);
  if (!key) {
    return `${head}. It has no ${TRAILER} trailer, so no task records why; say so rather than guess, and read the commit and its PR.`;
  }
  const task =
    effort.task?.key === key
      ? effort.task
      : read(effort.co.dir, taskRecord(key));
  const decisions = (task?.decisions ?? []).map((d) => `${d.id} ${d.what}`);
  return [
    `${head}, on Kestral task ${key}${task?.url ? ` (${task.url})` : ''}.`,
    decisions.length
      ? `Decisions recorded locally: ${decisions.join('; ')}.`
      : 'No decisions are recorded locally.',
    'Read the task, its decision comments and session records with your Kestral connector before answering.',
  ].join('\n');
}

function main(file) {
  const co = checkout(process.cwd());
  if (!co?.branch) return;
  const record = read(co.dir, branchRecord(co.repo, co.branch), {});
  if (record.task) addTrailer(file, record.task, co.root);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main(process.argv[2]);
  } catch (error) {
    // A missing trailer is recoverable later; a refused commit is not.
    console.error(`eng: Kestral trailer not added: ${error.message}`);
  }
}
