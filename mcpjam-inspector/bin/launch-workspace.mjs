/**
 * The directory the user invoked `npx @mcpjam/inspector` FROM.
 *
 * ── Why the launcher has to capture this ─────────────────────────────────
 * The server cannot work it out for itself. `bin/start.js` spawns it with
 * `cwd: projectRoot` — the installed package's own directory — so
 * `process.cwd()` on the server side is `.../node_modules/@mcpjam/inspector`,
 * or an npx cache path. Offering that as "the folder Claude Code will work in"
 * would be worse than offering nothing: it is a real directory, it looks
 * plausible in a dialog, and it is never what the user meant.
 *
 * So the invocation folder is read HERE, while the process still has it, and
 * handed to the child explicitly through `MCPJAM_LAUNCH_WORKSPACE`. The server
 * reads only that variable and never falls back to its own `process.cwd()`.
 *
 * ── Why null is a real answer ────────────────────────────────────────────
 * Every rejection below is a case where a suggestion would be wrong rather
 * than merely unhelpful, and the dialog asking is the correct outcome:
 *
 *   - the home directory and the filesystem root are refused by
 *     `registerWorkspaceGrant` anyway, so suggesting one produces a folder the
 *     user picks and the server then rejects;
 *   - a cwd that no longer resolves names nothing;
 *   - the installed package root is what a global-install shell wrapper leaves
 *     behind, and is the exact directory this whole module exists to avoid.
 *
 * Kept as its own ESM module rather than living inside `bin/start.js` so it can
 * be tested: importing `start.js` runs `main()`.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";

/**
 * @param {object} args
 * @param {string} args.projectRoot Installed package root, to reject.
 * @param {string} [args.cwd] Defaults to `process.cwd()`.
 * @param {NodeJS.ProcessEnv} [args.env] Defaults to `process.env`.
 * @returns {string | null} An absolute, canonical directory, or null.
 */
export function launchWorkspaceCandidate(args) {
  const env = args.env ?? process.env;
  // Electron supplies the folder from its own native picker in the main
  // process, which is a deliberate choice by the user rather than an ambient
  // one — so there is nothing to suggest, and suggesting the app bundle's
  // working directory would be actively wrong.
  if (env.ELECTRON_APP === "true") return null;

  let cwd;
  try {
    cwd = realpathSync(args.cwd ?? process.cwd());
  } catch {
    return null;
  }

  let home;
  try {
    home = realpathSync(homedir());
  } catch {
    home = homedir();
  }
  if (cwd === home) return null;
  // `sep` covers POSIX; the drive-root pattern covers `C:\` and `C:/`, which
  // is the same "not a project" answer as `/`.
  if (cwd === sep || cwd === "/") return null;
  if (/^[A-Za-z]:[\\/]?$/.test(cwd)) return null;

  try {
    if (cwd === realpathSync(args.projectRoot)) return null;
  } catch {
    // An unresolvable package root cannot match anything, so the cwd stands.
  }
  return cwd;
}
