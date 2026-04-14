import { constants as fsConstants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { AuthError, type Credentials } from "./types.js";

const CONFIG_FILE_NAME = "config.json";
const CONFIG_VERSION = 1;

/** On-disk schema. `defaultProfile` is the one `getCredentials()` resolves when no name is passed. */
export interface ConfigFile {
  version: 1;
  defaultProfile?: string;
  profiles: Record<string, Credentials>;
}

/**
 * Returns the directory where credentials are stored. Respects
 * `MCPJAM_CONFIG_DIR` for XDG-style overrides (tests, ephemeral env, CI).
 */
export function resolveConfigDir(): string {
  const override = process.env.MCPJAM_CONFIG_DIR;
  if (override && override.length > 0) {
    return override;
  }
  return join(homedir(), ".mcpjam");
}

export function resolveConfigPath(): string {
  return join(resolveConfigDir(), CONFIG_FILE_NAME);
}

function emptyConfig(): ConfigFile {
  return { version: CONFIG_VERSION, profiles: {} };
}

/**
 * Reads the on-disk config. Returns an empty scaffold if the file is missing.
 * Warns (but does not throw) when the file permissions are too open — the
 * user's next write will tighten them back to 0600 automatically.
 */
export async function readConfig(): Promise<ConfigFile> {
  const path = resolveConfigPath();
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return emptyConfig();
    }
    throw new AuthError(
      "INVALID_CONFIG",
      `Failed to read config at ${path}: ${err?.message ?? String(err)}`,
      err,
    );
  }

  // Best-effort permission audit — non-fatal on Windows where mode bits differ.
  try {
    const stat = await fs.stat(path);
    const mode = stat.mode & 0o777;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      process.emitWarning(
        `mcpjam: credentials file ${path} is accessible by other users ` +
          `(mode ${mode.toString(8)}); run \`mcpjam login\` again to retighten.`,
        "SecurityWarning",
      );
    }
  } catch {
    // stat failure is not fatal — fall through to parsing.
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw new AuthError(
      "INVALID_CONFIG",
      `Config at ${path} is not valid JSON: ${err?.message ?? String(err)}`,
      err,
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as any).version !== CONFIG_VERSION ||
    typeof (parsed as any).profiles !== "object"
  ) {
    throw new AuthError(
      "INVALID_CONFIG",
      `Config at ${path} has an unexpected shape; remove it or re-run login.`,
    );
  }

  return parsed as ConfigFile;
}

/**
 * Persists the config with `0600` perms on the file and `0700` on the
 * parent directory. Writes happen via a rename-through-tempfile so partial
 * failures never leave a truncated file behind.
 */
export async function writeConfig(config: ConfigFile): Promise<void> {
  const dir = resolveConfigDir();
  const path = resolveConfigPath();

  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir honours `mode` only when creating; re-apply for existing dirs.
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Non-fatal on platforms that don't support chmod (e.g. Windows).
  }

  const tempPath = `${path}.${process.pid}.tmp`;
  const body = JSON.stringify({ ...config, version: CONFIG_VERSION }, null, 2);
  await fs.writeFile(tempPath, body, { mode: 0o600, flag: "w" });
  try {
    await fs.chmod(tempPath, 0o600);
  } catch {
    // ignore (Windows)
  }
  await fs.rename(tempPath, path);
  try {
    await fs.chmod(path, 0o600);
  } catch {
    // ignore (Windows)
  }
}

export async function setProfile(
  profile: string,
  credentials: Credentials,
  options: { makeDefault?: boolean } = {},
): Promise<void> {
  const current = await readConfig();
  current.profiles[profile] = credentials;
  if (
    options.makeDefault ||
    !current.defaultProfile ||
    !(current.defaultProfile in current.profiles)
  ) {
    current.defaultProfile = profile;
  }
  await writeConfig(current);
}

export async function getProfile(
  profile?: string,
): Promise<{ name: string; credentials: Credentials } | null> {
  const current = await readConfig();
  const name = profile ?? current.defaultProfile;
  if (!name) return null;
  const credentials = current.profiles[name];
  if (!credentials) return null;
  return { name, credentials };
}

export async function removeProfile(profile?: string): Promise<boolean> {
  const current = await readConfig();
  const name = profile ?? current.defaultProfile;
  if (!name || !(name in current.profiles)) return false;
  delete current.profiles[name];
  if (current.defaultProfile === name) {
    const remaining = Object.keys(current.profiles);
    current.defaultProfile = remaining[0];
  }
  await writeConfig(current);
  return true;
}

/** Convenience for tests: delete the entire config file. */
export async function clearConfig(): Promise<void> {
  try {
    await fs.unlink(resolveConfigPath());
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
}

/** Returns `true` when a config file exists on disk (permissions ignored). */
export async function configExists(): Promise<boolean> {
  try {
    await fs.access(resolveConfigPath(), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// Keep `dirname` referenced to silence unused-import pedantry across
// future tsconfig changes; it makes testing overrides easier to wire in.
void dirname;
