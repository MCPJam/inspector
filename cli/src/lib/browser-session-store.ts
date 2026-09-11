/**
 * What this machine's CLI remembers between browser commands.
 *
 * Two things, and neither is a secret this file invents:
 *
 *   - the BROWSER CONSENT capability, granted once by a person in the
 *     Inspector UI. The CLI never mints one. The consent screen exists so a
 *     human authorizes the agent browser explicitly, and a CLI that could mint
 *     its own capability would be that screen's own bypass — so this stores
 *     what a person granted and nothing more.
 *   - the CURRENT SESSION, so `mcpjam browser act` does not need `--session`
 *     on every invocation. Convenience only: an explicit `--session` always
 *     wins, and a stale one produces a plain `no_such_session` rather than
 *     silently acting on some other browser.
 *
 * Stored beside `auth.json` with the same XDG rules and the same 0600, because
 * the consent capability is a credential and a session id names somebody's
 * browsing history.
 */
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";

const STORE_VERSION = 1;

export interface StoredBrowserState {
  version: 1;
  /** The device consent capability, as granted in the Inspector UI. */
  browserConsent?: string;
  /** projectId → the session this CLI last opened for it. */
  sessions?: Record<string, string>;
}

export interface BrowserStorePathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

/** Mirrors `getAuthFilePath`; see that function for the platform rules. */
export function getBrowserStateFilePath(
  options: BrowserStorePathOptions = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();

  if (env.MCPJAM_BROWSER_STATE_FILE) return env.MCPJAM_BROWSER_STATE_FILE;

  if (platform === "win32") {
    return join(
      env.APPDATA || join(homeDirectory, "AppData", "Roaming"),
      "mcpjam",
      "browser.json",
    );
  }
  return join(
    env.XDG_CONFIG_HOME || join(homeDirectory, ".config"),
    "mcpjam",
    "browser.json",
  );
}

export function readBrowserState(filePath: string): StoredBrowserState {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // No file yet is the ordinary first-run state, not a failure.
    return { version: STORE_VERSION };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredBrowserState>;
    return {
      version: STORE_VERSION,
      ...(typeof parsed.browserConsent === "string"
        ? { browserConsent: parsed.browserConsent }
        : {}),
      ...(isSessionMap(parsed.sessions) ? { sessions: parsed.sessions } : {}),
    };
  } catch {
    // A corrupt file reads as empty rather than throwing: the recovery is to
    // grant consent again, and a stack trace would not say so.
    return { version: STORE_VERSION };
  }
}

export async function writeBrowserState(
  filePath: string,
  state: StoredBrowserState,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  // ATOMIC, and 0600 on the TEMPORARY file rather than a chmod afterwards.
  //
  // Two problems with write-then-chmod, both of which this closes. A write
  // interrupted partway leaves `browser.json` as invalid JSON, and the next
  // command reads it as empty — losing the consent capability and every
  // remembered session. And `writeFile`'s own mode applies only when it creates
  // the file, so an existing loose file needed a follow-up `chmod` whose
  // failure was swallowed, leaving a credential readable under its old
  // permissions with nothing to say so.
  //
  // Writing 0600 to a fresh temp file and renaming it into place means the
  // destination is never partially written and never briefly world-readable,
  // and a permission failure is thrown rather than ignored.
  await writeFileAtomic(filePath, JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

/** Remember which session this project's commands should go to. */
export async function rememberSession(
  filePath: string,
  projectId: string,
  sessionId: string,
): Promise<void> {
  const state = readBrowserState(filePath);
  await writeBrowserState(filePath, {
    ...state,
    sessions: { ...(state.sessions ?? {}), [projectId]: sessionId },
  });
}

/**
 * Forget this project's session ONLY IF it is still the one named.
 *
 * `close --session <other>` used to drop the remembered default whatever it
 * closed, so the next command on the project reported no open session while
 * that session was still running. Closing one session is not a statement about
 * another.
 */
export async function forgetSessionIf(
  filePath: string,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  // ONE read-modify-write, not a check followed by a separate delete. Reading,
  // comparing, and then calling `forgetSession` — which re-reads and removes
  // whatever it finds — left a gap in which a concurrent `open` could remember
  // a NEW session and have it deleted anyway: the very failure this exists to
  // prevent, moved down one level.
  //
  // This narrows the window to a single read and write, which is what every
  // other function here does. It is not an inter-process lock; two CLI
  // processes writing this file at the same instant can still lose one
  // another's edit, and the recovery for that is the same as for a corrupt
  // file — pass `--session` explicitly, or open again.
  const state = readBrowserState(filePath);
  if (state.sessions?.[projectId] !== sessionId) return false;
  const sessions = { ...state.sessions };
  delete sessions[projectId];
  await writeBrowserState(filePath, { ...state, sessions });
  return true;
}

export async function forgetSession(
  filePath: string,
  projectId: string,
): Promise<void> {
  const state = readBrowserState(filePath);
  if (!state.sessions?.[projectId]) return;
  const sessions = { ...state.sessions };
  delete sessions[projectId];
  await writeBrowserState(filePath, { ...state, sessions });
}

function isSessionMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every(
      (entry) => typeof entry === "string",
    )
  );
}
