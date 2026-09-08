/**
 * What this machine's CLI remembers between browser commands.
 *
 * Two things, and neither is a secret this file invents:
 *
 *   - the LOCAL COMPUTER CONSENT capability, granted once by a person in the
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
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STORE_VERSION = 1;

export interface StoredBrowserState {
  version: 1;
  /** The device consent capability, as granted in the Inspector UI. */
  consent?: string;
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
      ...(typeof parsed.consent === "string" ? { consent: parsed.consent } : {}),
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
  await writeFile(filePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  // `writeFile`'s mode applies only when it CREATES the file, so an existing
  // one written before this rule tightens up here rather than staying loose.
  await chmod(filePath, 0o600).catch(() => {});
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
