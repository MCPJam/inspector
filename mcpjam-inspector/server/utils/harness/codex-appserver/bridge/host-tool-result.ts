/** Shape a host tool's return value as MCP content. */
export function toMcpToolResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
} {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  // Already MCP-shaped (the common case — a host tool projected from a real
  // MCP server returns its server's own content) — pass it through untouched
  // so nothing is re-encoded or lost.
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as { content: Array<{ type: "text"; text: string }> };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    structuredContent: result,
  };
}
