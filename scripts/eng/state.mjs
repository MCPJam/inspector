/**
 * Local state for the engineering flow (`.agents/skills/eng/`).
 *
 * Records live under the git common directory, so every worktree of a
 * checkout reads the same ones and removing a worktree loses nothing. Kestral
 * holds the durable copy; this is the fast path for resume and the queue for
 * work the agent has not synced yet.
 *
 * Every write goes through `update`, which holds a per-record lock and
 * replaces the file by rename, so two worktrees ending a turn at the same
 * moment cannot overwrite each other.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** `owner/name` of the origin remote, lowercased; the folder name without one. */
export function repoId(root) {
  try {
    const url = git(['remote', 'get-url', 'origin'], root);
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (match) return match[1].toLowerCase();
  } catch {
    // No origin remote: a scratch or test checkout, named by its folder.
  }
  return basename(root).toLowerCase();
}

/**
 * The checkout containing `cwd`: its root, current branch (null when
 * detached), repository id and the shared state directory. Null outside git.
 */
export function checkout(cwd) {
  let root, common;
  try {
    [root, common] = git(
      [
        'rev-parse',
        '--path-format=absolute',
        '--show-toplevel',
        '--git-common-dir',
      ],
      cwd
    ).split('\n');
  } catch {
    return null;
  }
  let branch = null;
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  } catch {
    // Detached HEAD: there is no branch to scope records by.
  }
  return { root, branch, repo: repoId(root), dir: join(common, 'eng') };
}

export const hashKey = (...parts) =>
  createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

export const branchRecord = (repo, branch) =>
  `branches/${hashKey(repo, branch)}.json`;

export const taskRecord = (key) => `tasks/${key.replace(/[^\w.-]/g, '_')}.json`;

export function read(dir, name, fallback = null) {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export function write(dir, name, value) {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

const pause = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function lock(file) {
  const lockDir = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    // A holder that crashed leaves its lock behind; take it over once stale.
    try {
      if (Date.now() - statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (Date.now() > deadline) throw new Error(`State is locked: ${lockDir}`);
    pause(20);
  }
}

/**
 * Read-modify-write one record under its lock. `change` gets the current
 * value (or a copy of `fallback`) and returns the value to store.
 */
export function update(dir, name, change, fallback = {}) {
  const release = lock(join(dir, name));
  try {
    const next = change(read(dir, name, structuredClone(fallback)));
    write(dir, name, next);
    return next;
  } finally {
    release();
  }
}

/** Record names directly under `folder`, oldest first by name. */
export function list(dir, folder) {
  const path = join(dir, folder);
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${folder}/${name}`);
}
