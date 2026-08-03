/**
 * The checkout listing that rule C verifies entry points against.
 *
 * SEPARATE FROM detect.ts ON PURPOSE: detect.ts is a pure function of already-
 * read file contents and does no I/O, which is what makes it trivially testable
 * and safe to call from a cache-keying path. This module is the one place that
 * shells out, so both callers that have a checkout on disk — the corpus harness
 * (a clone in a tmpdir) and A3 (the checkout in the sandbox) — produce the
 * SAME shape from the SAME command instead of two hand-rolled listings that
 * drift.
 *
 * WHY `git ls-files -s` AND NOT `git ls-files`:
 *
 * Plain `git ls-files` prints PATHS. A tracked `server.js` that is a symlink to
 * `node_modules/acme/server.js` prints as `server.js` — indistinguishable from
 * checkout source in the text, and node follows the link at runtime. `-s`
 * prints the MODE, and mode `120000` is git's symlink mode. That one column is
 * the difference between proving an entry point is checkout code and merely
 * observing that its name is unremarkable.
 */

import { execFileSync } from "node:child_process";
import type { RepoFileEntry, RepoFileKind } from "./detect";

/**
 * Cap on the listing handed to detection. Detection uses it for exact lookups
 * of a handful of entry paths, so a monorepo with 400k tracked files would cost
 * megabytes of strings to answer four questions. Truncation is SAFE in the
 * suppress direction: a missing entry can only cause a candidate to be
 * suppressed or downgraded to 'unverified', never accepted.
 */
export const MAX_REPO_FILES = 20_000;

/** git's file modes, as they appear in `git ls-files -s`. */
const GIT_MODE_SYMLINK = "120000";
const GIT_MODE_REGULAR = new Set(["100644", "100755"]);

function kindForMode(mode: string): RepoFileKind {
  if (GIT_MODE_REGULAR.has(mode)) return "file";
  if (mode === GIT_MODE_SYMLINK) return "symlink";
  // 160000 is a gitlink (submodule); anything else is a mode we do not know,
  // and "we do not know" must never read as "regular file".
  return "other";
}

/**
 * Parse `git ls-files -s -z` output.
 *
 * Each record is `<mode> <sha> <stage>\t<path>`, NUL-terminated. NUL delimiting
 * is not a nicety: newlines are legal in git paths, so a line-oriented parser
 * would split one path into two entries — and a bogus half-path in the listing
 * is a lookup that silently misses, i.e. a silent recall loss.
 *
 * Malformed records are DROPPED rather than guessed at, for the same reason.
 */
export function parseLsFilesEntries(stdout: string): RepoFileEntry[] {
  const out: RepoFileEntry[] = [];
  for (const record of stdout.split("\0")) {
    if (record.length === 0) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const path = record.slice(tab + 1);
    if (path.length === 0) continue;
    const mode = record.slice(0, tab).split(" ")[0] ?? "";
    out.push({ path, kind: kindForMode(mode) });
    if (out.length >= MAX_REPO_FILES) break;
  }
  return out;
}

/**
 * The checkout's tracked files with their types, for detection's rule C.
 *
 * `git ls-files` rather than a directory walk: the clone is already a git repo,
 * it is one process instead of a recursive stat storm, and it excludes `.git/`
 * and anything gitignored for free.
 *
 * Returns `[]` when git fails for any reason. That is a VALID input, not an
 * error: detection reads an empty listing as "no listing", falls back to its
 * conservative path, and marks what it does emit `ownershipProof: 'unverified'`
 * so A3 still settles it at runtime. Biasing toward suppression on our own
 * infrastructure failure is the safe direction.
 */
export function listRepoFiles(dir: string): RepoFileEntry[] {
  try {
    const stdout = execFileSync("git", ["ls-files", "-s", "-z"], {
      cwd: dir,
      stdio: "pipe",
      timeout: 60_000,
      maxBuffer: 64 * 1024 * 1024,
    }).toString("utf8");
    return parseLsFilesEntries(stdout);
  } catch {
    return [];
  }
}
