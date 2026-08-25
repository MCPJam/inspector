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
 * gets the right gates for free. Only the cheap synchronous checks live here —
 * including the inspector-side BROKER DELIVERY kill switch (an env read), the
 * only credential path since COMP-23. The backend broker/proxy flags (a network
 * call away) stay in-turn fail-closed backstops, as do expensive runtime
 * failures (computer wake, E2B connect).
 */
import { isComputersDataPlaneConfigured } from "../computers/control-plane-client.js";
import { getCanonicalModelId } from "@/shared/types";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import { harnessBrokerDeliveryEnabled } from "./harness-flags.js";
import {
  getHarnessAdapter,
  type HarnessId,
  type HarnessRuntimeAdapter,
} from "./registry.js";

/**
 * The approval half of this pre-flight, as a value both gate sites share.
 *
 * `runHarnessTurn` has to re-assert exactly these rules, because the eval,
 * synthetic and unified paths never call {@link checkHarnessRuntimeAvailable} —
 * and an approval rule that holds on the chat route but not on an eval run is
 * the silent bypass. Two hand-copied conditions would drift on the next
 * capability added, so the conditions live HERE and the turn calls this.
 *
 * Returns the refusal copy, or `undefined` when the combination is sound.
 *
 * Note the MCP arm is gated on the surface the adapter's MCP tools ACTUALLY run
 * on: `native` delivery runs them in-sandbox (`supportsMcpToolApproval`),
 * `host-executed` runs them on MCPJam's server as ordinary host tools
 * (`supportsHostExecutedToolApproval`). Reading the wrong one is the bypass this
 * function exists to make unrepresentable — Codex's MCP tools are host-executed,
 * so `supportsMcpToolApproval` says nothing about them.
 */
export function harnessToolApprovalRefusalReason(args: {
  adapter: HarnessRuntimeAdapter;
  requireToolApproval: boolean;
  /** Whether the host has any selected MCP servers. Selects whether the
   *  MCP-surface arm applies; the native-surface arm applies regardless. */
  hasSelectedMcpServers: boolean;
}): string | undefined {
  if (!args.requireToolApproval) return undefined;
  const name = args.adapter.displayName;
  // The runtime runs its own native tools in-sandbox. If it can't pause on
  // those, approval is unsound for the whole turn — servers or no servers.
  if (!args.adapter.supportsNativeToolApproval) {
    return (
      `the ${name} harness doesn't support interactive tool approval yet — ` +
      "turn off requireToolApproval on this host"
    );
  }
  const mcpToolApproval =
    args.adapter.mcpDelivery === "native"
      ? args.adapter.supportsMcpToolApproval
      : args.adapter.supportsHostExecutedToolApproval;
  if (args.hasSelectedMcpServers && !mcpToolApproval) {
    return (
      `the ${name} harness can't pause for approval of MCP-server tools — ` +
      "turn off requireToolApproval on this host"
    );
  }
  return undefined;
}

/**
 * Why a harness was refused, as a value rather than a sentence.
 *
 * `reason` is the human copy and changes freely with the wording; `kind` is
 * what code branches on. Callers need the distinction: eval admission runs
 * this gate twice — once from the host config alone, before the run's per-case
 * models are known — and has to tell a MODEL refusal (re-decide it later, with
 * the real models) from a host-level one (final either way). Matching that on
 * the message text made a copy edit silently change admission behaviour.
 */
export type HarnessUnavailableKind =
  | "broker-disabled"
  | "enterprise-policy"
  | "computers-unconfigured"
  | "tool-approval"
  | "model-not-hosted"
  | "model-unsupported";

export type HarnessAvailability =
  | { ok: true }
  | { ok: false; kind: HarnessUnavailableKind; reason: string };

