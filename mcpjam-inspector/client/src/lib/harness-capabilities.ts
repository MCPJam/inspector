import type { HostConfigHarnessV2 } from "@/lib/client-config-v2";

/**
 * Per-harness capability map — the seed of the harness registry.
 *
 * The host page promises "edit a knob → see it in the runtime." For the
 * EMULATED engine that's automatic because MCPJam *is* the runtime and enforces
 * every host-config knob itself. A real **harness** (e.g. Claude Code) runs its
 * own agent loop and connects to MCP servers itself, so some knobs only take
 * effect once the MCP proxy mediates that traffic — and a few never can.
 *
 * This map records, per harness, which Behavior-tab controls are actually
 * enforced. The host editor reads it to gray-out + annotate controls that
 * wouldn't bite, so the page never silently lies. As each proxy phase lands,
 * flip a control's entry to `ENFORCED` (a one-line change) and the editor
 * un-grays it automatically.
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

// Keyed by harness id. A host with no harness (emulated engine) enforces
// everything — callers pass `undefined` and get ENFORCED for every control.
const HARNESS_CONTROL_STATE: Record<
  HostConfigHarnessV2,
  Record<HarnessGatedControl, HarnessControlState>
> = {
  "claude-code": {
    // Permanent: the Claude Code CLI exposes no temperature knob.
    temperature: {
      enforced: false,
      note: "Claude Code runs its own loop and ignores temperature.",
    },
    // Pending the MCP proxy: the harness calls servers directly today, so
    // MCPJam can't gate its tool calls yet (lifts when proxy approval lands).
    requireToolApproval: {
      enforced: false,
      note: "Not enforced for the Claude Code harness yet.",
    },
    // Pending the MCP proxy: visibility filtering happens at the MCP boundary,
    // which MCPJam doesn't yet mediate for the harness.
    respectToolVisibility: {
      enforced: false,
      note: "Not enforced for the Claude Code harness yet.",
    },
    // The real Claude Code owns its own tool discovery; MCPJam's progressive
    // meta-tools don't apply to a harness loop.
    progressiveToolDiscovery: {
      enforced: false,
      note: "Claude Code does its own tool discovery.",
    },
  },
};

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
  return HARNESS_CONTROL_STATE[harness]?.[control] ?? ENFORCED;
}
