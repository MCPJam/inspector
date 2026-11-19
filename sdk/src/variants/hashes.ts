/**
 * The variant contract's hashes: lowercase hex SHA-256 of canonical JSON.
 *
 * Both primitives are the SDK's existing portable ones. `canonicalJson` sorts
 * object keys recursively with the default string sort, keeps arrays in
 * order, drops keys whose value is `undefined` and writes no whitespace.
 * `sha256Hex` goes through `crypto.subtle`, so it runs in Node, Workers and
 * Convex. The backend hand-mirrors both, and the parity vectors pin them.
 */

import { canonicalJson } from "../contract/canonical.js";
import { sha256Hex } from "../host-config/hash.js";
import type { VariantEdit } from "./types.js";

export { canonicalJson, sha256Hex };

/** One Tool object, exactly as the base returned it. */
export function computeToolHash(tool: object): Promise<string> {
  return sha256Hex(canonicalJson(tool));
}

/** `baseSurfaceHash`: the tools of every `tools/list` page, concatenated in order. */
export function computeSurfaceHash(tools: readonly object[]): Promise<string> {
  return sha256Hex(canonicalJson({ tools }));
}

/** `editsHash`: the edits in the order given. */
export function computeEditsHash(
  edits: readonly VariantEdit[]
): Promise<string> {
  return sha256Hex(canonicalJson(edits));
}

/** `contentHash`: what makes two variants the same variant. */
export function computeContentHash(parts: {
  baseServerId: string;
  baseSurfaceHash: string;
  editsHash: string;
}): Promise<string> {
  const { baseServerId, baseSurfaceHash, editsHash } = parts;
  return sha256Hex(canonicalJson({ baseServerId, baseSurfaceHash, editsHash }));
}
