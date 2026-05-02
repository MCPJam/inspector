import { randomBytes } from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger.js";

export interface LocalSecretSpec {
  /** Filename inside the local secrets directory. */
  fileName: string;
  /** Environment variable that, when set, takes precedence over the local file. */
  envVar: string;
  /** Error thrown in production/test when the env var is missing. */
  productionErrorMessage: string;
  /** Human-readable label used in log messages (e.g. "guest session shared secret"). */
  label: string;
}

function getLocalSecretDir(): string {
  return process.env.GUEST_JWT_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function persistLocalSecret(spec: LocalSecretSpec): string {
  const filePath = path.join(getLocalSecretDir(), spec.fileName);
  const value = randomBytes(32).toString("hex");

  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, value, "utf-8");

  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best effort. Some platforms/filesystems do not support chmod semantics.
  }

  logger.info(`[guest-auth] Created local ${spec.label} at ${filePath}`);
  return value;
}

function loadPersistedLocalSecret(spec: LocalSecretSpec): string | null {
  const filePath = path.join(getLocalSecretDir(), spec.fileName);
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const value = readFileSync(filePath, "utf-8").trim();
    return value.length > 0 ? value : null;
  } catch (error) {
    logger.warn(
      `[guest-auth] Failed to load local ${spec.label} (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

/**
 * Resolve a server-side secret with this precedence:
 *   1. Trimmed value of `spec.envVar` if set.
 *   2. In production/test: throw `spec.productionErrorMessage`.
 *   3. In dev: load the persisted file at `~/.mcpjam/<fileName>`, or
 *      generate, persist, and return a fresh 32-byte hex value.
 */
export function getOrCreateLocalSecret(spec: LocalSecretSpec): string {
  const envValue = process.env[spec.envVar]?.trim();
  if (envValue) {
    return envValue;
  }

  if (
    process.env.NODE_ENV === "production" ||
    process.env.NODE_ENV === "test"
  ) {
    throw new Error(spec.productionErrorMessage);
  }

  return loadPersistedLocalSecret(spec) || persistLocalSecret(spec);
}
