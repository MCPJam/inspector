import { SUPPORTED_LOCAL_HARNESS_IDS, type SupportedLocalHarnessId } from "../../utils/harness/local/targets.js";

/**
 * Which local harness a request is about. Each one has its own pack, runtime,
 * rollout, authorization and grants (D3–D5), so every route takes the id —
 * from the JSON body for a POST, the query for a GET. Absent means Claude
 * Code, which is what every route meant before there was a second harness; an
 * id this build has no local runtime for is refused rather than defaulted.
 */
function harnessIdOf(value: unknown): SupportedLocalHarnessId | null {
  if (value === undefined || value === null || value === "") return "claude-code";
  return typeof value === "string" &&
    (SUPPORTED_LOCAL_HARNESS_IDS as readonly string[]).includes(value)
    ? (value as SupportedLocalHarnessId)
    : null;
}

/**
 * The ONE answer to "which harness" for a request, read by the rollout gate
 * and by every handler alike. A POST names it in the JSON body only (a query
 * parameter on a POST is ignored), a GET in the query only: were the gate and
 * a handler to read different places, `?harnessId=claude-code` with a Codex
 * body would pass Claude Code's rollout and then install or authorize Codex.
 * Hono caches the parsed body, so the handler's own read sees the same one.
 */
export async function requestHarnessId(c: {
  req: { method: string; query(name: string): string | undefined; json(): Promise<unknown> };
}): Promise<SupportedLocalHarnessId | null> {
  if (c.req.method === "POST") {
    const body = (await c.req.json().catch(() => null)) as { harnessId?: unknown } | null;
    return harnessIdOf(body?.harnessId);
  }
  return harnessIdOf(c.req.query("harnessId"));
}

