/**
 * The variant contract's hashes: lowercase hex SHA-256 through `crypto.subtle`
 * of canonical JSON (keys sorted, arrays in order, `undefined` dropped, no
 * whitespace). Both are the SDK's existing portable primitives; the backend
 * hand-mirrors them, and the parity vectors pin them.
 */

import { canonicalJson } from "../contract/canonical.js";
import { sha256Hex } from "../host-config/hash.js";
import type { VariantEdit, VariantToolHash } from "./types.js";

export { canonicalJson, sha256Hex };

/**
 * One tool's `name`, `title`, `description` and `inputSchema`, the ones it
 * has. Its `execution`, `outputSchema` and `annotations` are left out: the
 * server SDK shapes them differently for 2025 and 2026 protocol versions, so
 * hashing them would report drift whenever the protocol version changed.
 */
export function computeToolHash(
  tool: Readonly<Record<string, unknown>>
): Promise<string> {
  const { name, title, description, inputSchema } = tool;
  return sha256Hex(canonicalJson({ name, title, description, inputSchema }));
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

/**
 * `contentHash`: what makes two variants the same variant, with `toolHashes`
 * sorted by `tool` in JavaScript's default string order.
 */
export function computeContentHash(parts: {
  baseServerId: string;
  baseSurfaceHash: string;
  editsHash: string;
  toolHashes: readonly VariantToolHash[];
}): Promise<string> {
  const { baseServerId, baseSurfaceHash, editsHash } = parts;
  const toolHashes = parts.toolHashes
    .map(({ tool, hash }) => ({ tool, hash }))
    .sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  return sha256Hex(
    canonicalJson({ baseServerId, baseSurfaceHash, editsHash, toolHashes })
  );
}
