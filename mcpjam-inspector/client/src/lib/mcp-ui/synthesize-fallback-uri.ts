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
 * Pick the canonical `resourceUri` to persist on a saved view.
 *
 * The caller may supply a `candidate` (e.g. `getUIResourceUri()` for
 * the active tool, which for OpenAI-origin tools returns the raw
 * `openai/outputTemplate` value — *any* scheme) and/or a
 * `legacyOutputTemplate` (the explicit OpenAI alias on the save
 * payload). Either field may be missing or non-`ui://`. The chosen
 * URI must be `ui://`-scheme per SEP-1865.
 *
 * Resolution order:
 *   1. Trimmed `candidate` starts with `ui://` → use it.
 *   2. Trimmed `legacyOutputTemplate` starts with `ui://` → use it.
 *   3. Otherwise → return the caller's `fallback`.
 *
 * Without (1) gating on `ui://`, a non-compliant OpenAI template like
 * `https://...` flowed past `useSaveView` straight into the canonical
 * column, bypassing the fallback synth entirely.
 */
export function resolveCanonicalResourceUri(input: {
  candidate: string | undefined;
  legacyOutputTemplate: string | undefined;
  fallback: string;
}): string {
  const trimmedCandidate = input.candidate?.trim();
  if (trimmedCandidate && trimmedCandidate.startsWith("ui://")) {
    return trimmedCandidate;
  }
  const trimmedLegacy = input.legacyOutputTemplate?.trim();
  if (trimmedLegacy && trimmedLegacy.startsWith("ui://")) {
    return trimmedLegacy;
  }
  return input.fallback;
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
