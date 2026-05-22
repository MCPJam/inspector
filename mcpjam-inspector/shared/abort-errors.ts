/**
 * Identifies abort-style errors uniformly across the stream handler, tool
 * execution, and backend fetches. Covers both the WHATWG `AbortError` name
 * (fetch / streams) and Node's `ABORT_ERR` code (some MCP transports).
 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  const code = (error as { code?: unknown }).code;
  return code === "ABORT_ERR";
}
