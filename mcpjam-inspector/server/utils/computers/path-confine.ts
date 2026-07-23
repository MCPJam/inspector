/**
 * Shared path confinement for the computer file-API writers (the
 * `/computers/upload` route and the harness sandbox provider). Keeps every
 * writer's destination under the box home (`/home/user`) so none becomes a
 * casual write-anywhere primitive.
 *
 * This is HYGIENE, not a security boundary. Any holder of a computer terminal
 * token can already run arbitrary shell commands in the box (`cat > /etc/x`,
 * `dd`), so the file writers grant no capability the shell doesn't. In
 * particular a symlinked parent (e.g. `/home/user/uploads -> /etc`) would defeat
 * pure string normalization, and defending it would need a per-write `realpath`
 * round-trip into the sandbox — not worth it under the current
 * terminal-token/shell trust model. Revisit with a runtime `realpath` check only
 * if a file writer is ever decoupled from shell access.
 */
import { posix } from "node:path";

/** The box home. Confinement root for every metered file-API writer. */
export const HOME_ROOT = "/home/user";

const DEFAULT_MAX_PATH_LEN = 1024;

/**
 * Confine an absolute path to `/home/user`. Returns the normalized path when it
 * is `/home/user` or a descendant, or `null` when the input is missing, not
 * absolute, over `maxLen`, or escapes the home root (via `..` or a sibling
 * prefix like `/home/user2`). `posix.normalize` collapses `.`/`..` so
 * `/home/user/../etc` resolves to `/etc` and is rejected by the prefix check;
 * the explicit `..` scan is a belt-and-suspenders guard for any residual
 * segment.
 */
export function confineToHome(
  path: string | undefined,
  opts?: { maxLen?: number }
): string | null {
  const maxLen = opts?.maxLen ?? DEFAULT_MAX_PATH_LEN;
  if (!path || path.length > maxLen) return null;
  if (!path.startsWith("/")) return null;
  const normalized = posix.normalize(path).replace(/\/+$/, "") || "/";
  if (normalized !== HOME_ROOT && !normalized.startsWith(`${HOME_ROOT}/`)) {
    return null;
  }
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/**
 * The single working-directory contract for a computer (COMP-16). One
 * `hostConfig.computer.workdir` governs WHERE commands run on the box —
 * honored identically by the chat `bash` tool, the harness Shell, and the web
 * terminal PTY, rather than three competing settings.
 *
 * Resolution:
 *   - absent / blank ⇒ `{ workdir: undefined }` — use the box default (`$HOME`,
 *     i.e. `/home/user`); callers that need an explicit path use `?? HOME_ROOT`.
 *   - present ⇒ must `confineToHome`; a value that escapes (`..`, `/etc`, a
 *     sibling like `/home/user2`) returns `{ error }` with a clear message the
 *     caller surfaces, instead of silently running somewhere unexpected.
 *
 * This is the server-side confinement the COMP-16 acceptance criteria require;
 * the host-config UI validates the same rule for immediate feedback, but the
 * exec-time check here is the authoritative one (a value can reach exec from an
 * older client, the API, or a hand-edited host config).
 */
export function resolveWorkingDirectory(
  raw: string | undefined
): { workdir: string | undefined } | { error: string } {
  if (raw === undefined || raw.trim() === "") {
    return { workdir: undefined };
  }
  const confined = confineToHome(raw);
  if (!confined) {
    return {
      error:
        `Working directory "${raw}" must resolve under ${HOME_ROOT} ` +
        `(no "..", absolute escapes like /etc, or sibling prefixes).`,
    };
  }
  return { workdir: confined };
}
