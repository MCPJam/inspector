/**
 * The per-machine Ed25519 key that proves a local model request came from THIS
 * Inspector installation.
 *
 * ── Why an installation needs a key at all ───────────────────────────────
 * A cloud harness lease is never returned to anyone: Convex installs it into
 * the sandbox's egress transform, so holding it is proof of being that box. The
 * local delivery has no box, so the lease IS returned — to this process, which
 * holds it in memory for the length of a turn.
 *
 * That would make it an ordinary bearer token. Anything on the machine that
 * could read this process's memory, or a log that should never have existed,
 * would be able to spend the user's model budget until the lease expired.
 *
 * So the lease is not sufficient on its own. This module holds the private half
 * of a key registered once per machine; every request the gateway forwards
 * carries a signature over that exact request. Stealing the lease gets you
 * nothing without the key, and stealing one signature gets you nothing because
 * it is bound to one method, one path, one timestamp and one nonce.
 *
 * ── Where the private key lives ──────────────────────────────────────────
 * Electron: `safeStorage`, which is the OS keychain. npx: an owner-only file
 * under the harness-local state root, which is the same protection the consent
 * grants and the machine id already have — and the honest ceiling for a Node
 * process with no keychain of its own.
 *
 * The key never leaves this module in either form. `signRequest` takes a
 * request description and returns a header value; there is deliberately no
 * accessor that returns the key itself.
 */
