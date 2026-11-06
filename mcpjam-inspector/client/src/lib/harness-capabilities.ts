import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { harnessReasoningEfforts } from "@mcpjam/sdk/browser";
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
export const HARNESS_DISPLAY_NAME = {
  "claude-code": HARNESS_DESCRIPTORS["claude-code"].displayName,
  codex: HARNESS_DESCRIPTORS.codex.displayName,
  cursor: HARNESS_DESCRIPTORS.cursor.displayName,
};

/** Behavior-tab controls whose value may not cross into a harness runtime. */
export type HarnessGatedControl =
  | "modelId"
  | "temperature"
  | "reasoningEffort"
  | "requireToolApproval"
  | "respectToolVisibility"
  | "progressiveToolDiscovery";

export type HarnessControlState =
  | { enforced: true }
  | { enforced: false; note: string };

/** "This control reaches the runtime." Exported so a caller that learns the
 *  same thing from the server (see `useHarnessCapabilities`) can return the
 *  identical value rather than constructing a look-alike. */
export const ENFORCED_CONTROL: HarnessControlState = { enforced: true };
const ENFORCED = ENFORCED_CONTROL;

/** Controls owned by the harness's own agent loop — no MCPJam-side mediation
 *  can change these answers, so they are declared per harness. */


// Keyed by harness id. A host with no harness (emulated engine) enforces
// everything — callers pass `undefined` and get ENFORCED for every control.
const HARNESS_LOOP_CONTROL_STATE = {
  "claude-code": HARNESS_DESCRIPTORS["claude-code"].controls,
  codex: HARNESS_DESCRIPTORS.codex.controls,
  cursor: HARNESS_DESCRIPTORS.cursor.controls,
};

/**
 * Whether tool-visibility filtering (SEP-1865 app-only tools) reaches this
 * harness's MCP tools — a question about WHO BUILDS the tool set, answered from
 * the shared delivery declaration rather than restated per harness.
 */
function toolVisibilityState(
  delivery: HarnessMcpDelivery,
): HarnessControlState {
  if (delivery === "mcpjam") return ENFORCED;
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
  if (control === "reasoningEffort") {
    // Derived, not restated: an adapter enforces an effort exactly when the
    // SDK's evidence table lists at least one verified level for it.
    return harnessReasoningEfforts(harness).length > 0
      ? ENFORCED
      : {
          enforced: false,
          note: `${HARNESS_DISPLAY_NAME[harness] ?? "This harness"} doesn't support a reasoning effort yet, so a saved one would be refused.`,
        };
  }
  if (control === "respectToolVisibility") {
    const delivery = harnessMcpDelivery(harness);
    // Same fail-open contract as below: an id with no delivery declaration is
    // not something we can reason about, so don't gray the control out.
    return delivery ? toolVisibilityState(delivery) : ENFORCED;
  }
  return HARNESS_LOOP_CONTROL_STATE[harness]?.[control] ?? ENFORCED;
}
