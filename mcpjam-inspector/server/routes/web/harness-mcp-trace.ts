/** A short, value-free description of a proxied JSON-RPC reply, for the bench trace. */
export function describeReplyForTrace(reply: unknown): string {
  if (typeof reply !== "object" || reply === null) return typeof reply;
  const { result, error } = reply as { result?: unknown; error?: { code?: unknown } };
  if (error) return `error:${String(error.code ?? "?")}`;
  if (typeof result !== "object" || result === null) return "result:empty";
  const fields = Object.keys(result).sort();
  const meta = (result as { _meta?: Record<string, unknown> })._meta;
  const counts = fields
    .filter((key) => Array.isArray((result as Record<string, unknown>)[key]))
    .map((key) => `${key}#${((result as Record<string, unknown[]>)[key]).length}`);
  return [
    `result:${fields.join("+")}`,
    ...counts,
    meta ? `meta:${Object.keys(meta).map((key) => key.replace("io.modelcontextprotocol/", "")).join("+")}` : "meta:none",
  ].join(",");
}
