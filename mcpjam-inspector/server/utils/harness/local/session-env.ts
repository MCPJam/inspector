/**
 * The environment a supervised local harness child is given.
 *
 * Built from an ALLOWLIST. `process.env` is never spread, and there is no
 * denylist of secret-looking names — denylists leak on every new variable
 * anyone adds, and the failure is silent.
 *
 * What this buys, precisely: a vendor process cannot pick up the Inspector's
 * own service tokens, cloud credentials, database URLs, or model keys by
 * accident, and it cannot load the user's global agent settings because its
 * `HOME` points at a synthetic config root instead of the real one.
 *
 * What it does NOT buy, and must never be described as buying: containment. A
 * process running as the same OS user can still open the user's real home,
 * read their keychain through OS APIs, and reach the network. In native mode
 * this module is hygiene. The boundary is consent, the vendor's own permission
 * controls, and supervision.
 */
import { posix, win32 } from "node:path";

/**
 * Path flavour follows the TARGET platform, not the host running this code.
 * In production the two are the same; keeping them separate is what lets the
 * Windows shape be tested from a POSIX CI runner instead of being asserted
 * only by reading it.
 */
function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/**
 * Names copied from the parent when present. Values pass through untouched.
 *
 * Exported so a test can lock the list: every addition is a deliberate,
 * reviewed act, and the review question is always "can this name carry a
 * secret, a path into the user's real config, or a way to redirect a lookup?"
 */
export const LOCAL_HARNESS_ENV_ALLOWLIST: readonly string[] = [
  // Locale and terminal shape. Vendor CLIs render differently without these
  // and some refuse to start.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TZ",
  "COLORTERM",
  // Windows needs these for any process to start at all.
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
];

/**
 * `PATH` is built, not inherited.
 *
 * Inheriting it would hand the child every project-local `node_modules/.bin`,
 * shim directory, and version-manager shadow on the user's PATH — the exact
 * "executable found through a mutable PATH" the design rejects. The supervisor
 * launches by absolute path, so the child's PATH exists only for whatever the
 * vendor CLI shells out to internally; a minimal system PATH is the honest
 * floor for that.
 */
const SYSTEM_PATH_POSIX = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

function systemPath(
  platform: NodeJS.Platform,
  base: NodeJS.ProcessEnv,
): string {
  if (platform === "win32") {
    const root = base.SYSTEMROOT ?? base.WINDIR ?? "C:\\Windows";
    return [
      root,
      win32.join(root, "System32"),
      win32.join(root, "System32", "Wbem"),
    ].join(win32.delimiter);
  }
  return SYSTEM_PATH_POSIX.join(posix.delimiter);
}

export interface LocalHarnessEnvOptions {
  /** Synthetic config root handed to the child as HOME. Absolute, owner-only,
   *  inside the session state directory, never the user's real home. */
  syntheticHome: string;
  /** Session working directory (the child's cwd). */
  sessionRoot: string;
  /**
   * Scoped values the session genuinely needs — the loopback bridge token, the
   * model gateway base URL and its per-session capability. Supplied by the
   * supervisor from the parent-side broker, never read from `process.env`.
   *
   * Environment delivery is the FALLBACK, not the design goal: it is visible
   * to anything that can read the child's environment as the same user. Where
   * a vendor accepts a private config file or an inherited descriptor, prefer
   * that (see `configStrategy` in the manifest).
   */
  scoped?: Readonly<Record<string, string>>;
  /**
   * Windows only: the Git Bash the vendor CLI's shell tool runs through.
   * Claude Code on Windows executes Bash commands via Git for Windows and
   * looks for it on PATH — which the child does not have, by design — or in
   * `CLAUDE_CODE_GIT_BASH_PATH`. The provider resolves a real, existing
   * `bash.exe` and names it here; absent, the CLI reports the missing shell
   * itself. Ignored on every other platform.
   */
  gitBashPath?: string;
  platform?: NodeJS.Platform;
  base?: NodeJS.ProcessEnv;
}

/** Names a caller may never inject through `scoped` — they would re-open the
 *  vendor credential fallbacks the gateway exists to replace, or redirect
 *  executable/config lookup. */
const SCOPED_NAME_DENYLIST = new Set([
  // Executable, library, and config resolution.
  "PATH",
  "HOME",
  "USERPROFILE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  // Every generated path this module sets. Scoped values are applied LAST, so
  // without these a caller could overwrite the synthetic config, cache, and
  // temp roots and point the child back at the user's real configuration —
  // undoing the whole reason a synthetic home exists.
  "TMPDIR",
  "TMP",
  "TEMP",
  // Same reason as TMPDIR, and the reason it is set at all: the vendor CLI
  // extracts its native binary here, so a scoped override would put that
  // extraction back outside the session's disposable state.
  "CLAUDE_CODE_TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "PWD",
  // Names the shell the vendor CLI runs commands through. A scoped override
  // would point it at any executable; the provider sets it from a path it
  // has verified exists.
  "CLAUDE_CODE_GIT_BASH_PATH",
]);

export class LocalHarnessEnvError extends Error {}

/**
 * Build the child environment. Deterministic and pure — the supervisor passes
 * it straight to `spawn`, and a test can assert the exact key set.
 */
