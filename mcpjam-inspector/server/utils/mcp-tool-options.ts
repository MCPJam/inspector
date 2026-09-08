/**
 * ONE builder for `getToolsForAiSdk`'s host-derived options.
 *
 * `MCPClientManager.getToolsForAiSdk(serverIds?, options = {})` takes six
 * host-derived inputs and, by its own docblock, refuses to resolve any of them
 * itself ("the mode is resolved by the CALLER — this class must not read host
 * configs"). Every execution surface therefore has to build the same object,
 * and until this helper existed four of them built it by hand:
 *
 *   - `chat-v2-orchestration.ts` (the emulated engine)
 *   - `services/evals-runner.ts`
 *   - `routes/shared/evals.ts` (single-case stream)
 *   - `harness/host-executed-mcp-tools.ts` — which built NOTHING, and so
 *     projected a Codex turn's MCP tools under the SDK's defaults rather than
 *     the host's policy. That is the bug this helper exists to make
 *     unrepresentable: a surface that forgets a field now forgets it in one
 *     place, visibly, instead of silently dropping it at its own call site.
 *
 * ## The property that must not be lost
 *
 * When NO host input applies this returns `undefined`, and callers then use the
 * **no-options overload** (`getToolsForAiSdk(ids)`). That is deliberate and
 * load-bearing: a default turn must produce byte-identical tools to what it
 * produced before any of these options existed, and the SDK's `tasks` seam
 * documents the same rule from the other side ("omit and every call takes the
 * pre-existing path, byte-for-byte"). Passing `{}` instead of `undefined` would
 * be *behaviorally* identical today and would quietly invite a future default
 * into the object; returning `undefined` keeps the two paths distinguishable at
 * every call site and in every test assertion.
 *
 * Each field is included only when it is actually asserted:
 *  - `needsApproval` when true (a `false` approval flag is the default);
 *  - `includeAppOnly` when true (the caller resolves `respectToolVisibility
 *    === false` into it — an explicit opt-out of SEP-1865 filtering);
 *  - `modelVisibleMcpToolResults` when defined (a policy object, no default);
 *  - `tasks` when defined (absent === tasks off; see `task-seam.ts`);
 *  - `toolCallCancellation` when defined — INCLUDING the empty record. Unlike
 *    every field above it, absent and empty differ here: the manager reads
 *    `override ?? config?.toolCallCancellation`, so absent falls through to the
 *    connection's connect-time copy while `{}` overrides it with "no era is
 *    suppressed". A caller that resolved a host config says so with `{}`.
 *  - `toolDescriptionOverrides` when defined and non-empty (a description-
 *    experiment rewrite; absent and `{}` are both "no override").
 */
import type { MCPClientManager, ToolTaskSeamOptions } from "@mcpjam/sdk";
import type { ModelVisibleMcpToolResults } from "@mcpjam/sdk/host-config/internal";

/**
 * The manager's own options type, derived from the method rather than
 * re-declared — so a field added to the SDK cannot silently bypass this
 * builder's input surface without a type error here.
 */
export type McpToolOptions = NonNullable<
  Parameters<InstanceType<typeof MCPClientManager>["getToolsForAiSdk"]>[1]
>;

export interface McpToolOptionsInput {
  /** Host's `requireToolApproval`, for surfaces whose engine reads the AI SDK
   *  approval flag. NOT every surface does — see the harness note in
   *  `host-executed-mcp-tools.ts`. */
  needsApproval?: boolean | undefined;
  /**
   * Include SEP-1865 app-only tools in the model-visible set. Callers pass
   * `respectToolVisibility === false` (chat) or their own explicit decision
   * (eval, which wants the full set so a visibility drop can be COUNTED).
   */
  includeAppOnly?: boolean | undefined;
  modelVisibleMcpToolResults?: ModelVisibleMcpToolResults | undefined;
  /** Resolved task seam, or absent for tasks-off. Never re-derived here: the
   *  surface owns its own row in the policy matrix (`task-seam.ts`). */
  tasks?: ToolTaskSeamOptions | undefined;
  /**
   * The host's tool-cancellation setting, resolved for THIS turn.
   *
   * Carried per turn rather than read off the connection: the connection's
   * copy is captured when it connects, so a setting saved mid-session does
   * not reach it until something reconnects — which reads as the toggle
   * doing nothing.
   */
  toolCallCancellation?: { legacy?: boolean; modern?: boolean } | undefined;
  /**
   * Per-tool description rewrites for a description-experiment REWRITE arm.
   * Included only when defined and non-empty — an empty record is the same
   * instruction as absent (no override) and must not take the options
   * overload on its own.
   */
  toolDescriptionOverrides?: Readonly<Record<string, string>> | undefined;
}

/**
 * @returns the options object, or `undefined` when no host input applies — the
 * signal to call `getToolsForAiSdk` with no options at all.
 */
export function mcpToolOptionsFor(
  input: McpToolOptionsInput
): McpToolOptions | undefined {
  const options: McpToolOptions = {};
  if (input.needsApproval) options.needsApproval = true;
  if (input.includeAppOnly) options.includeAppOnly = true;
  if (input.modelVisibleMcpToolResults !== undefined) {
    options.modelVisibleMcpToolResults = input.modelVisibleMcpToolResults;
  }
  if (input.tasks !== undefined) options.tasks = input.tasks;
  if (input.toolCallCancellation !== undefined) {
    options.toolCallCancellation = input.toolCallCancellation;
  }
  if (
    input.toolDescriptionOverrides !== undefined &&
    Object.keys(input.toolDescriptionOverrides).length > 0
  ) {
    options.toolDescriptionOverrides = input.toolDescriptionOverrides;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}
