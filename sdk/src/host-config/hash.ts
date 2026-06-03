/**
 * HostConfig v2 content hash — Web Crypto, ASYNC.
 *
 * Uses `crypto.subtle` (available in the browser, Node >= 20, and the Convex
 * isolate), so this is the single portable hashing path. There is
 * deliberately NO synchronous variant: the backend mirror is already async
 * (`convex/lib/keys.ts:sha256Hex` + `computeHostConfigHashV2`), so SDK and
 * backend stay byte-identical with zero call-site divergence. If a sync need
 * ever arises, add an explicit `*Sync` API backed by a vendored SHA-256
 * rather than making the default ambiguous.
 */

import { canonicalizeHostConfigV2 } from "./canonicalize.js";
import type { HostConfigInputV2 } from "./types.js";

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

/**
 * Canonicalize `input` and return the sha256 of its canonical JSON. This is
 * the content-address used to dedupe persisted host-config rows; the backend
 * recomputes the same value to integrity-check client-supplied configs.
 */
export async function computeHostConfigHashV2(
  input: HostConfigInputV2,
): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalizeHostConfigV2(input)));
}
