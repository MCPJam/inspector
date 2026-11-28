/**
 * Where an eval with a local harness client runs for this project, asked
 * before Start: on this machine, in the cloud, or not here with the reason and
 * the one fix (`GET /api/mcp/local-harness/eval-venue`). The server asks the
 * launch's own rule, so the answer is the venue the launch would pick.
 */
import { authFetch } from "@/lib/session-token";
import type { LocalHarnessClientId } from "@/lib/local-harness-consent";
import {
  LOCAL_EVAL_VENUE_FIXES,
  type LocalEvalVenue,
} from "@/shared/local-eval-venue";

/** A check that hangs keeps Start off, so it gives up and offers Retry. */
const CHECK_TIMEOUT_MS = 10_000;

export type LocalEvalVenueResult =
  | { ok: true; venue: LocalEvalVenue }
  /**
   * `turnedOff`: this Inspector serves no local-harness routes (its operator
   * switched local clients off), so it can't answer; the launch still decides.
   * `status`: the response's, when there was one.
   */
  | { ok: false; turnedOff: boolean; status?: number };

const FIXES: readonly string[] = LOCAL_EVAL_VENUE_FIXES;

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

async function readVenue(query: string, signal: AbortSignal): Promise<LocalEvalVenueResult> {
  const response = await authFetch(`/api/mcp/local-harness/eval-venue?${query}`, { signal });
  if (response.status === 404) return { ok: false, turnedOff: true, status: 404 };
  if (!response.ok) return { ok: false, turnedOff: false, status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    // Not JSON: the check failed, and the sheet offers Retry.
    return { ok: false, turnedOff: false, status: response.status };
  }
  return isLocalEvalVenue(body) ? { ok: true, venue: body } : { ok: false, turnedOff: false, status: response.status };
}

export async function fetchLocalHarnessEvalVenue(
  harnessId: LocalHarnessClientId,
  projectId: string,
  signal?: AbortSignal,
): Promise<LocalEvalVenueResult> {
  const query = `projectId=${encodeURIComponent(projectId)}&harnessId=${encodeURIComponent(harnessId)}`;
  const request = new AbortController();
  const timer = setTimeout(() => request.abort(), CHECK_TIMEOUT_MS);
  const forward = () => request.abort();
  signal?.addEventListener("abort", forward, { once: true });
  // The limit covers reading the body too: a server can send its headers and stall.
  try {
    return await readVenue(query, request.signal);
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, turnedOff: false };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", forward);
  }
}
