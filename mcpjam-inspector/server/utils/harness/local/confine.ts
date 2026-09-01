/**
 * Symlink-aware path confinement for the local provider's filesystem surface.
 *
 * ── What this protects, and what it does not ─────────────────────────────
 * It protects INSPECTOR's own file API. The AI SDK sandbox contract exposes
 * `readTextFile`/`writeFile`/… to the adapter and, through it, to code the
 * model influences. Without this, those methods would be a read-and-write-
 * anywhere primitive reachable from a prompt, which is a different and much
 * larger hole than "the vendor process has the OS user's authority".
 *
 * It does NOT protect the machine from the vendor process. That process runs
 * with the OS user's authority and can open anything the user can, no matter
 * what this module says about our own API. Native mode's honesty depends on
 * not confusing the two.
 *
 * ── Why string normalization is not enough ───────────────────────────────
 * `posix.normalize` collapses `..` but knows nothing about symlinks. A link at
 * `<workspace>/notes -> /etc` makes `<workspace>/notes/passwd` pass every
 * string check and land outside. So confinement resolves the deepest EXISTING
 * ancestor with `realpath` and re-attaches the not-yet-created tail, then
 * checks the result. A write that creates a new file inside the root is
 * allowed; a write through a link that leaves the root is not.
 */
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";

const MAX_PATH_LENGTH = 4096;

export class PathConfinementError extends Error {
  readonly requestedPath: string;
  constructor(message: string, requestedPath: string) {
    super(message);
    this.name = "PathConfinementError";
    this.requestedPath = requestedPath;
  }
}

function isUnder(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

/**
 * Resolve the deepest existing ancestor of `path` and return it together with
 * the segments that do not exist yet.
 *
 * Bounded by the path's own depth, and stops at the filesystem root, so a
 * pathological input cannot spin here.
 */
async function resolveExistingAncestor(
  path: string
): Promise<{ base: string; tail: string[] }> {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return { base: await realpath(current), tail };
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        // Reached the root without finding anything real.
        return { base: current, tail };
      }
      tail.unshift(current.slice(parent.length + 1));
      current = parent;
    }
  }
}

export interface ConfinementRoots {
  /** Canonical (already realpath'd) roots a path may resolve into. */
  roots: readonly string[];
}

/**
 * Confine `requested` to one of `roots`, following symlinks.
 *
 * Returns the canonical path to operate on. Throws `PathConfinementError` with
 * a message that names the rule rather than the resolved target — a caller
 * that leaks "your path resolved to /etc/shadow" back to a model has handed it
 * a filesystem oracle.
 */
export async function confinePath(
  requested: string,
  { roots }: ConfinementRoots
): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new PathConfinementError("no path was given", String(requested));
  }
  if (requested.length > MAX_PATH_LENGTH) {
    throw new PathConfinementError(
      `path exceeds ${MAX_PATH_LENGTH} characters`,
      `${requested.slice(0, 64)}…`
    );
  }
  if (requested.includes("\0")) {
    throw new PathConfinementError("path contains a NUL byte", "<redacted>");
  }
  if (!isAbsolute(requested)) {
    throw new PathConfinementError(
      "path must be absolute; the local provider does not resolve relative " +
        "paths against an ambient working directory",
      requested
    );
  }
  if (roots.length === 0) {
    throw new PathConfinementError(
      "no writable root is configured for this session",
      requested
    );
  }

  const normalized = normalize(requested);
  const { base, tail } = await resolveExistingAncestor(normalized);
  const canonical = tail.length === 0 ? base : resolve(base, ...tail);

  for (const root of roots) {
    if (isUnder(canonical, root)) return canonical;
  }

  throw new PathConfinementError(
    "path resolves outside every directory this session was granted. The " +
      "workspace grant and the session state directory are the only roots the " +
      "Inspector file API will touch.",
    requested
  );
}
