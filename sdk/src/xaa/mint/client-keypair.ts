import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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

/** The client key MUST be EC P-256 so it maps to the ES256 JWKS/assertion the
 * RAS validates; an RSA/Ed25519/other-curve key would silently break redemption. */
function isP256PrivateKey(key: KeyObject): boolean {
  return (
    key.asymmetricKeyType === "ec" &&
    key.asymmetricKeyDetails?.namedCurve === "prime256v1"
  );
}

function loadSecretKeyPair(): boolean {
  const raw = process.env.XAA_CLIENT_PRIVATE_KEY;
  if (!raw || raw.trim() === "") return false;
  try {
    const pem = normalizePrivateKeyPem(raw);
    const nextPrivate = createPrivateKey(pem);
    if (!isP256PrivateKey(nextPrivate)) return false;
    setKeyPair(nextPrivate, createPublicKey(nextPrivate));
    return true;
  } catch {
    return false;
  }
}

function loadPersistedLocalKeyPair(): boolean {
  const { privatePath } = getKeyPaths();
  if (!existsSync(privatePath)) return false;
  try {
    const nextPrivate = createPrivateKey(readFileSync(privatePath, "utf-8"));
    if (!isP256PrivateKey(nextPrivate)) return false;
    // Derive the public key from the private key rather than trusting a separate
    // public PEM: a corrupted/edited/backup-restored public file (or a partial
    // read racing a concurrent first-run write) can never desync the published
    // JWKS from the signing key.
    setKeyPair(nextPrivate, createPublicKey(nextPrivate));
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

  // Create the private file 0600 at open time — not a best-effort chmod after
  // the write — so a local user can't capture it during a permissive-umask
  // window. The public PEM is written for human inspection only; load derives
  // the public key from the private key, so the two can never mismatch.
  writeFileSync(privatePath, privatePem, { mode: 0o600 });
  writeFileSync(publicPath, publicPem);

  setKeyPair(pair.privateKey, pair.publicKey);
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
