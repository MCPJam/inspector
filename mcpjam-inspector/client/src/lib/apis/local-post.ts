import { authFetch } from "@/lib/session-token";

/**
 * POST JSON to a local-Inspector (`!HOSTED_MODE`) route, returning the parsed
 * body and throwing the server's `error` message on a non-ok response. Shared
 * by the local-only API wrappers (conformance, widget-render, …) so the
 * fetch/error contract stays in one place.
 */
export async function localPost<T>(path: string, body: unknown): Promise<T> {
  const response = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data as T;
}
