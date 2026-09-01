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
 *
 * ── Dangling links are links, not absences ───────────────────────────────
 * `realpath` FAILS on a symlink whose target does not exist, so an earlier
 * version of the ancestor walk classified such a link as "a name that is not
 * there yet" and re-attached it literally — landing back inside the root and
 * passing. The link still redirects the write, and `open(…, "w")` follows it
 * and creates the target. With no race at all, a link planted at
 * `<workspace>/x -> /home/u/.ssh/authorized_keys` turned a granted write into
 * a write outside the grant. So each not-yet-resolved segment is `lstat`ed:
 * one that EXISTS as a symlink is followed explicitly (bounded, so a chain or
 * a cycle cannot spin) and the result is what gets checked.
 *
 * ── The remaining race, stated plainly ───────────────────────────────────
 * Validation and the filesystem operation are two steps, so a process running
 * as the same OS user can replace a resolved directory with a symlink in
 * between and move the write outside the root. Closing that properly needs
 * `openat`-style directory-handle operations with no-follow semantics, which
 * Node does not expose.
 *
 * The honest framing: in NATIVE mode the only actor able to win that race is a
 * same-user process, and a same-user process can already open those paths
 * directly — this module was never what stood between it and the filesystem.
 * So the race does not widen native mode's authority. It WOULD matter under an
 * isolation backend, where the confined child genuinely cannot reach outside
 * on its own; a backend that relies on this check for its filesystem boundary
 * must supply its own enforcement rather than inherit this one.
 */
import { lstat, readlink, realpath } from "node:fs/promises";
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
  path: string,
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
      // `+ 1` skips the separator between parent and child — but when the
      // parent IS the root it already ends in one, so adding the offset would
      // eat the first character of the segment and turn `/ttmp/x` into
      // `/tmp/x`. Skip the separator only when there is one to skip.
      const cut = parent.endsWith(sep) ? parent.length : parent.length + 1;
      tail.unshift(current.slice(cut));
      current = parent;
    }
  }
}

/** A symlink chain longer than this is malice or a loop; either way, refuse. */
const MAX_LINK_HOPS = 8;

/**
 * Walk the not-yet-resolved tail, following any segment that turns out to
 * EXIST as a symlink.
 *
 * `realpath` already resolved everything up to `base`; what remains is
 * segments it could not resolve. "Could not resolve" is not "is not there" —
 * a dangling symlink is exactly the case where the two differ, and it is the
 * one that redirects a write. Each segment is therefore `lstat`ed before being
 * treated as a name to create.
 */
async function resolveDanglingLinks(
  base: string,
  tail: readonly string[],
  requested: string,
): Promise<string> {
  let current = base;
  for (let index = 0; index < tail.length; index += 1) {
    let next = resolve(current, tail[index]!);
    let hops = 0;
    for (;;) {
      let isLink: boolean;
      try {
        isLink = (await lstat(next)).isSymbolicLink();
      } catch {
        // Genuinely absent. Nothing below it can exist either, so the rest of
        // the tail is a path to be created.
        return resolve(next, ...tail.slice(index + 1));
      }
      if (!isLink) {
        // It exists and is not a link; `realpath` it in case anything under it
        // resolves differently, then move on to the next segment.
        next = await realpath(next).catch(() => next);
        break;
      }
      if ((hops += 1) > MAX_LINK_HOPS) {
        throw new PathConfinementError(
          `path passes through more than ${MAX_LINK_HOPS} symbolic links`,
          requested,
        );
      }
      const link = await readlink(next);
      next = isAbsolute(link)
        ? normalize(link)
        : normalize(resolve(dirname(next), link));
    }
    current = next;
  }
  return current;
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
  { roots }: ConfinementRoots,
): Promise<string> {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new PathConfinementError("no path was given", String(requested));
  }
  if (requested.length > MAX_PATH_LENGTH) {
    throw new PathConfinementError(
      `path exceeds ${MAX_PATH_LENGTH} characters`,
      `${requested.slice(0, 64)}…`,
    );
  }
  if (requested.includes("\0")) {
    throw new PathConfinementError("path contains a NUL byte", "<redacted>");
  }
  if (!isAbsolute(requested)) {
    throw new PathConfinementError(
      "path must be absolute; the local provider does not resolve relative " +
        "paths against an ambient working directory",
      requested,
    );
  }
  if (roots.length === 0) {
    throw new PathConfinementError(
      "no writable root is configured for this session",
      requested,
    );
  }

  const normalized = normalize(requested);
  const { base, tail } = await resolveExistingAncestor(normalized);
  const canonical = await resolveDanglingLinks(base, tail, requested);

  for (const root of roots) {
    if (isUnder(canonical, root)) return canonical;
  }

  throw new PathConfinementError(
    "path resolves outside every directory this session was granted. The " +
      "workspace grant and the session state directory are the only roots the " +
      "Inspector file API will touch.",
    requested,
  );
}
