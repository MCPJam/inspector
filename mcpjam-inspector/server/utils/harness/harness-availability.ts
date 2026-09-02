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
import { isRuntimeChosenModelSentinel } from "@/shared/model-provider";
import { isHostedCatalogModel } from "../../services/hosted-model-catalog.js";
import { harnessBrokerDeliveryEnabled } from "./harness-flags.js";
import {
  getHarnessAdapter,
  type HarnessId,
  type HarnessRuntimeAdapter,
} from "./registry.js";

/**
 * Is this harness+model combination eligible to run on the REAL runtime?
 *
 * The one answer the DISPATCH sites must share — `assistant-turn`'s `useHarness`
 * and `web-chat-turn`'s MCPJam-free branch. They had it hand-written, and the
 * copies stopped being equivalent the moment a harness ran a model MCPJam does
 * not host: the preflight would approve a Cursor turn while the dispatch beside
 * it silently ran the EMULATED engine, so the product would report "Cursor CLI"
 * over a turn Cursor never touched. That is the worst failure this feature can
 * have — not an error, a wrong answer attributed to the wrong runtime — so the
 * decision lives here once.
 *
 * `checkHarnessRuntimeAvailable` below still spells the same two conditions out
 * separately, because it has to report WHICH one failed as a typed refusal
 * kind. A test asserts the two agree for every registered adapter.
 *
 * Two independent conditions, and an external-account harness is exempt from
 * BOTH because neither is about it:
 *
 *  - "MCPJam provides this model" — for a brokered harness the credential is
 *    MCPJam's, so a model MCPJam does not host cannot be paid for. An
 *    external-account harness pays on the customer's own account, and its host
 *    carries a sentinel (`cursor/auto`) that is deliberately NOT hosted.
 *  - "the runtime can run this model" — guards the silent substitution where a
 *    runtime falls back to its own default. An external-account adapter passes
 *    NO model at all, so there is nothing to substitute and nothing to check.
 *
 * What replaces them is ONE condition of its own, {@link
 * externalAccountHostModelRefusalReason}: the host's model must BE the
 * sentinel. An external-account host carrying an ordinary id is not a leniency
 * case, it is the same wrong answer from the other direction — the runtime
 * ignores the id and picks its own model while the session, the trace and the
 * eval metadata all record the id as the model that ran.
 *
 * A `false` here means DIFFERENT things for the two arms, and callers have to
 * honour the difference. For a brokered harness it means "the emulated engine
 * can run this instead" — a real fallback, since that engine honours org BYOK.
 * For an external-account harness there is NO such fallback: the emulated
 * engine cannot run a sentinel at all, and running the host's ordinary id under
 * the runtime's name is precisely the mis-attribution this rule exists to stop.
 * `assistant-turn` therefore THROWS on this arm instead of degrading; see the
 * note at its dispatch.
 */
export function harnessModelEligibleForRuntime(args: {
  adapter: HarnessRuntimeAdapter;
  /** The host's model id as configured (bare or provider-prefixed). */
  modelId: string;
  /** REQUIRED for a bare id to canonicalize; see the note on the preflight. */
  provider?: string;
}): boolean {
  if (args.adapter.modelAccess === "external-account") {
    return (
      externalAccountHostModelRefusalReason({
        adapter: args.adapter,
        modelId: args.modelId,
      }) === undefined
    );
  }
  if (!isHostedCatalogModel(args.modelId, args.provider)) return false;
  return args.adapter.supportsModel(
    getCanonicalModelId(args.modelId, args.provider),
  );
}

/**
 * The model rule that applies to an EXTERNAL-ACCOUNT harness, as a value the
 * pre-flight and the dispatch both read — returns the refusal copy, or
 * `undefined` when the combination is sound.
 *
 * The rule: the model must be the runtime's own sentinel. Cursor's adapter
 * passes NO model (`toNativeModel: () => undefined`) and Cursor Auto picks one
 * on the customer's account, so a host carrying `anthropic/claude-sonnet-4.5`
 * would run Cursor Auto while the session row, the trace and the eval metadata
 * all named Sonnet as the model that ran. Refused rather than silently
 * rewritten: the host configuration is wrong and only its owner can say what
 * they meant by it.
 *
 * WHICH id to pass is the whole subtlety, and it is a HOST question, not a turn
 * question — see `hostModelId` on the pre-flight. Nothing consumes the turn's
 * model on this arm, so validating the model a REQUEST supplied lets a caller
 * satisfy the rule by sending the sentinel in the body while the host itself
 * carries an ordinary id.
 *
 * Shared rather than spelled out twice because the two readers act on it
 * differently — one returns a typed refusal, the other throws — and two copies
 * of a condition drift. Same reasoning as
 * {@link harnessToolApprovalRefusalReason} below.
 */