export function checkHarnessRuntimeAvailable(args: {
  /** The harness this host runs — selects the capability set. */
  harnessId: HarnessId;
  /** The host's resolved approval gate. The runtimes can't pause for native/MCP
   *  tool approval, so an approval host is rejected (capability-driven). */
  requireToolApproval: boolean;
  /** Whether the host has any selected MCP servers. No longer a refusal on its
   *  own — every harness delivers them — but it still selects which approval
   *  capability has to hold. */
  hasSelectedMcpServers: boolean;
  /**
   * The host's RESOLVED model — id plus provider, exactly as the turn resolved
   * it (`ModelDefinition`).
   *
   * Both model rules are derived HERE, from this one input, rather than taken
   * as pre-computed booleans. That is deliberate and was learned twice: with
   * `modelEligible` and a canonical `modelId` as separate parameters, every
   * call site had to independently remember to pass the provider to
   * `isHostedCatalogModel` AND to canonicalize before `supportsModel` — and a
   * caller that forgot either one failed in a DIFFERENT direction (omit the
   * provider and a bare hosted id like `gpt-5-nano` reads as non-hosted and is
   * wrongly refused; skip eligibility entirely and a BYOK model is wrongly
   * admitted and then silently runs emulated). Deriving both from the resolved
   * definition makes the two answers consistent by construction.
   */
  model: { id: string; provider?: string };
  /**
   * Whether the host's enterprise-managed authorization policy is on. The
   * harness reaches MCP servers through the signed-proxy route
   * (`routes/web/harness-mcp.ts`), whose Convex-minted token carries only
   * `{projectId, serverId}` — no host — so that route CANNOT resolve or
   * enforce the policy, and an unregistered `auto` server would silently
   * take the discover/OAuth path instead of failing closed. Rather than let
   * a harness turn bypass enforcement, reject the combination here. Lifting
   * this requires threading the policy through the harness proxy token
   * claims (a hand-mirrored Convex↔inspector contract — separate PR).
   */
  xaaEnterprisePolicyOn?: boolean;
}): HarnessAvailability {
  const adapter = getHarnessAdapter(args.harnessId);
  const name = adapter.displayName;

  // Broker delivery is the ONLY credential path (COMP-23) — with the kill
  // switch off, no harness turn can obtain model access, so fail here with one
  // clear pre-stream error instead of a raw mid-turn throw.
  if (!harnessBrokerDeliveryEnabled()) {
    return {
      ok: false,
      kind: "broker-disabled",
      reason:
        `the ${name} harness delivers model credentials via the broker, ` +
        "and broker delivery is disabled on this server " +
        "(MCPJAM_HARNESS_BROKER_DELIVERY=false) — re-enable it to run " +
        "harness turns",
    };
  }

  if (args.xaaEnterprisePolicyOn) {
    return {
      ok: false,
      kind: "enterprise-policy",
      reason:
        `the ${name} harness can't run on an enterprise-managed host yet — ` +
        "the harness reaches MCP servers through a signed proxy that can't " +
        "carry the host's authorization policy, so a turn could bypass it. " +
        "Turn off enterprise-managed authorization on this host, or use the " +
        "emulated engine",
    };
  }

  if (adapter.requiresComputer && !isComputersDataPlaneConfigured()) {
    return {
      ok: false,
      kind: "computers-unconfigured",
      reason:
        `the ${name} harness needs a computer, but this server is not a ` +
        "computers data plane (deployed servers bootstrap credentials from " +
        "INSPECTOR_SERVICE_TOKEN; see docs/project-computers.md)",
    };
  }

  // Approval is gated against the surfaces the host actually uses, by the same
  // helper `runHarnessTurn`'s backstop calls — so the pre-flight and the turn
  // can never disagree about which combinations are sound.
  const approvalRefusal = harnessToolApprovalRefusalReason({
    adapter,
    requireToolApproval: args.requireToolApproval,
    hasSelectedMcpServers: args.hasSelectedMcpServers,
  });
  if (approvalRefusal) {
    return { ok: false, kind: "tool-approval", reason: approvalRefusal };
  }

  // There is no MCP gate. Every adapter delivers the host's selected servers
  // one way or the other (`HarnessMcpDelivery`: `native` config in the sandbox,
  // or `host-executed` tools MCPJam runs itself), so "this harness can't do MCP
  // at all" is no longer a representable state — the refusal it produced (kind
  // `mcp-servers`, which blocked every Codex host with a server attached, and
  // therefore every Codex eval) is gone with it.

  // Model eligibility: harness runtimes authenticate via the MCPJam gateway
  // credential, not org BYOK. A non-eligible model can't run the real runtime,
  // so fail closed here rather than degrade to emulated and mislead the user.
  // Derived, not passed: `isHostedCatalogModel` canonicalizes internally but
  // needs the PROVIDER to do it, and `supportsModel` needs the canonical form.
  // One resolution, used for both.
  const canonicalModelId = getCanonicalModelId(
    args.model.id,
    args.model.provider
  );
  if (!isHostedCatalogModel(args.model.id, args.model.provider)) {
    return {
      ok: false,
      kind: "model-not-hosted",
      reason:
        `the ${name} harness only runs MCPJam-provided models — pick one on ` +
        "this host to run the real runtime",
    };
  }

  // Runtime model support: even an MCPJam-provided model may not be one this
  // runtime can run (e.g. a non-gpt-5 model on Codex). Reject it rather than let
  // the runtime silently substitute its own default model.
  if (!adapter.supportsModel(canonicalModelId)) {
    return {
      ok: false,
      kind: "model-unsupported",
      reason:
        `the ${name} harness can't run this host's model — pick a ` +
        `${name}-compatible model to run the real runtime`,
    };
  }

  return { ok: true };
}
