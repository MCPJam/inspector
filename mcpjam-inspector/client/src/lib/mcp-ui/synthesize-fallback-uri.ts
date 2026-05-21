/**
 * Build a canonical `ui://` fallback `resourceUri` for a saved view
 * whose source tool did not supply an explicit one.
 *
 * - `serverId` is the immutable Convex id, NOT the display
 *   `serverName`. Server display names can contain spaces, slashes,
 *   and other characters that produce ambiguous URI paths, and can be
 *   renamed.
 * - `toolName` is hashed so any characters that would need escaping
 *   in a URI segment cannot collapse two distinct tools into the same
 *   path.
 * - The result is deterministic — saving the same tool's view on the
 *   same server twice produces the same `resourceUri`, which keeps the
 *   backend's idempotency check happy.
 *
 * The hash matches the server-side helper in
 * `mcpjam-backend/convex/lib/legacyViewUriSynth.ts` so synthesized
 * URIs are predictable across the two sides.
 */
export function synthesizeFallbackResourceUri(input: {
  serverId: string;
  toolName: string;
}): string {
  return `ui://mcpjam/inspector/${input.serverId}/${djb2Hex16(input.toolName)}`;
}

/**
 * Deterministic 64-bit string hash, returned as 16 hex chars.
 * Non-cryptographic but stable across runs and URI-safe.
 */
export function djb2Hex16(input: string): string {
  let h = 5381n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5n) + h + BigInt(input.charCodeAt(i))) & mask;
  }
  return h.toString(16).padStart(16, "0").slice(0, 16);
}
