/**
 * Identifies abort-style errors uniformly across the stream handler, tool
 * execution, and backend fetches. Covers both the WHATWG `AbortError` name
 * (fetch / streams) and Node's `ABORT_ERR` code (some MCP transports).
 *
 * FOLLOWS `cause`, because a body read cut short by the request's own signal
 * does not always surface as the abort itself. `undici` raises the
 * `DOMException` for the request, but a stream torn down mid-read can arrive as
 * `TypeError: terminated` with the abort on `cause` — and a caller that checked
 * only the top level would report a timeout as whatever status the headers
 * happened to carry. The walk is depth-capped and self-reference-guarded, since
 * a `cause` chain is caller-supplied and can be cyclic.
 */
export function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) return false;
    if (current.name === "AbortError") return true;
    const code = (current as { code?: unknown }).code;
    if (code === "ABORT_ERR") return true;
    const cause: unknown = (current as { cause?: unknown }).cause;
    if (cause === undefined || cause === current) return false;
    current = cause;
  }
  return false;
}
