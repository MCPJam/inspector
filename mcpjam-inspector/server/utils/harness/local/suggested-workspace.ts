/**
 * The folder to offer as a starting point, and why it is never guessed.
 *
 * ── The one value this reads, and the one it refuses to ──────────────────
 * `MCPJAM_LAUNCH_WORKSPACE`, set by `bin/launch-workspace.mjs` from the
 * directory the user ran `npx @mcpjam/inspector` in. Nothing else — and
 * emphatically not `process.cwd()`, which by the time the server is running is
 * the installed package's own root (`bin/start.js` spawns it with
 * `cwd: projectRoot`). Suggesting `.../node_modules/@mcpjam/inspector` as the
 * folder an agent will work in is worse than suggesting nothing: it is a real
 * directory that looks plausible in a dialog and is never what the user meant.
 *
 * So a deployment that does not deliberately pass the variable gets `null`,
 * and the dialog asks. That covers the dev server (`npm run dev:server`,
 * whose cwd is the Inspector checkout), a programmatic embed, and anything
 * else nobody thought about — all of which should ask rather than guess.
 *
 * ── Electron ─────────────────────────────────────────────────────────────
 * Explicitly `null`. The desktop app has a native directory picker running in
 * its main process, which is a deliberate choice by the user; an ambient
 * suggestion alongside it would be a second, worse answer to a question
 * already being asked properly.
 *
 * ── Validated, not just read ─────────────────────────────────────────────
 * Through the same `validateWorkspaceCandidate` that a registration uses, so a
 * suggestion and a registration cannot disagree about what is acceptable.
 * Offering a folder the server would then refuse — the home directory, say —
 * is a worse first impression than offering nothing. Nothing is WRITTEN: this
 * is a read, and a grant is minted only when the user acts.
 */
import { validateWorkspaceCandidate } from "./grants.js";

export interface SuggestedWorkspace {
  /** Tilde-shortened for display. The absolute path never leaves the server. */
  displayRoot: string;
  /** The canonical path, for the server's own use. Never serialized. */
  canonicalPath: string;
}

/**
 * The launch workspace, if this server was deliberately told about one and it
 * still validates.
 */
export async function resolveSuggestedWorkspace(args: {
  env?: NodeJS.ProcessEnv;
  displayRoot: (canonicalPath: string) => string;
}): Promise<SuggestedWorkspace | null> {
  const env = args.env ?? process.env;
  if (env.ELECTRON_APP === "true") return null;
  const raw = env.MCPJAM_LAUNCH_WORKSPACE;
  if (typeof raw !== "string" || raw.trim().length === 0) return null;

  const candidate = await validateWorkspaceCandidate(raw.trim());
  if (!candidate.ok) return null;
  return {
    canonicalPath: candidate.canonicalPath,
    displayRoot: args.displayRoot(candidate.canonicalPath),
  };
}
