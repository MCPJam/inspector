/**
 * Deterministic plugin-bundle hashing — Web Crypto, browser- and Node-safe.
 *
 * Reuses the SDK's single portable SHA-256 path (`crypto.subtle`, see
 * `../host-config/hash.ts`) so bundle/component hashes are byte-identical
 * across the inspector (browser + Node) and the Convex backend. NUL bytes are
 * rejected in bundle paths, so `path NUL hash NUL` framing is unambiguous.
 */

import { sha256Hex } from "../host-config/hash.js";
import { stableStringifyJson } from "../widget-runtime/json-utils.js";

export { sha256Hex };

export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as unknown as ArrayBuffer
  );
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** SHA-256 of the deep-key-sorted JSON serialization of `value`. */
export async function hashCanonicalJson(value: unknown): Promise<string> {
  return sha256Hex(stableStringifyJson(value));
}

export interface HashedFileRef {
  /** Canonical (or component-relative) path — must contain no NUL bytes. */
  path: string;
  /** SHA-256 hex of the file's exact bytes. */
  contentHash: string;
}

/**
 * Aggregate hash over a set of files: entries are sorted by code-point path
 * order and framed as `path NUL contentHash NUL`, then hashed. Used for both
 * the bundle hash (all files, canonical paths) and per-skill aggregate hashes
 * (skill-directory-relative paths), so identical content always produces an
 * identical hash regardless of source adapter or listing order.
 */
export async function computeAggregateHash(
  files: HashedFileRef[]
): Promise<string> {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  return sha256Hex(
    sorted.map((file) => `${file.path}\u0000${file.contentHash}\u0000`).join("")
  );
}
