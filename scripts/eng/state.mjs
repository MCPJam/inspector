/**
 * Eng flow state: which Kestral task each branch belongs to, the flow step,
 * whether the flow was offered or declined, and the session records waiting
 * for upload. It lives in the git common directory (`.git/eng/`), so every
 * worktree of the repository shares it and removing a worktree loses nothing.
 * Nothing here is committed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The flow's steps, in order. `review` starts when a PR is requested. */
export const STEPS = ["task", "specs", "plan", "review2", "build", "review"];

/** Branches that never get a task of their own. */
const SHARED_BRANCHES = new Set(["main", "master", "HEAD"]);

export function git(args, cwd, timeout = 10_000) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout,
  }).trim();
}

/** Writes to stderr only when ENG_HOOK_DEBUG is set, so hooks stay quiet. */
export function debug(message) {
  if (process.env.ENG_HOOK_DEBUG) process.stderr.write(`[eng] ${message}\n`);
}

/** Null outside a git checkout. */
export function checkoutOf(cwd) {
  try {
    const [root, common] = git(
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      cwd,
    ).split("\n");
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    return { root, engDir: join(common, "eng"), branch };
  } catch (error) {
    debug(`not a git checkout: ${error.message}`);
    return null;
  }
}

export function isTaskBranch(branch) {
  return Boolean(branch) && !SHARED_BRANCHES.has(branch);
}

const EMPTY = () => ({ branches: {}, sessions: {} });

export function readState(engDir) {
  const file = join(engDir, "state.json");
  if (!existsSync(file)) return EMPTY();
  try {
    return { ...EMPTY(), ...JSON.parse(readFileSync(file, "utf8")) };
  } catch (error) {
    // A corrupt file must not wedge every hook; start over and say so.
    debug(`state.json unreadable, starting empty: ${error.message}`);
    return EMPTY();
  }
}

export function writeState(engDir, state) {
  mkdirSync(engDir, { recursive: true });
  const file = join(engDir, "state.json");
  const temp = `${file}.${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(temp, file);
}

/** Read, change and write the state in one step. Returns the new state. */
export function updateState(engDir, change) {
  const state = readState(engDir);
  change(state);
  writeState(engDir, state);
  return state;
}

/**
 * The branch's entry, or one inherited from a branch below it in the same
 * stack: a mapped branch whose tip HEAD contains and origin/main does not.
 */
export function entryFor(state, checkout) {
  const own = state.branches[checkout.branch];
  if (own?.task) return { ...own, branch: checkout.branch, inherited: false };
  for (const [branch, entry] of Object.entries(state.branches)) {
    if (!entry.task || branch === checkout.branch) continue;
    if (isStackParent(branch, checkout.root)) {
      return { ...entry, branch, inherited: true };
    }
  }
  return own ? { ...own, branch: checkout.branch, inherited: false } : null;
}

function isStackParent(branch, cwd) {
  try {
    git(["merge-base", "--is-ancestor", branch, "HEAD"], cwd);
  } catch {
    // Exit 1 means "not an ancestor"; a missing branch fails the same way.
    return false;
  }
  try {
    git(["merge-base", "--is-ancestor", branch, "origin/main"], cwd);
    return false;
  } catch {
    // Not in origin/main yet: still an open part of the stack.
    return true;
  }
}

export function sessionRecordPath(engDir, sessionId) {
  return join(engDir, "sessions", `${sessionId.replace(/[^\w.-]/g, "_")}.md`);
}
