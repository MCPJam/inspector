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
// The SAME digest the daemon and the server use for declared tools. It moved
// there when the agent browser needed it too: three copies of one hash is
// three chances for the client to compute a name the server never minted.
import { declaredToolHex8 as hex8 } from "@/shared/declared-tools";

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
 * Snapshot the page's bound registrations for one chat turn.
 *
 * A new registration gets a new alias; an approval cannot move with a stable
 * display key to the replacement tool. Descriptions and schemas pass through: the server
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
    if (!tool.binding) continue;
    const identity = `${tool.toolKey}\u0000${JSON.stringify(tool.binding)}`;
    let alias = pageToolAlias(sessionId, identity);
    // Two tools sharing an alias would silently route one call to the other,
    // so re-roll rather than trust the hash.
    for (let salt = 1; used.has(alias) && salt < 16; salt += 1) {
      alias = pageToolAlias(sessionId, identity, salt);
    }
    if (used.has(alias)) continue;
    used.add(alias);
    entries.push({
      alias,
      binding: structuredClone(tool.binding),
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
