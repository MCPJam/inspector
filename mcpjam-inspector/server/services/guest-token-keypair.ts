import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import os from "os";
import path from "path";
import { logger } from "../utils/logger.js";

export const GUEST_TOKEN_TTL_S = 24 * 60 * 60;
export const GUEST_ISSUER = "https://api.mcpjam.com/guest";
export const GUEST_KID = "guest-1";

export type GuestJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

let privateKey: KeyObject | undefined;
let publicKey: KeyObject | undefined;
let jwks: { keys: GuestJwk[] } | undefined;

function getLocalGuestKeyDir(): string {
  return process.env.GUEST_JWT_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function getLocalGuestKeyPaths(): { privatePath: string; publicPath: string } {
  const dir = getLocalGuestKeyDir();
  return {
    privatePath: path.join(dir, "guest-jwt-private.pem"),
    publicPath: path.join(dir, "guest-jwt-public.pem"),
  };
}

function setKeyPair(nextPrivateKey: KeyObject, nextPublicKey: KeyObject): void {
  privateKey = nextPrivateKey;
  publicKey = nextPublicKey;
}

function createAndPersistLocalDevKeyPair(): void {
  const { privatePath, publicPath } = getLocalGuestKeyPaths();
  const dir = path.dirname(privatePath);
  mkdirSync(dir, { recursive: true });

  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
  const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });

  writeFileSync(privatePath, privatePem);
  writeFileSync(publicPath, publicPem);

  try {
    chmodSync(privatePath, 0o600);
    chmodSync(publicPath, 0o644);
  } catch {
    // Best effort. Some platforms/filesystems do not support chmod semantics.
  }

  setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
  logger.info(`Guest JWT: created local dev signing key pair at ${dir}`);
}

function loadPersistedLocalDevKeyPair(): boolean {
  const { privatePath, publicPath } = getLocalGuestKeyPaths();
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    return false;
  }

  try {
    const privatePem = readFileSync(privatePath, "utf-8");
    const publicPem = readFileSync(publicPath, "utf-8");
    setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
    logger.info(
      `Guest JWT: using local dev signing key pair from ${path.dirname(privatePath)}`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `Guest JWT: failed to load local dev key pair, regenerating (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

function warnAboutEphemeralKeys(reason: "missing" | "invalid"): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const baseMessage =
    "Guest JWT: using ephemeral signing keys in production. " +
    "Guest sessions will be invalid after restart unless " +
    "GUEST_JWT_PRIVATE_KEY and GUEST_JWT_PUBLIC_KEY are set.";

  if (reason === "invalid") {
    logger.warn(
      `${baseMessage} Falling back because the configured key pair could not be parsed.`,
    );
    return;
  }

  logger.warn(`${baseMessage} Falling back because the env vars are missing.`);
}

function generateEphemeralKeyPair(): void {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  setKeyPair(pair.privateKey, pair.publicKey);
}

export function initGuestTokenSecret(): void {
  const envPrivate = process.env.GUEST_JWT_PRIVATE_KEY;
  const envPublic = process.env.GUEST_JWT_PUBLIC_KEY;

  if (envPrivate && envPublic) {
    try {
      setKeyPair(createPrivateKey(envPrivate), createPublicKey(envPublic));
      logger.info("Guest JWT: using keys from environment");
    } catch {
      logger.warn("Guest JWT: failed to parse env key pair");
      if (process.env.NODE_ENV !== "production") {
        if (!loadPersistedLocalDevKeyPair()) {
          createAndPersistLocalDevKeyPair();
        }
      } else {
        warnAboutEphemeralKeys("invalid");
        generateEphemeralKeyPair();
      }
    }
  } else if (process.env.NODE_ENV !== "production") {
    if (!loadPersistedLocalDevKeyPair()) {
      createAndPersistLocalDevKeyPair();
    }
  } else {
    warnAboutEphemeralKeys("missing");
    generateEphemeralKeyPair();
  }

  const exportedPublicKey = getGuestPublicKeyObjectOrThrow().export({
    format: "jwk",
  });
  jwks = {
    keys: [
      {
        ...exportedPublicKey,
        kid: GUEST_KID,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

export function getGuestPrivateKeyObjectOrThrow(): KeyObject {
  if (!privateKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }
  return privateKey;
}

export function getGuestPublicKeyObject(): KeyObject | undefined {
  return publicKey;
}

export function getGuestJwks(): { keys: GuestJwk[] } {
  if (!jwks) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }
  return jwks;
}

export function getGuestIssuer(): string {
  return GUEST_ISSUER;
}

export function getGuestPublicKeyPem(): string {
  return getGuestPublicKeyObjectOrThrow().export({
    type: "spki",
    format: "pem",
  }) as string;
}

function getGuestPublicKeyObjectOrThrow(): KeyObject {
  if (!publicKey) {
    throw new Error(
      "Guest JWT keys not initialized. Call initGuestTokenSecret() first.",
    );
  }
  return publicKey;
}

export function getGuestPrivateKeyPem(): string {
  return getGuestPrivateKeyObjectOrThrow().export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}
