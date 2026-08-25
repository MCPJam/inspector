import type { HostConfigHarnessV2 } from "@/lib/client-config-v2";
import {
  harnessMcpDelivery,
  type HarnessMcpDelivery,
} from "@/shared/harness-mcp-delivery";

/**
 * Per-harness capability map — the seed of the harness registry.
 *
 * The host page promises "edit a knob → see it in the runtime." For the
 * EMULATED engine that's automatic because MCPJam *is* the runtime and enforces
 * every host-config knob itself. A real **harness** (e.g. Claude Code) runs its
 * own agent loop, so some knobs only take effect once MCPJam mediates the
 * traffic they act on — and a few never can.
 *
 * This map records, per harness, which Behavior-tab controls are actually
 * enforced. The host editor reads it to gray-out + annotate controls that
 * wouldn't bite, so the page never silently lies.
 *
 * ## Derived where it can be, declared only where it can't
 *
 * The controls split into two kinds, and only one of them is a per-harness fact:
 *
 *  - **Loop-owned** (`temperature`, `requireToolApproval`,
 *    `progressiveToolDiscovery`) — decided by what the harness's own agent loop
 *    can do. Nothing MCPJam builds changes the answer, so these are declared per
 *    harness below.
 *  - **Tool-construction-time** (`respectToolVisibility`) — acts when the MCP
 *    tool set is BUILT, so the answer is a function of the harness's
 *    {@link HarnessMcpDelivery}, not of its name:
 *      - `host-executed` — MCPJam enumerates the servers itself, through the
 *        very same `getToolsForAiSdk` projection the emulated engine uses and
 *        under the same host-derived options, so the knob bites exactly as it
 *        does on the emulated engine (COMP-39);
 *      - `native` — the runtime's own MCP client lists tools from inside the
 *        sandbox, through a proxy that relays `tools/list` unmodified, so
 *        MCPJam never constructs those tools and cannot filter them.
 *    These are DERIVED from `@/shared/harness-mcp-delivery`, the same
 *    declaration the server registry's adapters read.
 *
 * That split is the point. A hardcoded `enforced: true` here is a promise about
 * server behavior that nothing keeps in sync — and it went stale the first time
 * it was tried: `respectToolVisibility` was pinned `false` for Codex, and stayed
 * `false` after the host-executed projection started honoring it, so the editor
 * disabled a switch that worked and explained why with a reason that was no
 * longer true. Deriving from delivery mode means flipping a harness's delivery
 * moves the runtime and the editor's claim about it in one edit.
 */

/** Behavior-tab controls whose value may not cross into a harness runtime. */
export type HarnessGatedControl =
  | "temperature"
  | "requireToolApproval"
  | "respectToolVisibility"
  | "progressiveToolDiscovery";

export type HarnessControlState =
  | { enforced: true }
  | { enforced: false; note: string };

const ENFORCED: HarnessControlState = { enforced: true };

/** Controls owned by the harness's own agent loop — no MCPJam-side mediation
 *  can change these answers, so they are declared per harness. */
type HarnessLoopControl = Exclude<HarnessGatedControl, "respectToolVisibility">;

// Keyed by harness id. A host with no harness (emulated engine) enforces
// everything — callers pass `undefined` and get ENFORCED for every control.
const HARNESS_LOOP_CONTROL_STATE: Record<
  HostConfigHarnessV2,
  Record<HarnessLoopControl, HarnessControlState>
> = {
  "claude-code": {
    // Permanent: the Claude Code CLI exposes no temperature knob.
    temperature: {
      enforced: false,
      note: "Claude Code runs its own loop and ignores temperature.",
    },
    // Claude Code CAN pause — on its own built-ins (`approvalPermissionMode:
    // "allow-edits"`) and on host-executed tools. What it can't cover is its MCP
    // tools: the CLI's own client lists and calls those from inside the sandbox,
    // where MCPJam has nothing to interpose on. Rather than half-honor approval,
    // `checkHarnessRuntimeAvailable` REFUSES a turn on an approval host with any
    // server selected. So the note must not say "ignored" — that is the one
    // outcome that never happens. (This entry stays gated because the state has
    // no server-selection input to distinguish the two cases; see the PR
    // discussion — widening it is a deliberate product change, not a copy fix.)
    requireToolApproval: {
      enforced: false,
      note: "Claude Code can't pause for approval of MCP-server tools, so a turn on this host is refused rather than run unapproved.",
    },
    // The real Claude Code owns its own tool discovery; MCPJam's progressive
    // meta-tools are an emulated-loop mechanism and don't apply to a harness.
    progressiveToolDiscovery: {
      enforced: false,
      note: "Claude Code does its own tool discovery.",
    },
  },
  codex: {
    // Permanent: the Codex CLI exposes no temperature knob to the host.
    temperature: {
      enforced: false,
      note: "Codex runs its own loop and ignores temperature.",
    },
    // Codex can't pause for interactive tool approval on ANY surface (allow-all
    // only) — not its native built-ins, not host-executed tools. The pre-flight
    // refuses the turn outright, so "not enforced" would describe an outcome
    // (run anyway, unapproved) that cannot occur.
    requireToolApproval: {
      enforced: false,
      note: "Codex can't pause for tool approval, so a turn on this host is refused rather than run unapproved.",
    },
    // The real Codex owns its own tool discovery.
    progressiveToolDiscovery: {
      enforced: false,
      note: "Codex does its own tool discovery.",
    },
  },
};

/**
 * Whether tool-visibility filtering (SEP-1865 app-only tools) reaches this
 * harness's MCP tools — a question about WHO BUILDS the tool set, answered from
 * the shared delivery declaration rather than restated per harness.
 */
function toolVisibilityState(
  delivery: HarnessMcpDelivery,
): HarnessControlState {
  if (delivery === "host-executed") return ENFORCED;
  return {
    enforced: false,
    // Stated in terms of the mechanism, so it reads correctly for any future
    // harness that also delivers natively.
    note: "This harness connects to MCP servers itself, so MCPJam can't filter its tool list.",
  };
}

/**
 * Whether `control` is enforced for a host using `harness`. No harness
 * (emulated engine) enforces everything. An unknown/future harness id defaults
 * to enforced — fail-open in the editor so we never gray out a control we can't
 * reason about.
 */
export function harnessControlState(
  harness: HostConfigHarnessV2 | undefined,
  control: HarnessGatedControl,
): HarnessControlState {
  if (!harness) return ENFORCED;
  if (control === "respectToolVisibility") {
    const delivery = harnessMcpDelivery(harness);
    // Same fail-open contract as below: an id with no delivery declaration is
    // not something we can reason about, so don't gray the control out.
    return delivery ? toolVisibilityState(delivery) : ENFORCED;
  }
  return HARNESS_LOOP_CONTROL_STATE[harness]?.[control] ?? ENFORCED;
}
