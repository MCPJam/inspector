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

// The CLIENT signing key for confidential CIMD (private_key_jwt) — DISTINCT from
// the XAA IdP issuer key (`keypair.ts`). The client proves ownership of the
// public key it publishes in its Client ID Metadata Document by signing a
// `client_assertion` with this private key. EC P-256 (ES256, which the worker
// accepts) is used deliberately: the public point is tiny, so it fits compactly
// in the stateless reflector URL. Node-only (crypto/fs) — never import from the
// browser entry.

/** JWKS `kid` for the confidential-CIMD client key. */
export const XAA_CLIENT_KID = "xaa-client-1";

export type XaaClientJwk = JsonWebKey & {
  kid: string;
  alg: string;
  use: string;
};

let privateKey: KeyObject | undefined;
let publicKey: KeyObject | undefined;
let jwks: { keys: XaaClientJwk[] } | undefined;

function getKeyDir(): string {
  // Share the IdP key dir override so both keys live in one place.
  return process.env.XAA_IDP_KEY_DIR || path.join(os.homedir(), ".mcpjam");
}

function getKeyPaths(): { privatePath: string; publicPath: string } {
  const dir = getKeyDir();
  return {
    privatePath: path.join(dir, "xaa-client-private.pem"),
    publicPath: path.join(dir, "xaa-client-public.pem"),
  };
}

function normalizePrivateKeyPem(raw: string): string {
  const trimmed = raw.trim();
  // Accept a PEM with real newlines, an escaped-newline PEM, or base64-of-PEM.
  if (trimmed.includes("BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  return Buffer.from(trimmed, "base64").toString("utf-8");
}

function setKeyPair(nextPrivate: KeyObject, nextPublic: KeyObject): void {
  privateKey = nextPrivate;
  publicKey = nextPublic;
}

function loadSecretKeyPair(): boolean {
  const raw = process.env.XAA_CLIENT_PRIVATE_KEY;
  if (!raw || raw.trim() === "") return false;
  try {
    const pem = normalizePrivateKeyPem(raw);
    const nextPrivate = createPrivateKey(pem);
    setKeyPair(nextPrivate, createPublicKey(nextPrivate));
    return true;
  } catch {
    return false;
  }
}

function loadPersistedLocalKeyPair(): boolean {
  const { privatePath, publicPath } = getKeyPaths();
  if (!existsSync(privatePath) || !existsSync(publicPath)) return false;
  try {
    const privatePem = readFileSync(privatePath, "utf-8");
    const publicPem = readFileSync(publicPath, "utf-8");
    setKeyPair(createPrivateKey(privatePem), createPublicKey(publicPem));
    return true;
  } catch {
    return false;
  }
}

function createAndPersistLocalKeyPair(): void {
  const { privatePath, publicPath } = getKeyPaths();
  mkdirSync(path.dirname(privatePath), { recursive: true });

  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
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
}

function generateEphemeralKeyPair(): void {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  setKeyPair(pair.privateKey, pair.publicKey);
}

function rebuildJwks(): void {
  if (!publicKey) throw new Error("client key not initialized");
  const exported = publicKey.export({ format: "jwk" });
  jwks = {
    keys: [{ ...exported, kid: XAA_CLIENT_KID, alg: "ES256", use: "sig" }],
  };
}

export function initXaaClientKeyPair(): void {
  if (privateKey && publicKey && jwks) return;
  if (!loadSecretKeyPair() && !loadPersistedLocalKeyPair()) {
    try {
      createAndPersistLocalKeyPair();
    } catch {
      generateEphemeralKeyPair();
    }
  }
  rebuildJwks();
}

export function getXaaClientPrivateKey(): KeyObject {
  if (!privateKey) {
    throw new Error(
      "XAA client key not initialized. Call initXaaClientKeyPair() first.",
    );
  }
  return privateKey;
}

export function getXaaClientJwks(): { keys: XaaClientJwk[] } {
  if (!jwks) {
    throw new Error(
      "XAA client key not initialized. Call initXaaClientKeyPair() first.",
    );
  }
  return jwks;
}

export function resetXaaClientKeyPairForTests(): void {
  privateKey = undefined;
  publicKey = undefined;
  jwks = undefined;
}
