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
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

// A lock older than LOCK_STALE_MS is taken over once its holder has exited;
// past LOCK_ABANDONED_MS it is taken over whatever the holder looks like,
// so a reused process id cannot keep a record locked for good.
const LOCK_STALE_MS = 10_000;
const LOCK_ABANDONED_MS = 300_000;
const LOCK_WAIT_MS = 5_000;
const OWNER = `${hostname()} ${process.pid}`;

export function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * `owner/name` of the origin remote, lowercased. Without one, the main
 * checkout's folder name, which every worktree of it shares.
 */
function repoId(root, common) {
  try {
    const url = git(['remote', 'get-url', 'origin'], root);
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url);
    if (match) return match[1].toLowerCase();
  } catch {
    // No origin remote: a scratch or test checkout, named by its folder.
  }
  const shared = basename(common) === '.git' ? dirname(common) : common;
  return basename(shared)
    .replace(/\.git$/, '')
    .toLowerCase();
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
    // Not a git checkout, or git cannot read it: the flow stays off here,
    // and the CLI says so rather than guessing at a repository.
    return null;
  }
  let branch = null;
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  } catch {
    // Detached HEAD: there is no branch to scope records by.
  }
  return {
    root,
    branch,
    repo: repoId(root, common),
    dir: join(common, 'eng'),
  };
}

export const hashKey = (...parts) =>
  createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16);

export const branchRecord = (repo, branch) =>
  `branches/${hashKey(repo, branch)}.json`;

// Encoded, not replaced, so distinct keys never share a record.
export const taskRecord = (key) => `tasks/${encodeURIComponent(key)}.json`;

export function read(dir, name, fallback = null) {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function replace(dir, name, value) {
  const file = join(dir, name);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

const pause = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function running(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** Milliseconds since `path` changed, or null when it is gone. */
function age(path) {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Whether the holder of `lockDir` crashed or exited without releasing it. */
function abandoned(lockDir) {
  const held = age(lockDir);
  if (held === null || held < LOCK_STALE_MS) return false;
  if (held > LOCK_ABANDONED_MS) return true;
  let owner = '';
  try {
    owner = readFileSync(join(lockDir, 'owner'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const [host, pid] = owner.split(' ');
  return host !== hostname() || !running(Number(pid));
}

/**
 * Remove `lockDir` if it is abandoned; true when it was. One process
 * reclaims at a time and checks again under that guard, so it never removes
 * a lock another process has just taken in its place.
 */
function reclaim(lockDir) {
  const guard = `${lockDir}.reclaim`;
  try {
    mkdirSync(guard);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // The guard is held for a moment only; one this old was left by a crash.
    if (age(guard) > LOCK_STALE_MS)
      rmSync(guard, { recursive: true, force: true });
    return false;
  }
  try {
    if (!abandoned(lockDir)) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
}

function lock(file) {
  const lockDir = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, 'owner'), OWNER);
      return () => rmSync(lockDir, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (abandoned(lockDir) && reclaim(lockDir)) continue;
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
    replace(dir, name, next);
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
