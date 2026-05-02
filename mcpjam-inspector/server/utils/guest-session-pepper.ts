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

function getLocalPepperDir(): string {
  return process.env.GUEST_JWT_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function getLocalPepperPath(): string {
  return path.join(getLocalPepperDir(), "guest-session-hash-pepper.txt");
}

function createAndPersistLocalPepper(): string {
  const pepperPath = getLocalPepperPath();
  const dir = path.dirname(pepperPath);
  const pepper = randomBytes(32).toString("hex");

  mkdirSync(dir, { recursive: true });
  writeFileSync(pepperPath, pepper, "utf-8");

  try {
    chmodSync(pepperPath, 0o600);
  } catch {
    // Best effort. Some platforms/filesystems do not support chmod semantics.
  }

  logger.info(
    `[guest-auth] Created local guest session hash pepper at ${pepperPath}`,
  );
  return pepper;
}

function loadPersistedLocalPepper(): string | null {
  const pepperPath = getLocalPepperPath();
  if (!existsSync(pepperPath)) {
    return null;
  }

  try {
    const pepper = readFileSync(pepperPath, "utf-8").trim();
    return pepper.length > 0 ? pepper : null;
  } catch (error) {
    logger.warn(
      `[guest-auth] Failed to load local guest session hash pepper (${error instanceof Error ? error.message : String(error)})`,
    );
    return null;
  }
}

export function getGuestSessionHashPepper(): string {
  const envPepper = process.env.GUEST_SESSION_HASH_PEPPER?.trim();
  if (envPepper) {
    return envPepper;
  }

  if (
    process.env.NODE_ENV === "production" ||
    process.env.NODE_ENV === "test"
  ) {
    throw new Error(
      "GUEST_SESSION_HASH_PEPPER is required for guest session hashing",
    );
  }

  return loadPersistedLocalPepper() || createAndPersistLocalPepper();
}
