/**
 * Finds the other MCPJam repository on this machine, so an agent working in
 * one repo can read the other without setup. Lookup order:
 *   1. MCPJAM_INSPECTOR_DIR / MCPJAM_BACKEND_DIR, for two checkouts
 *   2. the path cached in ~/.cache/mcpjam/repos.json, if it is still valid
 *   3. a search: Spotlight on macOS, a shallow scan of common folders elsewhere
 *   4. a shallow clone of main into the cache
 * A candidate counts only when it is a main checkout (not a worktree) whose
 * origin is the MCPJam repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { debug, git } from "./state.mjs";

export const REPOS = {
  inspector: {
    slug: "MCPJam/inspector",
    names: ["inspector", "mcpjam-inspector"],
    env: "MCPJAM_INSPECTOR_DIR",
  },
  backend: {
    slug: "MCPJam/mcpjam-backend",
    names: ["mcpjam-backend", "backend"],
    env: "MCPJAM_BACKEND_DIR",
  },
};

const SCAN_DIRS = ["", "code", "src", "dev", "projects", "work", "git", "repos", "Developer", "Documents/GitHub"];

export function cacheDir(home = homedir()) {
  return join(home, ".cache", "mcpjam");
}

/** Which repo an origin URL points at, or null. */
export function repoForRemote(url) {
  const slug = String(url).replace(/\.git$/, "").match(/github\.com[:/]+([^/]+\/[^/]+)$/i)?.[1];
  return Object.keys(REPOS).find((key) => REPOS[key].slug.toLowerCase() === slug?.toLowerCase()) ?? null;
}

function originOf(dir) {
  try {
    return git(["remote", "get-url", "origin"], dir);
  } catch (error) {
    debug(`no origin in ${dir}: ${error.message}`);
    return null;
  }
}

/** `dir` is the main checkout of `key`: not a worktree, origin matches. */
export function isMainCheckout(dir, key) {
  if (!existsSync(join(dir, ".git"))) return false;
  try {
    const [top, common] = git(
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      dir,
    ).split("\n");
    const real = realpathSync(dir);
    if (realpathSync(top) !== real || realpathSync(common) !== join(real, ".git")) return false;
  } catch (error) {
    debug(`${dir} is not a checkout: ${error.message}`);
    return false;
  }
  return repoForRemote(originOf(dir) ?? "") === key;
}

function readCache(home) {
  const file = join(cacheDir(home), "repos.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    debug(`repos.json unreadable: ${error.message}`);
    return {};
  }
}

function writeCache(home, key, dir) {
  mkdirSync(cacheDir(home), { recursive: true });
  const cache = { ...readCache(home), [key]: dir };
  writeFileSync(join(cacheDir(home), "repos.json"), `${JSON.stringify(cache, null, 2)}\n`);
}

function spotlight(names) {
  const query = names.map((name) => `kMDItemFSName == "${name}"`).join(" || ");
  try {
    return execFileSync("mdfind", [`(${query}) && kMDItemContentType == "public.folder"`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n").filter(Boolean);
  } catch (error) {
    debug(`Spotlight search failed: ${error.message}`);
    return [];
  }
}

function scan(home, names) {
  const found = [];
  for (const sub of SCAN_DIRS) {
    const base = join(home, sub);
    if (!existsSync(base)) continue;
    for (const name of names) found.push(join(base, name));
    try {
      for (const child of readdirSync(base, { withFileTypes: true })) {
        if (child.isDirectory() && !child.name.startsWith(".")) {
          for (const name of names) found.push(join(base, child.name, name));
        }
      }
    } catch (error) {
      debug(`cannot list ${base}: ${error.message}`);
    }
  }
  return found;
}

function shallowClone(home, key, sshStyle) {
  const target = join(cacheDir(home), "repos", key);
  const url = sshStyle ? `git@github.com:${REPOS[key].slug}.git` : `https://github.com/${REPOS[key].slug}.git`;
  try {
    mkdirSync(join(cacheDir(home), "repos"), { recursive: true });
    execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", "main", url, target], {
      stdio: "ignore",
      timeout: 90_000,
    });
    return target;
  } catch (error) {
    debug(`clone of ${url} failed: ${error.message}`);
    return null;
  }
}

/** The other repo's main checkout: { key, dir, how } or { key, dir: null }. */
export function findOtherRepo(cwd, { home = homedir(), env = process.env, os = platform() } = {}) {
  const origin = originOf(cwd) ?? "";
  const here = repoForRemote(origin);
  if (!here) return null;
  const key = here === "inspector" ? "backend" : "inspector";
  const override = env[REPOS[key].env];
  if (override && isMainCheckout(resolve(override), key)) {
    return { key, dir: resolve(override), how: REPOS[key].env };
  }
  const cached = readCache(home)[key];
  if (cached && isMainCheckout(cached, key)) return { key, dir: cached, how: "cache" };
  const candidates = os === "darwin" ? spotlight(REPOS[key].names) : scan(home, REPOS[key].names);
  const dir = candidates.find((candidate) => isMainCheckout(candidate, key));
  if (dir) {
    writeCache(home, key, dir);
    return { key, dir, how: "search" };
  }
  const cloned = shallowClone(home, key, origin.startsWith("git@"));
  if (cloned) writeCache(home, key, cloned);
  return { key, dir: cloned, how: cloned ? "clone" : null };
}

/** How far the checkout's HEAD is behind origin/main, after a quick fetch. */
export function staleness(dir) {
  try {
    git(["fetch", "--quiet", "origin", "main"], dir, 10_000);
  } catch (error) {
    debug(`fetch in ${dir} failed, using the last fetched origin/main: ${error.message}`);
  }
  try {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    const behind = Number(git(["rev-list", "--count", "HEAD..origin/main"], dir));
    return { branch, behind };
  } catch (error) {
    debug(`cannot compare ${dir} with origin/main: ${error.message}`);
    return null;
  }
}

export function describeOtherRepo(found, home = homedir()) {
  if (!found) return null;
  const name = REPOS[found.key].slug.split("/")[1];
  if (!found.dir) {
    return `${name} was not found on this machine and could not be cloned. Set ${REPOS[found.key].env} if it lives somewhere unusual.`;
  }
  const shown = found.dir.startsWith(home) ? `~${found.dir.slice(home.length)}` : found.dir;
  const stale = staleness(found.dir);
  const where = stale
    ? `on ${stale.branch}, ${stale.behind} commit${stale.behind === 1 ? "" : "s"} behind origin/main`
    : "staleness unknown";
  return `${name} is at ${shown} (${where}). Read it from origin/main, e.g. \`git -C ${shown} show origin/main:<path>\`, not the working tree.`;
}
