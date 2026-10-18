/**
 * An effort is one Kestral task and the branches working on it, in either
 * repository. A branch record names its task; the task record holds the
 * documents, approvals and history every branch of the effort shares. The
 * CLI and the hooks both read and write efforts through this module.
 */
import {
  branchRecord,
  checkout,
  git,
  read,
  taskRecord,
  update,
} from './state.mjs';
import { CLI, newTask } from './workflow.mjs';

export const now = () => new Date().toISOString();

/** `git config user.name`, the default for who approved or decided. */
export function whoami(root) {
  try {
    return git(['config', 'user.name'], root) || 'unknown';
  } catch {
    // Unset name: git exits 1. The record still says someone decided.
    return 'unknown';
  }
}

/** The checkout, its branch record and the linked task, if any. */
export function loadEffort(cwd) {
  const co = checkout(cwd);
  if (!co) return null;
  const branch = co.branch
    ? read(co.dir, branchRecord(co.repo, co.branch), {})
    : {};
  const task = branch.task ? read(co.dir, taskRecord(branch.task)) : null;
  return { co, branch, task };
}

/** The linked task's key, or an error telling the agent to link one. */
export function requireTask(effort) {
  if (!effort.task) {
    throw new Error(`Link a Kestral task first: ${CLI} link <TASK-KEY>`);
  }
  return effort.task.key;
}

export function updateBranch(co, change) {
  if (!co.branch) {
    throw new Error(
      'Check out a branch first: the flow is tracked per branch.'
    );
  }
  return update(co.dir, branchRecord(co.repo, co.branch), (record) => ({
    repo: co.repo,
    branch: co.branch,
    ...change(record),
  }));
}

export function updateTask(co, key, change) {
  return update(co.dir, taskRecord(key), (task) => change(task), newTask(key));
}

/** Point this branch at `key`. Stacked branches and the other repo join the same task. */
export function linkBranch(co, key, url) {
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(key)) {
    throw new Error(`"${key}" is not a Kestral task key. Use one like PP-96.`);
  }
  updateBranch(co, (record) => ({ ...record, task: key, offer: 'accepted' }));
  return updateTask(co, key, (task) => {
    if (url) task.url = url;
    const seen = task.branches.some(
      (b) => b.repo === co.repo && b.branch === co.branch
    );
    if (!seen) task.branches.push({ repo: co.repo, branch: co.branch });
    return task;
  });
}
