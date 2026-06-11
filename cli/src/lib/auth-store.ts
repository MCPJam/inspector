import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename, join } from "node:path";
import { operationalError } from "./output.js";

const AUTH_STORE_VERSION = 1;

/**
 * Stored MCPJam platform login (`mcpjam login`). Tokens are AuthKit-issued;
 * `tokenEndpoint`/`clientId` are kept so refresh works without re-fetching
 * the hosted auth config.
 */
export interface StoredPlatformAuth {
  version: 1;
  issuer: string;
  clientId: string;
  tokenEndpoint: string;
  accessToken: string;
  refreshToken?: string;
  /** Access-token expiry, milliseconds since epoch. */
  expiresAt?: number;
}

export interface AuthStorePathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDirectory?: string;
}

/**
 * XDG-aware credentials path: `$XDG_CONFIG_HOME/mcpjam/auth.json` (or
 * `~/.config/...`) on POSIX, `%APPDATA%\mcpjam\auth.json` on Windows —
 * mirrors getUpdateCacheDir in update-notifier.ts.
 */
export function getAuthFilePath(options: AuthStorePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();

  // Explicit override for CI and tests.
  if (env.MCPJAM_AUTH_FILE) {
    return env.MCPJAM_AUTH_FILE;
  }

  if (platform === "win32") {
    return join(
      env.APPDATA || join(homeDirectory, "AppData", "Roaming"),
      "mcpjam",
      "auth.json",
    );
  }

  return join(
    env.XDG_CONFIG_HOME || join(homeDirectory, ".config"),
    "mcpjam",
    "auth.json",
  );
}

export function readStoredAuth(filePath: string): StoredPlatformAuth | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  if (
    record.version !== AUTH_STORE_VERSION ||
    typeof record.issuer !== "string" ||
    typeof record.clientId !== "string" ||
    typeof record.tokenEndpoint !== "string" ||
    typeof record.accessToken !== "string"
  ) {
    return null;
  }

  return {
    version: AUTH_STORE_VERSION,
    issuer: record.issuer,
    clientId: record.clientId,
    tokenEndpoint: record.tokenEndpoint,
    accessToken: record.accessToken,
    ...(typeof record.refreshToken === "string"
      ? { refreshToken: record.refreshToken }
      : {}),
    ...(typeof record.expiresAt === "number"
      ? { expiresAt: record.expiresAt }
      : {}),
  };
}

/** Atomic write (tmp + rename) with 0600, matching writeCredentialsFile. */
export async function writeStoredAuth(
  contents: StoredPlatformAuth,
  filePath: string,
): Promise<string> {
  const directory = dirname(filePath);
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );

  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(contents, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw operationalError(`Failed to write credentials to "${filePath}".`, {
      source: error instanceof Error ? error.message : String(error),
    });
  }

  return filePath;
}

export async function clearStoredAuth(filePath: string): Promise<boolean> {
  const existed = readStoredAuth(filePath) !== null;
  await rm(filePath, { force: true });
  return existed;
}
