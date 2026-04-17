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
import { XAA_IDP_KID } from "../../shared/xaa.js";

export type XAAIdpJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

let privateKey: KeyObject | undefined;
let publicKey: KeyObject | undefined;
let jwks: { keys: XAAIdpJwk[] } | undefined;

function getLocalXAAKeyDir(): string {
  return process.env.XAA_IDP_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function getLocalXAAKeyPaths(): { privatePath: string; publicPath: string } {
  const dir = getLocalXAAKeyDir();
  return {
    privatePath: path.join(dir, "xaa-idp-private.pem"),
    publicPath: path.join(dir, "xaa-idp-public.pem"),
  };
}

function setKeyPair(nextPrivateKey: KeyObject, nextPublicKey: KeyObject): void {
  privateKey = nextPrivateKey;
  publicKey = nextPublicKey;
}

function createAndPersistLocalKeyPair(): void {
  const { privatePath, publicPath } = getLocalXAAKeyPaths();
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
    // Best effort for filesystems without chmod semantics.
  }

  setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
  logger.info(`XAA issuer: created signing key pair at ${dir}`);
}

function loadPersistedLocalKeyPair(): boolean {
  const { privatePath, publicPath } = getLocalXAAKeyPaths();
  if (!existsSync(privatePath) || !existsSync(publicPath)) {
    return false;
  }

  try {
    const privatePem = readFileSync(privatePath, "utf-8");
    const publicPem = readFileSync(publicPath, "utf-8");
    setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
    logger.info(
      `XAA issuer: using signing key pair from ${path.dirname(privatePath)}`,
    );
    return true;
  } catch (error) {
    logger.warn(
      `XAA issuer: failed to load signing key pair, regenerating (${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}

function generateEphemeralKeyPair(): void {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  setKeyPair(pair.privateKey, pair.publicKey);
  logger.warn(
    "XAA issuer: falling back to ephemeral signing keys; assertions will change after restart.",
  );
}

function rebuildJwks(): void {
  const exportedPublicKey = getXAAIdpPublicKeyObjectOrThrow().export({
    format: "jwk",
  });

  jwks = {
    keys: [
      {
        ...exportedPublicKey,
        kid: XAA_IDP_KID,
        alg: "RS256",
        use: "sig",
      },
    ],
  };
}

export function initXAAIdpKeyPair(): void {
  if (privateKey && publicKey && jwks) {
    return;
  }

  if (!loadPersistedLocalKeyPair()) {
    try {
      createAndPersistLocalKeyPair();
    } catch (error) {
      logger.warn(
        `XAA issuer: failed to persist signing key pair, using ephemeral keys (${error instanceof Error ? error.message : String(error)})`,
      );
      generateEphemeralKeyPair();
    }
  }

  rebuildJwks();
}

export function getXAAIssuerUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/xaa") ? normalized : `${normalized}/xaa`;
}

export function getXAAIdpPrivateKey(): KeyObject {
  if (!privateKey) {
    throw new Error(
      "XAA issuer keys not initialized. Call initXAAIdpKeyPair() first.",
    );
  }

  return privateKey;
}

export function getXAAIdpPublicKeyObject(): KeyObject {
  return getXAAIdpPublicKeyObjectOrThrow();
}

export function getXAAIdpJwks(): { keys: XAAIdpJwk[] } {
  if (!jwks) {
    throw new Error(
      "XAA issuer keys not initialized. Call initXAAIdpKeyPair() first.",
    );
  }

  return jwks;
}

function getXAAIdpPublicKeyObjectOrThrow(): KeyObject {
  if (!publicKey) {
    throw new Error(
      "XAA issuer keys not initialized. Call initXAAIdpKeyPair() first.",
    );
  }

  return publicKey;
}

export function resetXAAIdpKeyPairForTests(): void {
  privateKey = undefined;
  publicKey = undefined;
  jwks = undefined;
}