import { createHash, generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger.js";
import { getLocalMachineId, localHarnessStateRoot } from "./grants.js";

/** Version prefix of the signing scheme. Must match the backend verifier. */
const POP_SCHEME_PREFIX = "mcpjam-pop-v1";
const KEY_FILE = "instance-key.json";

/**
 * Optional OS keystore, supplied by the Electron main process.
 *
 * Injected rather than imported so this module stays loadable in the npx
 * server, which has no Electron at all — and so a test can exercise both
 * halves without one.
 */
export interface InstanceKeyStore {
  isAvailable: () => boolean;
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
}

let keystore: InstanceKeyStore | null = null;

export function setInstanceKeyStore(store: InstanceKeyStore | null): void {
  keystore = store;
}

interface StoredKey {
  /** `plain` for the file fallback, `os-keystore` when `safeStorage` wrapped it. */
  protection: "plain" | "os-keystore";
  /** PKCS#8 private key, base64. Encrypted when `protection` is `os-keystore`. */
  privateKey: string;
  /** Raw 32-byte public key, base64url. Registered with the backend. */
  publicKey: string;
  createdAt: number;
}

export interface LocalInstanceIdentity {
  machineId: string;
  /** Raw public key, base64url — the value the backend registers. */
  publicKey: string;
  /** Server-minted key id, once registration has happened. */
  keyId: string | null;
}

interface LoadedInstanceKey {
  machineId: string;
  publicKey: string;
  privateKeyPem: string;
}

/** In-process cache. The key is read from disk once and kept in memory. */
let cached: LoadedInstanceKey | null = null;
let cachedKeyId: string | null = null;
let loading: Promise<LoadedInstanceKey> | null = null;

function keyFilePath(): string {
  return join(localHarnessStateRoot(), KEY_FILE);
}

function toBase64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

/**
 * Load the machine's instance key, minting one on first use.
 *
 * Single-flight: two sessions starting at once must not each generate a key and
 * race to write it, which would leave one of them holding a key the backend
 * never registered.
 */
export async function loadLocalInstanceKey(): Promise<LoadedInstanceKey> {
  if (cached !== null) return cached;
  if (loading !== null) return loading;
  loading = (async (): Promise<LoadedInstanceKey> => {
    const machineId = await getLocalMachineId();
    const path = keyFilePath();
    let stored: StoredKey | null = null;
    try {
      stored = JSON.parse(await readFile(path, "utf8")) as StoredKey;
    } catch {
      stored = null;
    }

    if (stored !== null) {
      try {
        const privateKeyPem = unwrapPrivateKey(stored);
        const loaded: LoadedInstanceKey = {
          machineId,
          publicKey: stored.publicKey,
          privateKeyPem,
        };
        cached = loaded;
        return loaded;
      } catch (error) {
        // A key we cannot unwrap is a key we cannot use. Minting a fresh one is
        // correct and safe: registration rotates the backend's record, and the
        // old key is revoked there rather than left usable.
        logger.warn("[local-harness] instance key unreadable; minting a new one", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ type: "spki", format: "der" });
    // An SPKI Ed25519 key is a 12-byte header followed by the raw 32 bytes.
    // The backend registers the raw form, which is what WebCrypto imports.
    const rawPublic = Buffer.from(raw.subarray(raw.length - 32));
    const privateKeyPem = privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString();

    const next: StoredKey = {
      protection: "plain",
      privateKey: Buffer.from(privateKeyPem).toString("base64"),
      publicKey: toBase64Url(rawPublic),
      createdAt: Date.now(),
    };
    if (keystore !== null && keystore.isAvailable()) {
      next.protection = "os-keystore";
      next.privateKey = keystore.encrypt(privateKeyPem);
    }

    await mkdir(localHarnessStateRoot(), { recursive: true, mode: 0o700 });
    // 0600, and written before anything registers it: a key the backend knows
    // about but this machine cannot read would leave the installation unable to
    // sign for a lease it can obtain.
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });

    const loaded: LoadedInstanceKey = {
      machineId,
      publicKey: next.publicKey,
      privateKeyPem,
    };
    cached = loaded;
    return loaded;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

function unwrapPrivateKey(stored: StoredKey): string {
  if (stored.protection === "os-keystore") {
    if (keystore === null || !keystore.isAvailable()) {
      throw new Error(
        "this instance key is sealed by the OS keystore, which is not available",
      );
    }
    return keystore.decrypt(stored.privateKey);
  }
  return Buffer.from(stored.privateKey, "base64").toString("utf8");
}

/** The identity the availability route and the consent sheet report. */
export async function readLocalInstanceIdentity(): Promise<LocalInstanceIdentity> {
  const key = await loadLocalInstanceKey();
  return {
    machineId: key.machineId,
    publicKey: key.publicKey,
    keyId: cachedKeyId,
  };
}

export function setRegisteredKeyId(keyId: string | null): void {
  cachedKeyId = keyId;
}

export function getRegisteredKeyId(): string | null {
  return cachedKeyId;
}

/**
 * Sign one proxied request, producing the `x-mcpjam-pop` header value.
 *
 * The signing string is newline-delimited and must match the backend's
 * byte for byte:
 *
 *     "mcpjam-pop-v1\n" + METHOD + "\n" + path + "\n" + ts + "\n" + nonce + "\n" + jti
 *
 * Every field is there to stop a specific replay — see the backend's
 * `harnessInstancePop.ts` for which. The nonce is fresh per request, so two
 * identical requests never produce the same header.
 */
export async function signProxiedRequest(args: {
  method: string;
  path: string;
  jti: string;
  nonce: string;
  timestampMs?: number;
}): Promise<string> {
  const key = await loadLocalInstanceKey();
  const timestampMs = args.timestampMs ?? Date.now();
  const signingString = [
    POP_SCHEME_PREFIX,
    args.method.toUpperCase(),
    args.path,
    String(timestampMs),
    args.nonce,
    args.jti,
  ].join("\n");
  const signature = edSign(
    null,
    Buffer.from(signingString, "utf8"),
    key.privateKeyPem,
  );
  return `${timestampMs}.${args.nonce}.${toBase64Url(signature)}`;
}

/**
 * The `jti` of a lease, read from its own payload.
 *
 * The proof of possession is bound to the lease it accompanies, and the lease
 * is a JWT this process holds. Reading the claim locally avoids threading it
 * separately — and a mismatch cannot be forged into anything, because the
 * backend compares against the jti of the lease it verified, not the one we
 * assert.
 */
export function leaseJti(lease: string): string | null {
  const parts = lease.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { jti?: unknown };
    return typeof payload.jti === "string" && payload.jti.length > 0
      ? payload.jti
      : null;
  } catch {
    return null;
  }
}

/**
 * A short, stable fingerprint of the public key, for display and telemetry.
 *
 * The public key itself is not secret, but it is long and meaningless to a
 * reader; the fingerprint is what the consent sheet shows so a user can tell
 * two installations apart.
 */
export function instanceKeyFingerprint(publicKey: string): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, 12);
}

/** Test seam: drop the in-process cache. */
export function resetInstanceKeyCacheForTests(): void {
  cached = null;
  cachedKeyId = null;
  loading = null;
}
