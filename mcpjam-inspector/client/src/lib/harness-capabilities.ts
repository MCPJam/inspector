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

/**
 * Human-facing runtime name per harness — the client's copy of the server
 * registry's `displayName`.
 *
 * Keyed by `HostConfigHarnessV2`, so adding a harness without naming it is a
 * COMPILE error. That is the point: the copy this feeds used to hardcode
 * "Claude Code", which was already wrong for a Codex host and would have been
 * wrong for two harnesses out of three.
 */
export const HARNESS_DISPLAY_NAME: Record<HostConfigHarnessV2, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  // "Cursor CLI", not "Cursor": the emulated `cursor` host style is the IDE's
  // chat panel, and a user reading this needs to know which one they attached.
  cursor: "Cursor CLI",
};

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
    // Claude Code pauses on all three surfaces: its own built-ins, its
    // host-executed tools, and — under `approvalPermissionMode: "allow-reads"`
    // — the MCP tools its in-sandbox client calls. The interposition point is
    // the adapter bridge's `canUseTool`, which every tool call passes through
    // before the CLI may run it; MCP tool names fall into its "edit" default,
    // which "allow-reads" gates. This entry previously read `enforced: false`
    // on the belief that MCP tools were unreachable, and a turn on an approval
    // host with any server selected was REFUSED outright. It isn't anymore.
    requireToolApproval: ENFORCED,
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
  cursor: {
    // Permanent for a different reason than the other two: Cursor's CLI takes
    // no temperature AND no model — it runs on the customer's Cursor account,
    // which picks the model itself (Cursor Auto). There is nothing on this host
    // for the value to reach.
    temperature: {
      enforced: false,
      note: "The Cursor CLI runs on your Cursor account and ignores temperature.",
    },
    // The ACP bridge pauses on its own built-ins: every tool call goes through
    // `session/request_permission`, and under the adapter's "allow-reads" mode
    // anything outside read/search/think/fetch emits a `tool-approval-request`
    // the turn waits on. Verified against a live cursor-agent.
    //
    // ENFORCED describes the NATIVE surface, which is what this control means
    // here. Whether Cursor also pauses on MCP-server tools is not yet measured
    // — the adapter's `supportsMcpToolApproval` is `false` pending that check,
    // so a host that requires approval AND selects servers is refused outright
    // rather than run with some calls unapproved. Refused, never silently
    // un-enforced.
    requireToolApproval: ENFORCED,
    // The real Cursor CLI owns its own tool discovery, same as the other two.
    progressiveToolDiscovery: {
      enforced: false,
      note: "The Cursor CLI does its own tool discovery.",
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