export function externalAccountHostModelRefusalReason(args: {
  adapter: HarnessRuntimeAdapter;
  /** The model id to hold to the rule. See the note above on which one. */
  modelId: string;
}): string | undefined {
  if (args.adapter.modelAccess !== "external-account") return undefined;
  if (isRuntimeChosenModelSentinel(args.modelId)) return undefined;
  return (
    `the ${args.adapter.displayName} harness chooses its own model on your ` +
    `own account, so this host cannot pin one — it carries ` +
    `"${args.modelId}", which the runtime would ignore while the session ` +
    `recorded it as the model that ran. Reset this host's model, or pick a ` +
    "harness that runs the model you chose"
  );
}

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
   * The host's CONFIGURED model id, before any body or per-case override.
   *
   * Read ONLY by the external-account rule, because that rule asks a question
   * about the HOST rather than about the turn: does this host carry the
   * runtime's sentinel? Every other rule here is about the model that will
   * actually run, which is what `model` above is.
   *
   * The distinction is load-bearing on the interactive rails, where a request
   * body supplies its own model. Holding the external-account rule to `model`
   * let a caller satisfy it by POSTing `cursor/auto` while the host itself
   * carried an ordinary id — the mis-configured host the rule exists to refuse,
   * entered from the other side.
   *
   * ABSENT ⇒ the host pinned no model and `model.id` is held to the rule
   * instead. That is the honest fallback, not a bypass: with nothing pinned,
   * the turn's own model is the only thing this host can be said to run, so a
   * sentinel body is a true description and an ordinary one is still refused.
   */
  hostModelId?: string;
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

  // Does MCPJam supply this runtime's model credential, or does the runtime
  // authenticate on the CUSTOMER's own provider account? Three checks below
  // apply only to the former, and each would be actively wrong for the latter
  // (see `HarnessModelAccess`): the broker kill switch, "MCPJam-provided models
  // only", and per-runtime model support.
  const brokered = adapter.modelAccess !== "external-account";

  // Broker delivery is the ONLY credential path for a BROKERED harness
  // (COMP-23) — with the kill switch off, no such turn can obtain model access,
  // so fail here with one clear pre-stream error instead of a raw mid-turn
  // throw. An external-account harness has no broker to disable: refusing it
  // for this would be switching off a path it never uses.
  if (brokered && !harnessBrokerDeliveryEnabled()) {
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
  //
  // BOTH are skipped for an external-account harness, and not as a leniency:
  // the model MCPJam knows about is not the model that runs. Cursor's adapter
  // passes no model at all and Cursor Auto picks one on the customer's own
  // account, so "is this an MCPJam-hosted model?" and "can the runtime run it?"
  // are questions about a value nothing consumes. Answering them would refuse
  // every Cursor host — its own catalog model is the `cursor/auto` sentinel,
  // which is deliberately not an MCPJam-hosted model. They are replaced by one
  // rule of their own, immediately below, rather than by nothing.
  const canonicalModelId = getCanonicalModelId(
    args.model.id,
    args.model.provider,
  );

  // …and here is that replacement for an external-account host: its model must
  // be the runtime's own sentinel. Same principle as the two rules below —
  // "never report one runtime's answer under another model's name" — applied to
  // the arm where the runtime, not MCPJam, does the choosing. The condition
  // itself lives in `externalAccountHostModelRefusalReason` because the
  // DISPATCH has to reach the identical verdict, and act on it differently.
  //
  // Held to the HOST's configured id, falling back to the turn's model only
  // when the host pinned none: nothing consumes the turn's model on this arm,
  // so validating it would let a request satisfy the rule by sending
  // `cursor/auto` in the body while the host carried an ordinary id.
  const externalAccountRefusal = externalAccountHostModelRefusalReason({
    adapter,
    modelId: args.hostModelId ?? args.model.id,
  });
  if (externalAccountRefusal) {
    return {
      ok: false,
      kind: "model-unsupported",
      reason: externalAccountRefusal,
    };
  }

  if (brokered && !isHostedCatalogModel(args.model.id, args.model.provider)) {
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
  if (brokered && !adapter.supportsModel(canonicalModelId)) {
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
