/**
 * Model-facing aliases for WebMCP page tools.
 *
 * A page may register a tool called anything at all, while a model-facing name
 * must satisfy `^[a-zA-Z0-9_-]{1,64}$` (enforced for Anthropic and Bedrock in
 * `chat-v2-orchestration`). Rather than mangle page names into that charset —
 * which collides, and produces names that mean nothing — every tool gets an
 * opaque `page_<8hex>` alias, and the real `toolKey` travels alongside it for
 * dispatch.
 *
 * Same idea as the SEP-1865 app-tool alias in
 * `widget-react/src/app-tools-registry.ts`, but computed synchronously: the
 * chat transport builds its request body synchronously at POST time, and an
 * async digest there would mean caching the snapshot and keeping it in step
 * with a tool registry that changes whenever the page does. The alias only has
 * to be deterministic, charset-safe and unlikely to collide within one page's
 * tools — it hides nothing, so a non-cryptographic hash is the right tool.
 */
import type { PageToolSnapshotEntry } from "@/shared/chat-v2";
import type { WebMcpToolDescriptor } from "@/shared/webmcp-inspector-protocol";

/**
 * FNV-1a, 32-bit, run twice over the preimage with different offsets to fill
 * eight hex characters.
 */
function fnv1a(input: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    // The classic FNV prime, as the shift-and-add form that stays in 32 bits.
    hash +=
      (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return hash >>> 0;
}

function hex8(input: string): string {
  const high = fnv1a(input, 0x811c9dc5);
  const low = fnv1a(input, 0x01000193);
  return (
    high.toString(16).padStart(8, "0").slice(0, 4) +
    low.toString(16).padStart(8, "0").slice(0, 4)
  );
}

/**
 * Deterministic in (sessionId, toolKey), so the same tool keeps its alias
 * across turns — a transcript that references `page_1a2b3c4d` still means
 * something on the next turn, and after a reconnect.
 */
export function pageToolAlias(
  sessionId: string,
  toolKey: string,
  salt = 0,
): string {
  const separator = String.fromCharCode(0);
  const preimage = `${sessionId}${separator}${toolKey}${separator}${salt}`;
  return `page_${hex8(preimage)}`;
}

/**
 * Snapshot the page's tools for one chat turn.
 *
 * Descriptions and schemas pass through as the page wrote them: the server
 * bounds their size, and the model is told which origin each came from so
 * page-authored text is never mistaken for MCPJam's own.
 */
export function buildPageToolSnapshot(
  sessionId: string | undefined,
  tools: readonly WebMcpToolDescriptor[],
): PageToolSnapshotEntry[] {
  if (!sessionId || tools.length === 0) return [];
  const entries: PageToolSnapshotEntry[] = [];
  const used = new Set<string>();
  for (const tool of tools) {
    let alias = pageToolAlias(sessionId, tool.toolKey);
    // Two tools sharing an alias would silently route one call to the other,
    // so re-roll rather than trust the hash.
    for (let salt = 1; used.has(alias) && salt < 16; salt += 1) {
      alias = pageToolAlias(sessionId, tool.toolKey, salt);
    }
    if (used.has(alias)) continue;
    used.add(alias);
    entries.push({
      alias,
      sessionId,
      toolKey: tool.toolKey,
      rawName: tool.name,
      origin: tool.origin,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
  }
  return entries;
}
