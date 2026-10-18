#!/usr/bin/env node
/**
 * The engineering flow's command line. The agent runs it as the engineer
 * links a task, approves the specs or the plan, or asks where things stand.
 * Kestral calls stay with the agent's connector; this only keeps the local
 * record that resume, the hooks and the review page read.
 *
 *   status [--json]                         where the effort stands
 *   link <TASK-KEY> [--url <url>]           start, or join a stacked branch
 *   decline                                 keep the flow off for this branch
 *   doc <kind> --ref <id> (--revision <v> | --file <export>)
 *   review (--file <findings.json> | --none) [--revision <plan revision>]
 *   approve <specs|plan> [--by <name>]
 *   reopen <specs|plan> --reason <why>
 *   checkpoint                              JSON to save on the Kestral task
 *   restore --file <checkpoint.json> [--force]
 *   hooks                                   which hosts' hooks are running
 *   pending [--all]                         records waiting to go to Kestral
 *   synced <id> --ref <kestral id>          mark one as saved
 *   decision --what <..> --why <..> [--alternatives <..>] [--supersedes D<n>] [--long-lived]
 *   reconcile --none                        nothing material changed this turn
 *   repos [--json]                          find the other repository, read-only
 *   why <file>:<line>                       the commit and task behind a line
 *   scenario add <text> | <id> <passed|failed|unverified> [--evidence <ref>] [--note <why>]
 *   ui none | states <a,b> | shot <path> --phase <..> --state <..> [--steps <..>] | deviation <text>
 *   review-page [--base <ref>] [--notes <plan-vs-actual.md>] [--risk <text>]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  linkBranch,
  loadEffort,
  requireTask,
  now,
  updateBranch,
  whoami,
} from './effort.mjs';
import { decisionCommands } from './decisions.mjs';
import { evidenceCommands } from './evidence.mjs';
import { repoCommands } from './repos.mjs';
import { reviewCommands } from './review.mjs';
import { recoverTask, recoveryHint, why } from './trailers.mjs';
import { uiCommands } from './ui.mjs';
import { changeTask, queueCheckpoint, syncCommands } from './sync.mjs';
import { hostStatus } from './setup.mjs';
import { read, taskRecord, write } from './state.mjs';
import {
  CLI,
  approve,
  currentRevision,
  nextStep,
  recordDoc,
  recordReview,
  reopen,
  stage,
} from './workflow.mjs';

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
      continue;
    }
    const value = argv[i + 1];
    const takesValue = value !== undefined && !value.startsWith('--');
    flags[argv[i].slice(2)] = takesValue ? value : true;
    if (takesValue) i++;
  }
  return { positional, flags };
}

const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** A saved checkpoint, as exported from Kestral: the JSON inside any fence. */
function checkpointFile(path) {
  const text = readFileSync(path, 'utf8');
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

function status(effort, { flags }) {
  const { co, branch, task } = effort;
  const summary = task
    ? {
        task: task.key,
        url: task.url,
        stage: stage(task),
        next: nextStep(task),
      }
    : { task: null, offer: branch.offer ?? 'not offered' };
  if (flags.json) {
    return JSON.stringify({ repo: co.repo, branch: co.branch, ...summary });
  }
  const lines = [`Branch: ${co.branch ?? '(detached)'} in ${co.repo}`];
  const recovered = task ? null : recoverTask(co);
  if (recovered) {
    lines.push(recoveryHint(recovered));
  } else if (!task) {
    lines.push(
      `Task: none (flow ${summary.offer}). Start with \`${CLI} link <TASK-KEY>\`.`
    );
  } else {
    lines.push(`Task: ${task.key}${task.url ? ` ${task.url}` : ''}`);
    lines.push(`Stage: ${summary.stage}`, `Next: ${summary.next}`);
  }
  return lines.join('\n');
}

export const coreCommands = {
  status,
  hooks: (effort) => hostStatus(effort.co).join('\n'),
  why: (effort, { positional }) => why(effort, positional[0]),
  link: (effort, { positional, flags }) => {
    const task = linkBranch(effort.co, positional[0], flags.url);
    queueCheckpoint(effort.co, task);
    return `Linked ${effort.co.branch} to ${task.key}. Next: ${nextStep(task)}`;
  },
  decline: (effort) => {
    updateBranch(effort.co, (record) => ({ ...record, offer: 'declined' }));
    return `The flow stays off for ${effort.co.branch}. Start it later with \`${CLI} link <TASK-KEY>\`.`;
  },
  doc: (effort, { positional, flags }) => {
    const revision = flags.file
      ? createHash('sha256')
          .update(readFileSync(flags.file))
          .digest('hex')
          .slice(0, 12)
      : flags.revision;
    const task = changeTask(effort, (t) =>
      recordDoc(t, positional[0], { ref: flags.ref, revision, at: now() })
    );
    return `Recorded ${positional[0]} revision ${revision}. Next: ${nextStep(task)}`;
  },
  review: (effort, { flags }) => {
    const raw = flags.none ? [] : json(flags.file);
    const findings = Array.isArray(raw) ? raw : raw.findings;
    const task = changeTask(effort, (t) =>
      recordReview(t, {
        revision: flags.revision ?? currentRevision(t, 'plan'),
        findings,
        at: now(),
      })
    );
    return `Recorded ${findings.length} review finding(s). Next: ${nextStep(task)}`;
  },
  approve: (effort, { positional, flags }) => {
    const by = flags.by ?? whoami(effort.co.root);
    const task = changeTask(effort, (t) =>
      approve(t, positional[0], { by, at: now() })
    );
    return `${positional[0]} approved by ${by}. Next: ${nextStep(task)}`;
  },
  reopen: (effort, { positional, flags }) => {
    const by = whoami(effort.co.root);
    const task = changeTask(effort, (t) =>
      reopen(t, positional[0], { reason: flags.reason, by, at: now() })
    );
    return `Reopened ${positional[0]}. Next: ${nextStep(task)}`;
  },
  checkpoint: (effort) => {
    requireTask(effort);
    const saved = { kind: 'eng-checkpoint', version: 1, task: effort.task };
    return JSON.stringify(saved, null, 2);
  },
  restore: (effort, { flags }) => {
    const saved = checkpointFile(flags.file);
    if (saved.kind !== 'eng-checkpoint' || saved.version !== 1) {
      throw new Error(`${flags.file} is not an eng checkpoint (version 1).`);
    }
    const key = saved.task.key;
    const mine = read(effort.co.dir, taskRecord(key));
    if (
      mine &&
      mine.history.length > saved.task.history.length &&
      !flags.force
    ) {
      throw new Error(
        `Local state for ${key} is newer (${mine.history.length} entries, checkpoint has ${saved.task.history.length}). Pass --force to replace it.`
      );
    }
    write(effort.co.dir, taskRecord(key), saved.task);
    linkBranch(effort.co, key);
    return `Restored ${key}. Next: ${nextStep(saved.task)}`;
  },
};

const COMMANDS = {
  ...coreCommands,
  ...syncCommands,
  ...decisionCommands,
  ...repoCommands,
  ...evidenceCommands,
  ...uiCommands,
  ...reviewCommands,
};

export function run(argv, cwd = process.cwd(), commands = COMMANDS) {
  const [name, ...rest] = argv;
  const command = commands[name];
  if (!command) {
    throw new Error(
      `Unknown command "${name ?? ''}". Commands: ${Object.keys(commands).join(', ')}.`
    );
  }
  const effort = loadEffort(cwd);
  if (!effort) throw new Error('Run this inside a git checkout.');
  return command(effort, parseArgs(rest));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
