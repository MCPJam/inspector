/**
 * Where an eval with a local harness client runs for this project, asked
 * before Start: on this machine, in the cloud, or not here with the reason and
 * the one fix (`GET /api/mcp/local-harness/eval-venue`). The server asks the
 * launch's own rule, so the answer is the venue the launch would pick.
 */
import { authFetch } from "@/lib/session-token";
import type { LocalHarnessClientId } from "@/lib/local-harness-consent";

/** What the run sheet offers beside a client that can't run here. */
export type LocalEvalVenueFix = "set-up" | "retry" | "choose-another";

export type LocalEvalVenue =
  | { venue: "local" }
  | { venue: "cloud" }
  | { venue: "refused"; refusal: string; message: string; fix: LocalEvalVenueFix };

export type LocalEvalVenueResult =
  | { ok: true; venue: LocalEvalVenue }
  /**
   * `turnedOff`: this Inspector serves no local-harness routes (its operator
   * switched local clients off), so it can't answer; the launch still decides.
   */
  | { ok: false; turnedOff: boolean };

const FIXES: readonly string[] = ["set-up", "retry", "choose-another"];

function isLocalEvalVenue(body: unknown): body is LocalEvalVenue {
  if (!body || typeof body !== "object") return false;
  const record = body as Record<string, unknown>;
  if (record.venue === "local" || record.venue === "cloud") return true;
  return (
    record.venue === "refused" &&
    typeof record.refusal === "string" &&
    typeof record.message === "string" &&
    typeof record.fix === "string" &&
    FIXES.includes(record.fix)
  );
}

export async function fetchLocalHarnessEvalVenue(
  harnessId: LocalHarnessClientId,
  projectId: string,
  signal?: AbortSignal,
): Promise<LocalEvalVenueResult> {
  const query = `projectId=${encodeURIComponent(projectId)}&harnessId=${encodeURIComponent(harnessId)}`;
  let response: Response;
  try {
    response = await authFetch(`/api/mcp/local-harness/eval-venue?${query}`, { signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, turnedOff: false };
  }
  if (response.status === 404) return { ok: false, turnedOff: true };
  if (!response.ok) return { ok: false, turnedOff: false };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON: the check failed, and the sheet offers Retry.
    return { ok: false, turnedOff: false };
  }
  return isLocalEvalVenue(body) ? { ok: true, venue: body } : { ok: false, turnedOff: false };
}
