/**
 * Cheap, synchronous pre-flight for a harness-typed host (Claude Code | Codex).
 *
 * `runHarnessTurn` already fails closed deep in the stream when a prerequisite
 * is missing, but by then the UI has opened a turn and the error surfaces as a
 * raw mid-stream message. The chat-v2 routes call this BEFORE streaming so a
 * harness-typed host with an unavailable runtime gets one clear, friendly error
 * instead — and we never silently fall back to the emulated engine (that would
 * mislead the user into thinking they observed the real harness).
 *
 * Rules are driven by the adapter's declared CAPABILITIES (requiresComputer,
 * approval surfaces, MCP support), not hardcoded per-harness — so a new harness
 * gets the right gates for free. Only the cheap synchronous checks live here;
 * the MODEL CREDENTIAL (a Convex network call) stays an in-turn fail-closed
 * backstop, as do expensive runtime failures (computer wake, E2B connect).
 */
import { isComputersDataPlaneConfigured } from "../computers/control-plane-client.js";
import { getHarnessAdapter, type HarnessId } from "./registry.js";

export type HarnessAvailability =
  | { ok: true }
  | { ok: false; reason: string };

export function checkHarnessRuntimeAvailable(args: {
  /** The harness this host runs — selects the capability set. */
  harnessId: HarnessId;
  /** The host's resolved approval gate. The runtimes can't pause for native/MCP
   *  tool approval, so an approval host is rejected (capability-driven). */
  requireToolApproval: boolean;
  /** Whether the host has any selected MCP servers. Rejected for a harness that
   *  can't deliver them (Codex v1). */
  hasSelectedMcpServers: boolean;
  /** Whether the host's model is MCPJam-provided (harness-eligible). The
   *  interactive path fails closed here rather than silently degrading to the
   *  emulated engine. */
  modelEligible: boolean;
  /** The host's model id — checked against the adapter's `supportsModel` so a
   *  model the runtime can't actually run (e.g. a non-gpt-5 model on Codex) is
   *  rejected instead of silently falling back to the runtime's default. */
  modelId: string;
}): HarnessAvailability {
  const adapter = getHarnessAdapter(args.harnessId);
  const name = adapter.displayName;

  if (adapter.requiresComputer && !isComputersDataPlaneConfigured()) {
    return {
      ok: false,
      reason:
        `the ${name} harness needs a computer, but the computers data plane ` +
        "is not configured (need CONVEX_HTTP_URL, COMPUTERS_DATA_PLANE_SECRET, " +
        "and E2B_API_KEY)",
    };
  }

  // Approval is gated against the surfaces the host actually uses. The runtime
  // runs its native tools (and any MCP tools) itself in-sandbox, so it can't
  // pause for approval on them. Both adapters set these false for v1.
  if (args.requireToolApproval && !adapter.supportsNativeToolApproval) {
    return {
      ok: false,
      reason:
        `the ${name} harness doesn't support interactive tool approval yet — ` +
        "turn off requireToolApproval on this host",
    };
  }
  if (
    args.requireToolApproval &&
    args.hasSelectedMcpServers &&
    !adapter.supportsMcpToolApproval
  ) {
    return {
      ok: false,
      reason:
        `the ${name} harness can't pause for approval of MCP-server tools — ` +
        "turn off requireToolApproval on this host",
    };
  }

  // MCP gate: a harness that can't deliver the host's selected servers (Codex
  // v1) must not silently run without them.
  if (args.hasSelectedMcpServers && !adapter.supportsSelectedMcpServers) {
    return {
      ok: false,
      reason:
        `the ${name} harness doesn't support MCP servers yet — remove the ` +
        "selected servers from this host to run it",
    };
  }

  // Model eligibility: harness runtimes authenticate via the MCPJam gateway
  // credential, not org BYOK. A non-eligible model can't run the real runtime,
  // so fail closed here rather than degrade to emulated and mislead the user.
  if (!args.modelEligible) {
    return {
      ok: false,
      reason:
        `the ${name} harness only runs MCPJam-provided models — pick one on ` +
        "this host to run the real runtime",
    };
  }

  // Runtime model support: even an MCPJam-provided model may not be one this
  // runtime can run (e.g. a non-gpt-5 model on Codex). Reject it rather than let
  // the runtime silently substitute its own default model.
  if (!adapter.supportsModel(args.modelId)) {
    return {
      ok: false,
      reason:
        `the ${name} harness can't run this host's model — pick a ` +
        `${name}-compatible model to run the real runtime`,
    };
  }

  return { ok: true };
}
