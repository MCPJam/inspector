/**
 * Cheap, synchronous pre-flight for the Claude Code harness.
 *
 * `runHarnessTurn` already fails closed deep in the stream when a prerequisite
 * is missing, but by then the UI has opened a turn and the error surfaces as a
 * raw mid-stream message. The chat-v2 routes call this BEFORE streaming so a
 * harness-typed host with an unavailable runtime gets one clear, friendly
 * error instead — and we never silently fall back to the emulated engine
 * (that would mislead the user into thinking they observed the real harness).
 *
 * Only the cheap synchronous gates live here (computers data-plane config,
 * approval mode). The MODEL CREDENTIAL is no longer an env var — it's the
 * project org's BYOK Anthropic key resolved from Convex inside the turn, which
 * needs a network call, so it isn't checked here; the turn fails closed with a
 * clear message ("no Anthropic key configured for this project") before it wakes
 * the computer. Other expensive runtime failures (computer provision / wake,
 * E2B connect) likewise stay as the in-engine backstop.
 */
import { isComputersDataPlaneConfigured } from "../computers/control-plane-client.js";

export type HarnessAvailability =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * @param requireToolApproval the host's resolved approval gate — the harness
 *   can't pause for interactive approval yet, so an approval host is rejected.
 */
export function checkHarnessRuntimeAvailable(args: {
  requireToolApproval: boolean;
}): HarnessAvailability {
  if (!isComputersDataPlaneConfigured()) {
    return {
      ok: false,
      reason:
        "the Claude Code harness needs a computer, but the computers data " +
        "plane is not configured (need CONVEX_HTTP_URL, " +
        "COMPUTERS_DATA_PLANE_SECRET, and E2B_API_KEY)",
    };
  }
  if (args.requireToolApproval) {
    return {
      ok: false,
      reason:
        "the Claude Code harness doesn't support interactive tool approval " +
        "yet — turn off requireToolApproval on this host",
    };
  }
  return { ok: true };
}
