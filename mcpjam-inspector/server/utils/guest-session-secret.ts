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

export const GUEST_SESSION_SECRET_HEADER = "x-mcpjam-guest-session-secret";

function getLocalGuestSecretDir(): string {
  return process.env.GUEST_JWT_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function getLocalGuestSessionSecretPath(): string {
  return path.join(getLocalGuestSecretDir(), "guest-session-shared-secret.txt");
}

function createAndPersistLocalGuestSessionSecret(): string {
  const secretPath = getLocalGuestSessionSecretPath();
  const dir = path.dirname(secretPath);
  const secret = randomBytes(32).toString("hex");

  mkdirSync(dir, { recursive: true });
  writeFileSync(secretPath, secret, "utf-8");

  try {
    chmodSync(secretPath, 0o600);
  } catch {
    // Best effort. Some platforms/filesystems do not support chmod semantics.
  }

  logger.info(
    `[guest-auth] Created local guest session shared secret at ${secretPath}`,
  );
  return secret;
}

function loadPersistedLocalGuestSessionSecret(): string | null {
  const secretPath = getLocalGuestSessionSecretPath();
  if (!existsSync(secretPath)) {
    return null;
  }

  try {
    const secret = readFileSync(secretPath, "utf-8").trim();
    return secret.length > 0 ? secret : null;
  } catch (error) {
    logger.warn(
      `[guest-auth] Failed to load local guest session shared secret (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

export function getGuestSessionSharedSecret(): string {
  const envSecret = process.env.MCPJAM_GUEST_SESSION_SHARED_SECRET?.trim();
  if (envSecret) {
    return envSecret;
  }

  if (
    process.env.NODE_ENV === "production" ||
    process.env.NODE_ENV === "test"
  ) {
    throw new Error(
      "MCPJAM_GUEST_SESSION_SHARED_SECRET is required for guest session proxying",
    );
  }

  return (
    loadPersistedLocalGuestSessionSecret() ||
    createAndPersistLocalGuestSessionSecret()
  );
}
