import { extractNodeErrno } from "../error-describer/node-errno.js";
import { unwrapEraNegotiationCause } from "./errors.js";

function httpStatus(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = current as Record<string, unknown>;
    for (const field of ["statusCode", "status", "code"]) {
      const value = record[field];
      if (typeof value === "number" && value >= 100 && value <= 599) {
        return value;
      }
    }
    const unwrapped = unwrapEraNegotiationCause(current);
    current = unwrapped !== current ? unwrapped : record.cause;
  }
  return undefined;
}

/** Called after auth and protocol-pin handling, before serializing to the UI. */
export function connectionErrorMessage(
  url: URL,
  errors: unknown[],
  fallback: string,
): string {
  // Show the endpoint without exposing credentials, query values or fragments.
  const endpoint = `${url.origin}${url.pathname}`;
  const statuses = errors.map(httpStatus).filter((s) => s !== undefined);
  // A fallback's 404 must not hide a different HTTP failure on the first try.
  if (statuses.length > 0 && statuses.every((status) => status === 404)) {
    return `Server returned HTTP 404 at ${endpoint}. Check the MCP endpoint and server logs.`;
  }
  if (
    statuses.length === 0 &&
    errors.some(
      (error) =>
        extractNodeErrno(unwrapEraNegotiationCause(error)) === "ECONNREFUSED",
    )
  ) {
    return `Couldn't reach the server at ${endpoint}: connection refused (ECONNREFUSED). Check that it's running and that the host and port are correct.`;
  }
  return fallback;
}
