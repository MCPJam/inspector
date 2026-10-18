/**
 * Find the other MCPJam repository on this machine, read-only.
 *
 * Order: MCPJAM_INSPECTOR_DIR or MCPJAM_BACKEND_DIR, then the cached path
 * if it still checks out, then a bounded search: Spotlight on macOS, then
 * the folders next to this checkout and the usual code folders, two levels
 * deep at most. A candidate counts only if its origin remote is the expected
 * repository, and among worktrees of one repository the main checkout wins.
 *
 * Discovery runs only read-only git commands: it never clones, fetches,
 * pulls, resets or switches a checkout. A missing repository is reported as
 * unavailable, and freshness is measured against the local origin/main, so
 * it is only as current as the last fetch.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { read, update } from './state.mjs';
import { CLI } from './workflow.mjs';

const BACKEND = {
  name: 'backend',
  env: 'MCPJAM_BACKEND_DIR',
  remotes: ['mcpjam/mcpjam-backend'],
  folders: ['mcpjam-backend', 'backend'],
};
const INSPECTOR = {
  name: 'inspector',
  env: 'MCPJAM_INSPECTOR_DIR',
  remotes: ['mcpjam/inspector', 'mcpjam/mcpjam-inspector'],
  folders: ['inspector', 'mcpjam-inspector'],
};

/** The repository each one works with. */
export const COUNTERPART = {
  'mcpjam/mcpjam-backend': INSPECTOR,
  'mcpjam/inspector': BACKEND,
  'mcpjam/mcpjam-inspector': BACKEND,
};

const CODE_FOLDERS =
  'code src dev projects work repos git github Developer workspace'.split(' ');
const SEARCH_LIMIT = 400;
const CACHE = 'cache/counterparts.json';

const quiet = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
const gitRun = (cwd, args) =>
  execFileSync('git', args, { ...quiet, cwd, timeout: 3000 }).trim();
const execRun = (cmd, args) =>
  execFileSync(cmd, args, { ...quiet, timeout: 2000 });

const remoteId = (url) =>
  /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1].toLowerCase() ?? null;

/** The main checkout of `path` if it is the expected repository, else null. */
export function validate(path, spec, git = gitRun) {
  if (!path || !existsSync(path)) return null;
  try {
    const [root, common] = git(path, [
      'rev-parse',
      '--path-format=absolute',
      '--show-toplevel',
      '--git-common-dir',
    ]).split('\n');
    const origin = remoteId(git(path, ['remote', 'get-url', 'origin']));
    if (!spec.remotes.includes(origin)) return null;
    return basename(common) === '.git' ? dirname(common) : root;
  } catch {
    // Not a git checkout, or no origin: not the repository we want.
    return null;
  }
}

function children(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(dir, entry.name));
  } catch {
    // Unreadable or missing folder: nothing to search there.
    return [];
  }
}

/** Paths worth checking, nearest first, at most SEARCH_LIMIT of them. */
export function candidates(co, spec, { home, platform, run, git }) {
  const found = [];
  const mainRoot = validate(co.root, { remotes: [co.repo] }, git) ?? co.root;
  for (const base of new Set([dirname(co.root), dirname(mainRoot)])) {
    for (const folder of spec.folders) found.push(join(base, folder));
  }
  if (platform === 'darwin') {
    for (const folder of spec.folders) {
      try {
        const query = `kMDItemFSName == '${folder}' && kMDItemContentTypeTree == 'public.folder'`;
        found.push(
          ...run('mdfind', ['-onlyin', home, query]).split('\n').filter(Boolean)
        );
      } catch {
        // Spotlight off or slow: the folder search below still runs.
      }
    }
  }
  for (const base of [home, ...CODE_FOLDERS.map((name) => join(home, name))]) {
    for (const dir of [base, ...children(base)]) {
      for (const folder of spec.folders) found.push(join(dir, folder));
      if (found.length > SEARCH_LIMIT) break;
    }
  }
  return [...new Set(found)].slice(0, SEARCH_LIMIT);
}

/** Revision, branch and divergence from the local origin/main. */
export function freshness(path, git = gitRun) {
  const head = git(path, ['rev-parse', '--short', 'HEAD']);
  let branch = '(detached)';
  try {
    branch = git(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  } catch {
    // Detached HEAD: report the revision alone.
  }
  try {
    const [behind, ahead] = git(path, [
      'rev-list',
      '--left-right',
      '--count',
      'origin/main...HEAD',
    ])
      .split(/\s+/)
      .map(Number);
    const fetchHead = git(path, [
      'rev-parse',
      '--path-format=absolute',
      '--git-path',
      'FETCH_HEAD',
    ]);
    const fetchedAt = existsSync(fetchHead)
      ? statSync(fetchHead).mtime.toISOString()
      : null;
    return { head, branch, behind, ahead, fetchedAt };
  } catch {
    // No local origin/main to compare with; say so rather than guess.
    return { head, branch, behind: null, ahead: null, fetchedAt: null };
  }
}

/**
 * Locate the counterpart of `co`. `fast` skips the search, for hooks that
 * must answer quickly. Returns { name, status, path?, source?, reason? }.
 */
export function discover(co, options = {}) {
  const spec = COUNTERPART[co.repo];
  if (!spec) return null;
  const { env = process.env, fast = false, git = gitRun } = options;
  const search = {
    home: homedir(),
    platform: process.platform,
    run: execRun,
    git,
    ...options,
  };
  const { name } = spec;
  const found = (path, source) => ({
    name,
    status: 'found',
    path,
    source,
    ...freshness(path, git),
  });
  const missing = (status, reason) => ({ name, status, env: spec.env, reason });
  if (env[spec.env]) {
    const path = validate(env[spec.env], spec, git);
    if (path) return found(path, spec.env);
    return missing(
      'unavailable',
      `${spec.env}=${env[spec.env]} is not a checkout of ${spec.remotes[0]}`
    );
  }
  const cached = validate(read(co.dir, CACHE, {})[name], spec, git);
  if (cached) return found(cached, 'cache');
  if (fast) return missing('unlocated', 'not located yet');
  for (const candidate of candidates(co, spec, search)) {
    const path = validate(candidate, spec, git);
    if (!path) continue;
    update(co.dir, CACHE, (cache) => ({ ...cache, [name]: path }));
    return found(path, 'search');
  }
  return missing('unavailable', 'not found on this machine');
}

export function describeCounterpart(result) {
  if (!result) return null;
  if (result.status === 'unlocated') {
    return `${result.name}: not located yet; run \`${CLI} repos\` when the work needs it.`;
  }
  if (result.status !== 'found') {
    return `${result.name}: unavailable (${result.reason}). Nothing was cloned. Carry on with work that does not need it; if a required step does, ask the engineer for its path and set ${result.env}.`;
  }
  const drift =
    result.behind === null
      ? 'no local origin/main to compare with'
      : `${result.behind} behind and ${result.ahead} ahead of origin/main as of the last fetch${result.fetchedAt ? ` (${result.fetchedAt})` : ''}; nothing was fetched`;
  return `${result.name}: ${result.path} on ${result.branch} at ${result.head}, ${drift}.`;
}

export const repoCommands = {
  repos: (effort, { flags }) => {
    const result = discover(effort.co);
    if (!result) return `No other repository is known for ${effort.co.repo}.`;
    return flags.json ? JSON.stringify(result) : describeCounterpart(result);
  },
};