export function buildLocalHarnessEnv(
  opts: LocalHarnessEnvOptions,
): Record<string, string> {
  const platform = opts.platform ?? process.platform;
  const base = opts.base ?? process.env;
  const path = pathFor(platform);

  if (!path.isAbsolute(opts.syntheticHome)) {
    throw new LocalHarnessEnvError("syntheticHome must be an absolute path");
  }
  if (!path.isAbsolute(opts.sessionRoot)) {
    throw new LocalHarnessEnvError("sessionRoot must be an absolute path");
  }

  const env: Record<string, string> = {};
  for (const name of LOCAL_HARNESS_ENV_ALLOWLIST) {
    const value = base[name];
    if (typeof value === "string" && value.length > 0) env[name] = value;
  }

  env.PATH = systemPath(platform, base);
  env.HOME = opts.syntheticHome;
  env.PWD = opts.sessionRoot;
  // Vendor CLIs write caches and temp files; point every conventional variable
  // at the session's own disposable state so nothing lands in the user's real
  // config and everything is removed with the session.
  env.TMPDIR = path.join(opts.syntheticHome, "tmp");
  // Claude Code's own temp knob, which it honours ahead of `TMPDIR`. It has to
  // be set on the BRIDGE too, not only on the CLI the bridge starts: the SDK
  // extracts its native binary at import time and hardcodes `/tmp` on darwin
  // unless this is present. Without it a session's extraction lands outside
  // the session's disposable state and survives it.
  env.CLAUDE_CODE_TMPDIR = env.TMPDIR;
  env.XDG_CONFIG_HOME = path.join(opts.syntheticHome, ".config");
  env.XDG_CACHE_HOME = path.join(opts.syntheticHome, ".cache");
  env.XDG_DATA_HOME = path.join(opts.syntheticHome, ".local", "share");
  env.XDG_STATE_HOME = path.join(opts.syntheticHome, ".local", "state");
  if (platform === "win32") {
    env.USERPROFILE = opts.syntheticHome;
    env.APPDATA = path.join(opts.syntheticHome, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(opts.syntheticHome, "AppData", "Local");
    env.TEMP = env.TMPDIR;
    env.TMP = env.TMPDIR;
    if (opts.gitBashPath !== undefined) {
      if (!path.isAbsolute(opts.gitBashPath)) {
        throw new LocalHarnessEnvError("gitBashPath must be an absolute path");
      }
      env.CLAUDE_CODE_GIT_BASH_PATH = opts.gitBashPath;
    }
  }
  // Vendor CLIs treat a TTY as permission to draw interactive UI and, in some
  // builds, to prompt. A supervised child has no terminal.
  env.CI = "1";
  env.NO_COLOR = "1";

  for (const [name, value] of Object.entries(opts.scoped ?? {})) {
    if (SCOPED_NAME_DENYLIST.has(name.toUpperCase())) {
      throw new LocalHarnessEnvError(
        `scoped environment entry ${name} is not allowed: it would redirect ` +
          `executable, library, or config resolution for the child`,
      );
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new LocalHarnessEnvError(
        `scoped environment name ${JSON.stringify(name)} is not a valid ` +
          `environment variable name`,
      );
    }
    if (/[\0\n\r]/.test(value)) {
      throw new LocalHarnessEnvError(
        `scoped environment value for ${name} contains a control character`,
      );
    }
    env[name] = value;
  }

  return env;
}

/**
 * Environment names the ADAPTER is allowed to contribute per `spawn`/`run`.
 *
 * The adapters pass the bridge its channel token, its port, and the vendor auth
 * settings through `SandboxProcessOptions.env`. Dropping that would leave the
 * bridge unable to start; forwarding it wholesale would let an adapter set any
 * variable in the child. So the names are enumerated, and everything else the
 * adapter offers is discarded.
 *
 * `HOME` is deliberately absent even though the adapters set it: the session's
 * synthetic home is ours to decide, and we already answer the adapter's `$HOME`
 * probe with it, so an adapter-supplied value can only agree or be wrong.
 */
export const BRIDGE_SUPPLIED_ENV_ALLOWLIST: readonly string[] = [
  // Bridge control channel.
  "BRIDGE_CHANNEL_TOKEN",
  "BRIDGE_WS_PORT",
  "BRIDGE_REPLAY_FROM_DISK",
  // Vendor model endpoints and credentials, as computed by the adapter from
  // the explicit auth Inspector hands it.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "AI_GATEWAY_API_KEY",
  "AI_GATEWAY_BASE_URL",
];

/**
 * Filter an adapter-supplied environment down to the allowlist.
 *
 * Values are not inspected — they are the adapter's to compute — but names
 * outside the list never reach the child, so an adapter change cannot quietly
 * introduce a new variable into a supervised process.
 */
export function filterBridgeSuppliedEnv(
  env: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  if (!env) return filtered;
  for (const name of BRIDGE_SUPPLIED_ENV_ALLOWLIST) {
    const value = env[name];
    if (typeof value === "string" && !/[\0\n\r]/.test(value)) {
      filtered[name] = value;
    }
  }
  return filtered;
}

/**
 * Directories the synthetic home needs before the child starts, so a vendor
 * CLI's first write does not land somewhere unexpected because its target was
 * missing.
 */
export function syntheticHomeDirectories(
  syntheticHome: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const path = pathFor(platform);
  const dirs = [
    syntheticHome,
    path.join(syntheticHome, "tmp"),
    path.join(syntheticHome, ".config"),
    path.join(syntheticHome, ".cache"),
    path.join(syntheticHome, ".local", "share"),
    path.join(syntheticHome, ".local", "state"),
  ];
  if (platform === "win32") {
    dirs.push(
      path.join(syntheticHome, "AppData", "Roaming"),
      path.join(syntheticHome, "AppData", "Local"),
    );
  }
  return dirs;
}
