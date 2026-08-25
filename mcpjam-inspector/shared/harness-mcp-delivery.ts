/**
 * HOW each harness gets the host's selected MCP servers to the model — the one
 * declaration, shared by the server runtime registry and the client.
 *
 *  - `native`        — the runtime's own MCP client connects from inside the
 *                      sandbox, to config MCPJam writes there (Claude Code's
 *                      `.mcp.json`). MCPJam does not build those tools, so
 *                      nothing MCPJam decides about how a tool is BUILT can
 *                      reach them.
 *  - `host-executed` — MCPJam enumerates each server's tools at turn start and
 *                      runs them in-process, relaying invocations out of the
 *                      sandbox (Codex, COMP-39). These tools come from the SAME
 *                      `getToolsForAiSdk` projection the emulated engine uses,
 *                      so host-level tool-construction knobs apply here exactly
 *                      as they do on the emulated engine.
 *
 * ## Why this lives in `shared/` rather than in the registry
 *
 * The registry (`server/utils/harness/registry.ts`) is server-only — it imports
 * the real `@ai-sdk/harness-*` adapters — so the client cannot read an adapter's
 * `mcpDelivery` from it. But the client's Behavior-tab capability map
 * (`client/src/lib/harness-capabilities.ts`) has to answer "does this knob bite
 * on this harness?", and for every knob that acts at tool-CONSTRUCTION time the
 * honest answer is a function of delivery mode, not of the harness's name.
 *
 * Hand-declaring that answer per harness is exactly the promise that goes stale:
 * it did, the day Codex started reading `respectToolVisibility`. So the delivery
 * mode is declared HERE, once, and both sides derive:
 *
 *  - the registry's adapters set `mcpDelivery: HARNESS_MCP_DELIVERY[<id>]`
 *    (the `as const` keeps the literal type, so the adapter union still
 *    discriminates and `native` still requires `deliverMcpServers`);
 *  - the client capability map keys its construction-time controls off
 *    {@link harnessMcpDelivery}.
 *
 * Changing a harness's delivery mode is therefore a ONE-LINE change that moves
 * the server behavior and the editor's promise about it together.
 */
import { HARNESS_IDS, type Harness } from "@mcpjam/sdk/host-config/internal";

/** The two MCP-delivery arms. Every harness uses one; there is no "no MCP" arm. */
export type HarnessMcpDelivery = "native" | "host-executed";

/**
 * Delivery mode per harness id.
 *
 * `satisfies Record<Harness, HarnessMcpDelivery>` makes a new SDK harness id
 * without an entry a COMPILE error, the same way `HARNESS_ADAPTERS` does — and
 * `as const` preserves each literal so the registry's discriminated union still
 * narrows on it.
 */
export const HARNESS_MCP_DELIVERY = {
  "claude-code": "native",
  codex: "host-executed",
} as const satisfies Record<Harness, HarnessMcpDelivery>;

/** Delivery mode for `harness`. Callers holding a narrower union (the client's
 *  `HostConfigHarnessV2`) index the map directly and keep the literal type. */
export function harnessMcpDelivery(harness: Harness): HarnessMcpDelivery {
  return HARNESS_MCP_DELIVERY[harness];
}

/** Every harness id that has a delivery declaration — the SDK's list, so the
 *  parity test can iterate without re-listing the ids. */
export const HARNESS_MCP_DELIVERY_IDS: readonly Harness[] = HARNESS_IDS;
